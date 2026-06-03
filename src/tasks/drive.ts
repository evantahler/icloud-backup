import { EventQueue, runPool } from "../concurrency.ts";
import { DRIVE_ROOTS, DRIVE_SOURCE_ROOT, HOME } from "../constants.ts";
import { archiveOverwrite, atomicCopy, fileExists, TEMP_SUFFIX_BYTES } from "../copier.ts";
import {
  DEFAULT_MAX_FILENAME_BYTES,
  errCode,
  errReason,
  mkdirp,
  probeMaxFilenameBytes,
  sanitizeRelativePath,
} from "../fsutil.ts";
import { computeWindow } from "../incremental.ts";
import { Manifest } from "../manifest.ts";
import type { ProgressEvent } from "../tui.ts";
import { mdfindChangedSince, type WalkedFile, walk } from "../walker.ts";

export interface BrctlOutcome {
  folder: string;
  exitCode: number;
  stderr: string;
}

export interface DriveCfg {
  dest: string;
  concurrency: number;
  snapshot?: boolean;
  full?: boolean;
  rewindMs?: number;
  brctlReady?: Promise<BrctlOutcome[]>;
}

export async function* runDrive({
  dest,
  concurrency,
  snapshot = true,
  full = false,
  rewindMs = 0,
  brctlReady,
}: DriveCfg): AsyncIterable<ProgressEvent> {
  const root = `${dest}/drive`;
  const mf = await Manifest.open("drive");

  try {
    yield { type: "phase", label: "probing destination" };
    await mkdirp(root);
    const probedMax = await probeMaxFilenameBytes(root);
    const nameCap = Math.min(probedMax - TEMP_SUFFIX_BYTES, DEFAULT_MAX_FILENAME_BYTES);
    yield {
      type: "log",
      level: "info",
      message: `destination NAME_MAX=${probedMax}, sanitizing filenames to ${nameCap} bytes`,
    };

    if (brctlReady) {
      yield { type: "phase", label: "materializing iCloud Drive" };
      const outcomes = await brctlReady;
      for (const o of outcomes) {
        if (o.exitCode !== 0) {
          yield {
            type: "log",
            level: "warn",
            message: `brctl download ${HOME}/${o.folder} exited ${o.exitCode}: ${o.stderr.trim()}`,
          };
        }
      }
    }

    yield { type: "phase", label: "scanning" };
    const runStartedAt = Date.now();
    const { since, log } = computeWindow(mf, full, rewindMs);
    yield log;
    // Scan roots in parallel — Desktop and Documents share no state, and their
    // scans are independent. Incrementally, ask Spotlight for just the files
    // changed since the window via mdfind (an indexed lookup instead of a full
    // tree walk); fall back to a full walk on any mdfind error so we never
    // silently skip. A full scan (no mark / --full) always walks.
    const fallbackWarnings: string[] = [];
    const perRoot = await Promise.all(
      DRIVE_ROOTS.map(async (folder) => {
        const rootPath = `${DRIVE_SOURCE_ROOT}/${folder}`;
        const list: WalkedFile[] = [];
        if (since) {
          try {
            for await (const file of mdfindChangedSince(rootPath, folder, since)) list.push(file);
            return list;
          } catch (err) {
            fallbackWarnings.push(
              `mdfind failed for ${folder} (${(err as Error).message}); falling back to a full walk`,
            );
            list.length = 0;
          }
        }
        for await (const file of walk(rootPath, folder)) list.push(file);
        return list;
      }),
    );
    for (const message of fallbackWarnings) yield { type: "log", level: "warn", message };
    const files = perRoot.flat();

    yield {
      type: "total",
      files: files.length,
      bytes: files.reduce((s, f) => s + f.size, 0),
    };

    yield { type: "phase", label: "transferring" };

    const existing = mf.allMap();

    const queue = new EventQueue<ProgressEvent>();
    let completed = 0;
    let nextId = 0;
    let filesTransferred = 0;
    let bytesTransferred = 0;

    const processOne = async (f: WalkedFile): Promise<void> => {
      let bytesDelta = 0;
      const id = ++nextId;
      queue.push({ type: "start", name: f.rel, id });
      try {
        const sourceKey = `${f.mtimeMs}|${f.size}`;
        const prior = existing.get(f.rel);
        const safeRel = sanitizeRelativePath(f.rel, nameCap);
        const out = `${root}/${safeRel}`;

        if (prior && prior.source_key === sourceKey && (await fileExists(prior.dest_path))) {
          return;
        }

        const version = (prior?.version ?? 0) + 1;
        if (prior) await archiveOverwrite(prior.dest_path, prior.version, root);

        let bytes = 0;
        try {
          bytes = await atomicCopy(f.abs, out, (fraction) => {
            queue.push({ type: "progress", id, fraction });
          });
        } catch (err) {
          // Errno in the prefix so it survives terminal soft-wrap; the long
          // destination path in e.message stays at the end where wrapping can
          // swallow it harmlessly.
          queue.push({
            type: "log",
            level: "warn",
            message: `[copy-failed/${errCode(err)}] ${f.rel} -> ${safeRel} :: ${errReason(err)}`,
          });
          return;
        }

        mf.upsertBuffered({
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
        queue.push({
          type: "file",
          name: f.rel,
          bytesDelta,
          bytesExpected: f.size,
          index: completed,
          id,
        });
      }
    };

    const poolDone = runPool(files, concurrency, processOne).finally(() => queue.close());

    for await (const ev of queue) yield ev;
    await poolDone;

    mf.flushPending();
    // Clean pass only (see photos.ts): unreachable on throw. A mid-run mdfind
    // fallback still counts as clean — we walked the full tree for that root.
    mf.setLastSyncStartedAt(runStartedAt);
    if (snapshot) await mf.snapshot(dest);
    yield { type: "done", filesTransferred, bytesTransferred };
  } finally {
    mf.close();
  }
}
