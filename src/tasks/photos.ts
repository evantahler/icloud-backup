import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type PhotoMeta, Photos } from "macos-ts";
import { archiveOverwrite, atomicCopy, atomicWrite, fileExists } from "../copier.ts";
import { fileUrlToPath, pad2 } from "../fsutil.ts";
import { Manifest } from "../manifest.ts";
import type { ProgressEvent } from "../tui.ts";

export interface PhotosCfg {
  dest: string;
  snapshot?: boolean;
}

export async function* runPhotos({
  dest,
  snapshot = true,
}: PhotosCfg): AsyncIterable<ProgressEvent> {
  const root = `${dest}/photos`;
  const mf = await Manifest.open("photos");
  const db = new Photos();

  try {
    yield { type: "phase", label: "scanning Photos library" };
    const all = db.photos({ sortBy: "dateCreated", order: "asc" });
    yield { type: "total", files: all.length };

    let filesTransferred = 0;
    let bytesTransferred = 0;

    for (let i = 0; i < all.length; i++) {
      const p = all[i] as PhotoMeta;
      const idStr = `${p.id}`;

      let urlInfo: { url: string; locallyAvailable: boolean };
      try {
        urlInfo = db.getPhotoUrl(p.id);
      } catch (err) {
        yield {
          type: "log",
          level: "warn",
          message: `${p.filename}: ${(err as Error).message}`,
        };
        yield { type: "file", name: p.filename, bytesDelta: 0, index: i + 1 };
        continue;
      }

      if (!urlInfo.locallyAvailable) {
        yield {
          type: "log",
          level: "warn",
          message: `iCloud-only, skipped: ${p.filename}`,
        };
        yield { type: "file", name: p.filename, bytesDelta: 0, index: i + 1 };
        continue;
      }

      const src = fileUrlToPath(urlInfo.url);
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(src);
      } catch {
        yield {
          type: "log",
          level: "warn",
          message: `source missing: ${p.filename} (${src})`,
        };
        yield { type: "file", name: p.filename, bytesDelta: 0, index: i + 1 };
        continue;
      }

      const sourceKey = `${Math.floor(st.mtimeMs)}|${st.size}`;
      const existing = mf.get(idStr);
      const out = join(
        root,
        `${p.dateCreated.getFullYear()}`,
        pad2(p.dateCreated.getMonth() + 1),
        p.filename,
      );

      if (existing && existing.source_key === sourceKey && (await fileExists(existing.dest_path))) {
        yield { type: "file", name: p.filename, bytesDelta: 0, index: i + 1 };
        continue;
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

      const bytes = await atomicCopy(src, out);
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

      const total = bytes + detailsBytes + liveBytes;
      filesTransferred++;
      bytesTransferred += total;
      yield {
        type: "file",
        name: `${p.dateCreated.getFullYear()}/${pad2(p.dateCreated.getMonth() + 1)}/${p.filename}`,
        bytesDelta: total,
        index: i + 1,
      };
    }

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
