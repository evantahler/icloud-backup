import { lstat } from "node:fs/promises";
import { Glob } from "bun";
import { MANIFEST_JSON_FILE, MANIFEST_SNAPSHOT_FILE } from "./constants.ts";
import { run, type SpawnResult } from "./spawn.ts";

const EXCLUDE_NAMES = new Set([
  ".DS_Store",
  ".localized",
  // Our own manifest snapshots — never back them up even if a user nests a destination
  // under a watched source root.
  MANIFEST_SNAPSHOT_FILE,
  MANIFEST_JSON_FILE,
]);
const EXCLUDE_PATH_FRAGMENTS = ["/.Trash/", "/.git/", "/node_modules/"];

export interface WalkedFile {
  abs: string;
  rel: string;
  mtimeMs: number;
  size: number;
}

/**
 * Turn a path relative to `root` into a WalkedFile, or null if it should be
 * skipped (hidden component, excluded name/fragment, missing, or not a regular
 * file). Shared by both the full walk and the mdfind-driven incremental scan so
 * they exclude identically.
 */
async function toWalkedFile(
  root: string,
  prefix: string | undefined,
  relWithin: string,
): Promise<WalkedFile | null> {
  // Skip any hidden file or directory (mirrors Glob's dot:false). mdfind can
  // surface dotfiles that the full walk would never yield, so enforce it here.
  if (relWithin.split("/").some((seg) => seg.startsWith("."))) return null;
  const base = relWithin.split("/").pop() ?? relWithin;
  if (EXCLUDE_NAMES.has(base)) return null;
  if (EXCLUDE_PATH_FRAGMENTS.some((f) => `/${relWithin}/`.includes(f))) return null;
  const abs = `${root}/${relWithin}`;
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return {
    abs,
    rel: prefix ? `${prefix}/${relWithin}` : relWithin,
    mtimeMs: Math.floor(st.mtimeMs),
    size: st.size,
  };
}

export async function* walk(root: string, prefix?: string): AsyncIterable<WalkedFile> {
  const glob = new Glob("**/*");
  for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
    const wf = await toWalkedFile(root, prefix, rel);
    if (wf) yield wf;
  }
}

/**
 * Incremental enumeration: ask Spotlight for the files under `root` whose
 * filesystem content-change date is on/after `since`, instead of walking the
 * whole tree. `mdfind` answers from the metadata index (effectively O(results),
 * not O(tree)). Yields the same WalkedFile shape as `walk` so the Drive lane's
 * copy path is unchanged.
 *
 * Throws if `mdfind` exits non-zero so the caller can fall back to a full walk
 * (never silently skip). Note the soft spots the Drive lane documents: a stale/
 * disabled Spotlight index, and pure renames (which don't bump the content-
 * change date) — both are covered by the overlap window + periodic `--full`.
 *
 * `runner` is injectable purely for tests; production uses spawn's `run`.
 */
export async function* mdfindChangedSince(
  root: string,
  prefix: string | undefined,
  since: Date,
  runner: (cmd: string[]) => Promise<SpawnResult> = run,
): AsyncIterable<WalkedFile> {
  const { exitCode, stdout, stderr } = await runner([
    "mdfind",
    "-onlyin",
    root,
    `kMDItemFSContentChangeDate >= $time.iso(${since.toISOString()})`,
  ]);
  if (exitCode !== 0) {
    throw new Error(`mdfind exited ${exitCode}: ${stderr.trim()}`);
  }
  for (const abs of stdout.split("\n")) {
    if (!abs) continue;
    // mdfind prints absolute paths; keep only those genuinely under root.
    if (abs !== root && !abs.startsWith(`${root}/`)) continue;
    const wf = await toWalkedFile(root, prefix, abs.slice(root.length + 1));
    if (wf) yield wf;
  }
}
