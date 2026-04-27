import { EventQueue, runPool } from "../concurrency.ts";
import { DRIVE_ROOTS, HOME } from "../constants.ts";
import { archiveOverwrite, atomicCopy, fileExists } from "../copier.ts";
import { Manifest } from "../manifest.ts";
import { run } from "../spawn.ts";
import type { ProgressEvent } from "../tui.ts";
import { type WalkedFile, walk } from "../walker.ts";

export interface DriveCfg {
  dest: string;
  concurrency: number;
  snapshot?: boolean;
}

export async function* runDrive({
  dest,
  concurrency,
  snapshot = true,
}: DriveCfg): AsyncIterable<ProgressEvent> {
  const root = `${dest}/drive`;
  const mf = await Manifest.open("drive");

  try {
    yield { type: "phase", label: "materializing iCloud Drive" };
    for (const folder of DRIVE_ROOTS) {
      const path = `${HOME}/${folder}`;
      const r = await run(["brctl", "download", path]);
      if (r.exitCode !== 0) {
        yield {
          type: "log",
          level: "warn",
          message: `brctl download ${path} exited ${r.exitCode}: ${r.stderr.trim()}`,
        };
      }
    }

    yield { type: "phase", label: "scanning" };
    const files: WalkedFile[] = [];
    for (const folder of DRIVE_ROOTS) {
      for await (const file of walk(`${HOME}/${folder}`, folder)) {
        files.push(file);
      }
    }

    yield {
      type: "total",
      files: files.length,
      bytes: files.reduce((s, f) => s + f.size, 0),
    };

    yield { type: "phase", label: "transferring" };

    const queue = new EventQueue<ProgressEvent>();
    let completed = 0;
    let filesTransferred = 0;
    let bytesTransferred = 0;

    const processOne = async (f: WalkedFile): Promise<void> => {
      let bytesDelta = 0;
      try {
        const sourceKey = `${f.mtimeMs}|${f.size}`;
        const existing = mf.get(f.rel);
        const out = `${root}/${f.rel}`;

        if (
          existing &&
          existing.source_key === sourceKey &&
          (await fileExists(existing.dest_path))
        ) {
          return;
        }

        const version = (existing?.version ?? 0) + 1;
        if (existing) await archiveOverwrite(existing.dest_path, existing.version, root);

        let bytes = 0;
        try {
          bytes = await atomicCopy(f.abs, out);
        } catch (err) {
          queue.push({
            type: "log",
            level: "warn",
            message: `copy failed: ${f.rel} (${(err as Error).message})`,
          });
          return;
        }

        mf.upsert({
          source_id: f.rel,
          dest_path: out,
          source_key: sourceKey,
          size_bytes: bytes,
          backed_up_at: Date.now(),
          version,
        });

        bytesDelta = bytes;
        filesTransferred++;
        bytesTransferred += bytes;
      } catch (err) {
        queue.push({
          type: "log",
          level: "warn",
          message: `${f.rel}: ${(err as Error).message}`,
        });
      } finally {
        completed++;
        queue.push({ type: "file", name: f.rel, bytesDelta, index: completed });
      }
    };

    const poolDone = runPool(files, concurrency, processOne).finally(() => queue.close());

    for await (const ev of queue) yield ev;
    await poolDone;

    if (snapshot) await mf.snapshot("drive", dest);
    yield { type: "done", filesTransferred, bytesTransferred };
  } finally {
    mf.close();
  }
}
