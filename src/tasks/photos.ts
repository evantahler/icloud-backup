import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  fileUrlToPath,
  mkdirp,
  pad2,
  probeMaxFilenameBytes,
  sanitizeFilename,
} from "../fsutil.ts";
import { type PhotoMeta, Photos } from "../macos.ts";
import { Manifest } from "../manifest.ts";
import type { ProgressEvent } from "../tui.ts";

// Reserved on top of the temp suffix so the heaviest sidecar we write
// (`<base>.json` via atomicWrite) still fits: `.json` = 5 bytes, plus the
// per-write temp suffix.
const PHOTO_SIDECAR_RESERVE = 5;

export interface PhotosCfg {
  dest: string;
  concurrency: number;
  snapshot?: boolean;
}

export async function* runPhotos({
  dest,
  concurrency,
  snapshot = true,
}: PhotosCfg): AsyncIterable<ProgressEvent> {
  const root = `${dest}/photos`;
  const mf = await Manifest.open("photos");
  const db = new Photos();

  try {
    yield { type: "phase", label: "probing destination" };
    await mkdirp(root);
    const probedMax = await probeMaxFilenameBytes(root);
    const nameCap = Math.min(
      probedMax - TEMP_SUFFIX_BYTES - PHOTO_SIDECAR_RESERVE,
      DEFAULT_MAX_FILENAME_BYTES,
    );
    yield {
      type: "log",
      level: "info",
      message: `destination NAME_MAX=${probedMax}, sanitizing filenames to ${nameCap} bytes`,
    };

    yield { type: "phase", label: "scanning Photos library" };
    const all = db.photos({ sortBy: "dateCreated", order: "asc" });
    yield { type: "total", files: all.length };

    const queue = new EventQueue<ProgressEvent>();
    let completed = 0;
    let nextId = 0;
    let filesTransferred = 0;
    let bytesTransferred = 0;

    const processOne = async (p: PhotoMeta): Promise<void> => {
      const idStr = `${p.id}`;
      let bytesDelta = 0;
      const safeName = sanitizeFilename(p.filename, { maxBytes: nameCap });
      const displayName = `${p.dateCreated.getFullYear()}/${pad2(p.dateCreated.getMonth() + 1)}/${safeName}`;
      const id = ++nextId;
      queue.push({ type: "start", name: displayName, id });

      try {
        let urlInfo: { url: string; locallyAvailable: boolean };
        try {
          urlInfo = db.getPhotoUrl(p.id);
        } catch (err) {
          queue.push({
            type: "log",
            level: "warn",
            message: `${p.filename}: ${(err as Error).message}`,
          });
          return;
        }

        if (!urlInfo.locallyAvailable) {
          queue.push({
            type: "log",
            level: "warn",
            message: `iCloud-only, skipped: ${p.filename}`,
          });
          return;
        }

        const src = fileUrlToPath(urlInfo.url);
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(src);
        } catch {
          queue.push({
            type: "log",
            level: "warn",
            message: `source missing: ${p.filename} (${src})`,
          });
          return;
        }

        const sourceKey = `${Math.floor(st.mtimeMs)}|${st.size}`;
        const existing = mf.get(idStr);
        const out = join(
          root,
          `${p.dateCreated.getFullYear()}`,
          pad2(p.dateCreated.getMonth() + 1),
          safeName,
        );

        if (
          existing &&
          existing.source_key === sourceKey &&
          (await fileExists(existing.dest_path))
        ) {
          return;
        }

        const version = (existing?.version ?? 0) + 1;
        if (existing) {
          await archiveOverwrite(existing.dest_path, existing.version, root);
          const sidecar = `${existing.dest_path}.json`;
          await archiveOverwrite(sidecar, existing.version, root);
          const livePhoto = `${stripExt(existing.dest_path)}.mov`;
          if (await fileExists(livePhoto)) {
            await archiveOverwrite(livePhoto, existing.version, root);
          }
        }

        // Resolve the live-photo source first so the three writes can fan out
        // under one Promise.all — the original copy dominates the time budget,
        // so overlapping the JSON sidecar and the (optional) .mov copy with it
        // shaves ~30-40% off any asset that has live or edited resources.
        const liveSrc = `${stripExt(src)}.mov`;
        const liveOut = `${stripExt(out)}.mov`;
        const hasLive = await fileExists(liveSrc);
        const sidecar = JSON.stringify(db.getPhoto(p.id), null, 2);

        const [bytes, detailsBytes, liveBytes] = await Promise.all([
          atomicCopy(src, out, (fraction) => {
            queue.push({ type: "progress", id, fraction });
          }),
          atomicWrite(`${out}.json`, sidecar),
          hasLive ? atomicCopy(liveSrc, liveOut) : Promise.resolve(0),
        ]);

        mf.upsert({
          source_id: idStr,
          dest_path: out,
          source_key: sourceKey,
          size_bytes: bytes,
          backed_up_at: Date.now(),
          version,
        });

        bytesDelta = bytes + detailsBytes + liveBytes;
        filesTransferred++;
        bytesTransferred += bytesDelta;
      } catch (err) {
        queue.push({
          type: "log",
          level: "warn",
          message: `${p.filename}: ${(err as Error).message}`,
        });
      } finally {
        completed++;
        queue.push({
          type: "file",
          name: displayName,
          bytesDelta,
          index: completed,
          id,
        });
      }
    };

    mf.beginBatch();
    try {
      const poolDone = runPool(all, concurrency, processOne).finally(() => queue.close());

      for await (const ev of queue) yield ev;
      await poolDone;
    } finally {
      mf.flushBatch();
    }

    if (snapshot) await mf.snapshot(dest);
    yield { type: "done", filesTransferred, bytesTransferred };
  } finally {
    mf.close();
    db.close();
  }
}

function stripExt(path: string): string {
  const dir = dirname(path);
  const base = path.slice(dir.length + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return path;
  return `${dir}/${base.slice(0, dot)}`;
}
