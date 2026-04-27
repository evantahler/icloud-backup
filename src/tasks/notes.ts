import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { type NoteMeta, Notes } from "macos-ts";
import { EventQueue, runPool } from "../concurrency.ts";
import { archiveOverwrite, atomicCopy, atomicWrite, fileExists } from "../copier.ts";
import { sanitizeFilename } from "../fsutil.ts";
import { Manifest } from "../manifest.ts";
import type { ProgressEvent } from "../tui.ts";

export interface NotesCfg {
  dest: string;
  concurrency: number;
  snapshot?: boolean;
}

export async function* runNotes({
  dest,
  concurrency,
  snapshot = true,
}: NotesCfg): AsyncIterable<ProgressEvent> {
  const root = `${dest}/notes`;
  const mf = await Manifest.open("notes");
  const db = new Notes();

  try {
    yield { type: "phase", label: "scanning Notes" };
    const all = db.notes({ sortBy: "modifiedAt", order: "asc" });
    yield { type: "total", files: all.length };

    const queue = new EventQueue<ProgressEvent>();
    let completed = 0;
    let filesTransferred = 0;
    let bytesTransferred = 0;

    const processOne = async (note: NoteMeta): Promise<void> => {
      const idStr = `${note.id}`;
      const display = `${note.folderName}/${note.title || "(untitled)"}`;
      let bytesDelta = 0;

      try {
        if (note.isPasswordProtected) {
          queue.push({
            type: "log",
            level: "warn",
            message: `password-protected, skipped: ${display}`,
          });
          return;
        }

        // Fetch attachments before dedup so the source_key reflects attachment
        // state — otherwise a prior run that silently dropped attachments
        // (e.g. a stale macos-ts) would leave the manifest looking complete.
        const attachments = db.listAttachments(note.id);
        const sourceKey = `${note.modifiedAt.getTime()}|${attachments.length}`;
        const existing = mf.get(idStr);
        const fname = `${sanitizeFilename(note.title || "untitled")}-${note.id}.md`;
        const out = join(
          root,
          sanitizeFilename(note.accountName),
          sanitizeFilename(note.folderName),
          fname,
        );
        const attachmentsDir = `${out}.attachments`;

        if (
          existing &&
          existing.source_key === sourceKey &&
          (await fileExists(existing.dest_path)) &&
          (attachments.length === 0 || (await fileExists(`${existing.dest_path}.attachments`)))
        ) {
          return;
        }

        const version = (existing?.version ?? 0) + 1;
        if (existing) {
          await archiveOverwrite(existing.dest_path, existing.version, root);
          const oldAttachments = `${existing.dest_path}.attachments`;
          if (await fileExists(oldAttachments)) {
            await archiveOverwrite(oldAttachments, existing.version, root);
          }
        }

        let attachmentBytes = 0;
        let attachmentFiles = 0;
        // identifier → relative path (from the .md) of the copied attachment.
        // Populated as we copy; consumed by attachmentLinkBuilder when rendering.
        const linkMap = new Map<string, string>();
        const attachmentsDirName = basename(attachmentsDir);

        for (const a of attachments) {
          if (!a.url) {
            const detail = db.resolveAttachment(a.identifier || a.name);
            const reason = "error" in detail ? detail.error : "unknown";
            queue.push({
              type: "log",
              level: "warn",
              message: `attachment unresolved (${reason}): ${display}/${a.name || `(no name, id=${a.id})`} (identifier=${a.identifier || "(empty)"}, type=${a.contentType})`,
            });
            continue;
          }
          // Strip the file:// scheme that macos-ts always returns.
          const src = a.url.startsWith("file://") ? a.url.slice("file://".length) : a.url;
          if (!(await fileExists(src))) {
            queue.push({
              type: "log",
              level: "warn",
              message: `attachment source missing: ${display}/${a.name}: ${src}`,
            });
            continue;
          }
          const safeName = sanitizeFilename(a.name || `attachment-${a.id}`);
          const aOut = join(attachmentsDir, safeName);
          try {
            attachmentBytes += await atomicCopy(src, aOut);
            attachmentFiles++;
            if (a.identifier) linkMap.set(a.identifier, `./${attachmentsDirName}/${safeName}`);
          } catch (err) {
            queue.push({
              type: "log",
              level: "warn",
              message: `attachment copy failed: ${display}/${a.name}: ${(err as Error).message}`,
            });
          }
        }
        if (attachments.length === 0 && (await fileExists(attachmentsDir))) {
          await rm(attachmentsDir, { recursive: true, force: true });
        }

        let content: string;
        try {
          content = db.read(note.id, {
            attachmentLinkBuilder: (info) =>
              linkMap.get(info.identifier) ??
              `attachment:${info.identifier}?type=${info.contentType}`,
          }).markdown;
        } catch (err) {
          queue.push({
            type: "log",
            level: "warn",
            message: `read failed: ${display} (${(err as Error).message})`,
          });
          return;
        }

        const mdBytes = await atomicWrite(out, content);

        mf.upsert({
          source_id: idStr,
          dest_path: out,
          source_key: sourceKey,
          size_bytes: mdBytes,
          backed_up_at: Date.now(),
          version,
        });

        bytesDelta = mdBytes + attachmentBytes;
        filesTransferred += 1 + attachmentFiles;
        bytesTransferred += bytesDelta;
      } catch (err) {
        queue.push({
          type: "log",
          level: "warn",
          message: `${display}: ${(err as Error).message}`,
        });
      } finally {
        completed++;
        queue.push({ type: "file", name: display, bytesDelta, index: completed });
      }
    };

    const poolDone = runPool(all, concurrency, processOne).finally(() => queue.close());

    for await (const ev of queue) yield ev;
    await poolDone;

    if (snapshot) await mf.snapshot("notes", dest);
    yield { type: "done", filesTransferred, bytesTransferred };
  } finally {
    mf.close();
    db.close();
  }
}
