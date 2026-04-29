#!/usr/bin/env bun

/**
 * Drives VHS (https://github.com/charmbracelet/vhs) to regenerate every asset
 * under docs/assets/ from the tapes in docs/tapes/. The CLI is run with
 * ICLOUD_BACKUP_FAKE=1 so it reads from JSON fixtures instead of the user's
 * Photos/Notes/Contacts databases — no Full Disk Access, no real iCloud
 * library required.
 *
 * Each tape gets its own freshly-prepared ephemeral workdir:
 *   <tmp>/data/         copy of docs/tapes/fixtures/data/ + a generated sources/ tree
 *   <tmp>/fake-drive/   Desktop/ + Documents/ populated from drive.json
 *   <tmp>/state/        ICLOUD_BACKUP_STATE_DIR (manifest + lock + log)
 *   <tmp>/dest/         destination the tape's `all` / `doctor` command writes to
 *
 * Usage:
 *   bun run scripts/capture.ts              # run all tapes
 *   bun run scripts/capture.ts <tape-name>  # run one (name or path)
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const tapesDir = join(repoRoot, "docs", "tapes");
const fixturesSrcDir = join(tapesDir, "fixtures", "data");
const cliPath = join(repoRoot, "src", "index.ts");

function die(msg: string): never {
  process.stderr.write(`[31merror:[0m ${msg}\n`);
  process.exit(1);
}

function info(msg: string): void {
  process.stdout.write(`[36m→[0m ${msg}\n`);
}

async function requireBinary(bin: string, hint: string): Promise<void> {
  const r = await $`which ${bin}`.nothrow().quiet();
  if (r.exitCode !== 0) die(`'${bin}' not found on PATH. ${hint}`);
}

function listTapes(filter?: string): string[] {
  const glob = new Bun.Glob("*.tape");
  const out: string[] = [];
  for (const name of glob.scanSync({ cwd: tapesDir })) {
    if (name.startsWith("_")) continue;
    if (filter) {
      const f = basename(filter, ".tape");
      if (basename(name, ".tape") !== f) continue;
    }
    out.push(join(tapesDir, name));
  }
  return out.sort();
}

interface PhotoEntry {
  sourceFile: string;
  sourceBytes: number;
}
interface NoteEntry {
  attachments: { sourceFile: string | null; sourceBytes?: number }[];
}
interface DriveEntry {
  path: string;
  bytes: number;
}

function copyJson(name: string, destDir: string): void {
  const body = readFileSync(join(fixturesSrcDir, name), "utf8");
  writeFileSync(join(destDir, name), body);
}

function writeFiller(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  // Zero-byte filler — atomicCopy doesn't care about content, and zeros keep
  // captures byte-stable across runs.
  writeFileSync(path, new Uint8Array(bytes));
}

function materializeFixtures(workDir: string): void {
  // Mirror docs/tapes/fixtures/data/ into <workDir>/data/, then generate the
  // sources/ tree from sourceFile/sourceBytes references.
  const dataDir = join(workDir, "data");
  const sourcesDir = join(dataDir, "sources");
  mkdirSync(sourcesDir, { recursive: true });

  copyJson("photos.json", dataDir);
  copyJson("notes.json", dataDir);
  copyJson("contacts.json", dataDir);

  const photos = JSON.parse(readFileSync(join(fixturesSrcDir, "photos.json"), "utf8")) as {
    photos: PhotoEntry[];
  };
  for (const p of photos.photos) {
    writeFiller(join(sourcesDir, p.sourceFile), p.sourceBytes);
  }

  const notes = JSON.parse(readFileSync(join(fixturesSrcDir, "notes.json"), "utf8")) as {
    notes: NoteEntry[];
  };
  for (const n of notes.notes) {
    for (const a of n.attachments) {
      if (a.sourceFile && a.sourceBytes) {
        writeFiller(join(sourcesDir, a.sourceFile), a.sourceBytes);
      }
    }
  }

  const drive = JSON.parse(readFileSync(join(fixturesSrcDir, "drive.json"), "utf8")) as {
    files: DriveEntry[];
  };
  const fakeDrive = join(workDir, "fake-drive");
  for (const f of drive.files) {
    writeFiller(join(fakeDrive, f.path), f.bytes);
  }
}

function makeBinWrapper(workDir: string): string {
  // Wrapper resolves `icloud-backup` → `bun run <cliPath>` so tapes can type
  // the published command name even when run from a checkout.
  const binDir = join(workDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, "icloud-backup");
  writeFileSync(wrapper, `#!/bin/sh\nexec bun run ${cliPath} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return binDir;
}

// Fixed paths used in tapes. Short and predictable so the recordings show
// human-readable destination paths instead of `/var/folders/…` tmp paths.
// Captures aren't expected to run concurrently with each other or with a real
// backup (the lockfile would catch the latter anyway).
const CAPTURE_ROOT = "/tmp/icloud-backup";
const CAPTURE_DEST = `${CAPTURE_ROOT}/dest`;
const CAPTURE_STATE = `${CAPTURE_ROOT}/state`;
const CAPTURE_DATA = `${CAPTURE_ROOT}/data`;
const CAPTURE_FAKE_DRIVE = `${CAPTURE_ROOT}/fake-drive`;

async function runTape(tape: string): Promise<void> {
  info(`capturing ${basename(tape)}`);
  // Fresh, predictable workdir for every tape so doctor/backup output shows
  // stable paths in the recording.
  rmSync(CAPTURE_ROOT, { recursive: true, force: true });
  mkdirSync(CAPTURE_DEST, { recursive: true });
  mkdirSync(CAPTURE_STATE, { recursive: true });
  try {
    materializeFixtures(CAPTURE_ROOT);
    const binDir = makeBinWrapper(CAPTURE_ROOT);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ICLOUD_BACKUP_FAKE: "1",
      ICLOUD_BACKUP_FAKE_FIXTURES_DIR: CAPTURE_DATA,
      ICLOUD_BACKUP_FAKE_DRIVE_ROOT: CAPTURE_FAKE_DRIVE,
      // Synthetic per-item delay applied inside the fake macos-ts classes so
      // the cli-progress bars visibly fill on screen rather than snapping to
      // 100% instantly. Tuned so a full four-lane run takes ~10 s with the
      // current fixture sizes.
      ICLOUD_BACKUP_FAKE_DELAY_MS: "120",
      ICLOUD_BACKUP_STATE_DIR: CAPTURE_STATE,
      ICLOUD_BACKUP_NO_UPDATE_CHECK: "1",
    };

    // VHS resolves the tape's `Output` path relative to its own cwd. Run from
    // repoRoot so `Output docs/assets/<name>.<ext>` lines drop into the
    // committed location.
    const r = await $`vhs ${tape}`.cwd(repoRoot).env(env).nothrow();
    if (r.exitCode !== 0) die(`vhs failed for ${tape} (exit ${r.exitCode})`);

    // Prune any throwaway recordings tapes use to satisfy VHS's required
    // `Output` directive when the keeper asset is a `Screenshot`.
    const assets = join(repoRoot, "docs", "assets");
    for (const stale of new Bun.Glob(".*-recording.{gif,mp4,webm}").scanSync({
      cwd: assets,
      dot: true,
    })) {
      rmSync(join(assets, stale), { force: true });
    }
  } finally {
    rmSync(CAPTURE_ROOT, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await requireBinary("vhs", "Install with `brew install vhs ttyd ffmpeg` on macOS.");
  await requireBinary("ttyd", "VHS needs ttyd. `brew install ttyd`.");
  await requireBinary("ffmpeg", "VHS needs ffmpeg. `brew install ffmpeg`.");

  const filter = process.argv[2];
  const tapes = listTapes(filter);
  if (tapes.length === 0) die(filter ? `no tape matches '${filter}'` : "no tapes found");

  for (const t of tapes) await runTape(t);
  info(`done — assets in ${join(repoRoot, "docs", "assets")}`);
}

await main();
