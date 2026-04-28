import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { type NoteMeta, Notes } from "macos-ts";
import { EventQueue, runPool } from "../concurrency.ts";
import {
  archiveOverwrite,
  atomicCopy,
  atomicWrite,
  fileExists,
  TEMP_SUFFIX_BYTES,
} from "../copier.ts";
import {
  DEFAULT_MAX_FILENAME_BYTES,
  errCode,
  errReason,
  mkdirp,
  probeMaxFilenameBytes,
  sanitizeFilename,
} from "../fsutil.ts";
import { Manifest } from "../manifest.ts";
import type { ProgressEvent } from "../tui.ts";

// We append `.attachments` (12 bytes) to a note's `.md` filename to form the
// sibling attachments directory. Reserve that on top of the temp suffix so the
// directory rename during atomicCopy of attachments stays under NAME_MAX.
const NOTE_ATTACHMENT_RESERVE = ".attachments".length;

export interface NotesCfg {
  dest: string;
  concurrency: number;
  snapshot?: boolean;
}

// Attachment rows whose ZTYPEUTI matches one of these never have a file on
// disk — content lives in the note body or in ZMERGEABLEDATA1 — so resolving
// them as files always returns "not-found" and floods the log with noise.
const NON_FILE_ATTACHMENT_TYPES = new Set([
  "com.apple.notes.table",
  "com.apple.notes.gallery",
  "com.apple.notes.inlinetextattachment.hashtag",
  "com.apple.notes.inlinetextattachment.mention",
  "com.apple.notes.inlinetextattachment.link",
]);

// Errno in the prefix so it survives terminal soft-wrap; the long destination
// path in e.message stays at the end where wrapping can swallow it harmlessly.
export function formatCopyFailed(
  display: string,
  srcName: string,
  destName: string,
  err: unknown,
): string {
  return `[copy-failed/${errCode(err)}] ${display} :: ${srcName} -> ${destName} :: ${errReason(err)}`;
}

// Apple Notes auto-names attachments after the note title, so duplicates
// within a single note are common. Without disambiguation, atomicCopy would
// silently rename-clobber earlier files at the same path.
export function chooseAttachmentName(
  rawName: string | null | undefined,
  id: number,
  seen: Set<string>,
  maxBytes?: number,
): string {
  const base = sanitizeFilename(rawName || `attachment-${id}`, { maxBytes });
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  const dotIdx = base.lastIndexOf(".");
  const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  const ext = dotIdx > 0 ? base.slice(dotIdx) : "";
  let candidate = `${stem}-${id}${ext}`;
  let n = 2;
  while (seen.has(candidate)) {
    candidate = `${stem}-${id}-${n}${ext}`;
    n++;
  }
  seen.add(candidate);
  return candidate;
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
    yield { type: "phase", label: "probing destination" };
    await mkdirp(root);
    const probedMax = await probeMaxFilenameBytes(root);
    const nameCap = Math.min(
      probedMax - TEMP_SUFFIX_BYTES - NOTE_ATTACHMENT_RESERVE,
      DEFAULT_MAX_FILENAME_BYTES,
    );
    yield {
      type: "log",
      level: "info",
      message: `destination NAME_MAX=${probedMax}, sanitizing filenames to ${nameCap} bytes`,
    };

    yield { type: "phase", label: "scanning Notes" };
    const all = db.notes({ sortBy: "modifiedAt", order: "asc" });
    yield { type: "total", files: all.length };

    const queue = new EventQueue<ProgressEvent>();
    let completed = 0;
    let nextId = 0;
    let filesTransferred = 0;
    let bytesTransferred = 0;

    const processOne = async (note: NoteMeta): Promise<void> => {
      const idStr = `${note.id}`;
      const display = `${note.folderName}/${note.title || "(untitled)"}`;
      let bytesDelta = 0;
      const id = ++nextId;
      queue.push({ type: "start", name: display, id });

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
        // Reserve room for `-${note.id}.md` so the final filename also fits.
        const fnameSuffix = `-${note.id}.md`;
        const titleCap = Math.max(8, nameCap - fnameSuffix.length);
        const fname = `${sanitizeFilename(note.title || "untitled", { maxBytes: titleCap })}${fnameSuffix}`;
        const out = join(
          root,
          sanitizeFilename(note.accountName, { maxBytes: nameCap }),
          sanitizeFilename(note.folderName, { maxBytes: nameCap }),
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
        const seenAttachmentNames = new Set<string>();
        // Pie advances by step per loop iteration (whether copied, skipped, or
        // failed) so it reaches ~100% when the loop finishes regardless of
        // outcome. The trailing markdown write is small enough to not need its
        // own slot — the pie clears on the file event right after.
        const progressStep = attachments.length > 0 ? 1 / attachments.length : 0;
        let progressBase = 0;
        const advanceProgress = (): void => {
          progressBase = Math.min(1, progressBase + progressStep);
          queue.push({ type: "progress", id, fraction: progressBase });
        };

        for (const a of attachments) {
          if (!a.url) {
            // Skip rows that are never file-backed by design — warning on them
            // would just produce noise on every run.
            if (NON_FILE_ATTACHMENT_TYPES.has(a.contentType)) {
              advanceProgress();
              continue;
            }
            const detail = db.resolveAttachment(a.identifier || a.name);
            const reason = "error" in detail ? detail.error : "unknown";
            const nameOrId = a.name || `(no name, id=${a.id})`;
            queue.push({
              type: "log",
              level: "warn",
              message: `[unresolved/${reason}] type=${a.contentType} identifier=${a.identifier || "(empty)"} :: ${display} :: ${nameOrId}`,
            });
            advanceProgress();
            continue;
          }
          // Strip the file:// scheme that macos-ts always returns.
          const src = a.url.startsWith("file://") ? a.url.slice("file://".length) : a.url;
          if (!(await fileExists(src))) {
            queue.push({
              type: "log",
              level: "warn",
              message: `[source-missing] ${display} :: ${a.name} :: ${src}`,
            });
            advanceProgress();
            continue;
          }
          const safeName = chooseAttachmentName(a.name, a.id, seenAttachmentNames, nameCap);
          const aOut = join(attachmentsDir, safeName);
          try {
            attachmentBytes += await atomicCopy(src, aOut, (frac) => {
              queue.push({
                type: "progress",
                id,
                fraction: Math.min(1, progressBase + frac * progressStep),
              });
            });
            attachmentFiles++;
            if (a.identifier) linkMap.set(a.identifier, `./${attachmentsDirName}/${safeName}`);
          } catch (err) {
            queue.push({
              type: "log",
              level: "warn",
              message: formatCopyFailed(display, a.name, safeName, err),
            });
          }
          advanceProgress();
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
            message: `[read-failed/${errReason(err)}] ${display}`,
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
          message: `[${errReason(err)}] ${display}`,
        });
      } finally {
        completed++;
        queue.push({ type: "file", name: display, bytesDelta, index: completed, id });
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
