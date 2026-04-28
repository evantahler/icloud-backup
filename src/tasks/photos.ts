import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type PhotoMeta, Photos } from "macos-ts";
import { EventQueue, runPool } from "../concurrency.ts";
import { archiveOverwrite, atomicCopy, atomicWrite, fileExists } from "../copier.ts";
import { fileUrlToPath, pad2 } from "../fsutil.ts";
import { Manifest } from "../manifest.ts";
import type { ProgressEvent } from "../tui.ts";

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
      const displayName = `${p.dateCreated.getFullYear()}/${pad2(p.dateCreated.getMonth() + 1)}/${p.filename}`;
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
          p.filename,
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

        const bytes = await atomicCopy(src, out, (fraction) => {
          queue.push({ type: "progress", id, fraction });
        });
        const detailsBytes = await atomicWrite(
          `${out}.json`,
          JSON.stringify(db.getPhoto(p.id), null, 2),
        );

        let liveBytes = 0;
        const liveSrc = `${stripExt(src)}.mov`;
        if (await fileExists(liveSrc)) {
          const liveOut = `${stripExt(out)}.mov`;
          liveBytes = await atomicCopy(liveSrc, liveOut);
        }

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

    const poolDone = runPool(all, concurrency, processOne).finally(() => queue.close());

    for await (const ev of queue) yield ev;
    await poolDone;

    if (snapshot) await mf.snapshot("photos", dest);
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
