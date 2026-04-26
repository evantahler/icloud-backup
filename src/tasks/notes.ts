import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type NoteMeta, Notes } from "macos-ts";
import { archiveOverwrite, atomicCopy, atomicWrite, fileExists } from "../copier.ts";
import { fileUrlToPath, sanitizeFilename } from "../fsutil.ts";
import { Manifest } from "../manifest.ts";
import type { ProgressEvent } from "../tui.ts";

export interface NotesCfg {
  dest: string;
}

export async function* runNotes({ dest }: NotesCfg): AsyncIterable<ProgressEvent> {
  const root = `${dest}/notes`;
  const mf = await Manifest.open("notes");
  const db = new Notes();

  try {
    yield { type: "phase", label: "scanning Notes" };
    const all = db.notes({ sortBy: "modifiedAt", order: "asc" });
    yield { type: "total", files: all.length };

    let filesTransferred = 0;
    let bytesTransferred = 0;

    for (let i = 0; i < all.length; i++) {
      const note = all[i] as NoteMeta;
      const idStr = `${note.id}`;
      const display = `${note.folderName}/${note.title || "(untitled)"}`;

      if (note.isPasswordProtected) {
        yield {
          type: "log",
          level: "warn",
          message: `password-protected, skipped: ${display}`,
        };
        yield { type: "file", name: display, bytesDelta: 0, index: i + 1 };
        continue;
      }

      const sourceKey = `${note.modifiedAt.getTime()}`;
      const existing = mf.get(idStr);
      const fname = `${sanitizeFilename(note.title || "untitled")}-${note.id}.md`;
      const out = join(
        root,
        sanitizeFilename(note.accountName),
        sanitizeFilename(note.folderName),
        fname,
      );
      const attachmentsDir = `${out}.attachments`;

      if (existing && existing.source_key === sourceKey && (await fileExists(existing.dest_path))) {
        yield { type: "file", name: display, bytesDelta: 0, index: i + 1 };
        continue;
      }

      const version = (existing?.version ?? 0) + 1;
      if (existing) {
        await archiveOverwrite(existing.dest_path, existing.version, root);
        const oldAttachments = `${existing.dest_path}.attachments`;
        if (await fileExists(oldAttachments)) {
          await archiveOverwrite(oldAttachments, existing.version, root);
        }
      }

      let content: string;
      try {
        content = db.read(note.id).markdown;
      } catch (err) {
        yield {
          type: "log",
          level: "warn",
          message: `read failed: ${display} (${(err as Error).message})`,
        };
        yield { type: "file", name: display, bytesDelta: 0, index: i + 1 };
        continue;
      }

      const mdBytes = await atomicWrite(out, content);
      let attachmentBytes = 0;

      const attachments = db.listAttachments(note.id);
      if (attachments.length > 0) {
        for (const a of attachments) {
          const url = a.url ?? db.getAttachmentUrl(`${a.id}`);
          if (!url) continue;
          const src = fileUrlToPath(url);
          if (!(await fileExists(src))) continue;
          const aOut = join(attachmentsDir, sanitizeFilename(a.name || `attachment-${a.id}`));
          try {
            attachmentBytes += await atomicCopy(src, aOut);
          } catch (err) {
            yield {
              type: "log",
              level: "warn",
              message: `attachment copy failed: ${display}/${a.name}: ${(err as Error).message}`,
            };
          }
        }
      } else {
        // No attachments — drop any leftover dir from a prior version
        if (await fileExists(attachmentsDir)) {
          await rm(attachmentsDir, { recursive: true, force: true });
        }
      }

      mf.upsert({
        source_id: idStr,
        dest_path: out,
        source_key: sourceKey,
        size_bytes: mdBytes,
        backed_up_at: Date.now(),
        version,
      });

      const total = mdBytes + attachmentBytes;
      filesTransferred++;
      bytesTransferred += total;
      yield { type: "file", name: display, bytesDelta: total, index: i + 1 };
    }

    yield { type: "done", filesTransferred, bytesTransferred };
  } finally {
    mf.close();
    db.close();
  }
}
