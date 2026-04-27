import { lstat } from "node:fs/promises";
import { Glob } from "bun";

const EXCLUDE_NAMES = new Set([
  ".DS_Store",
  ".localized",
  // Our own manifest snapshots — never back them up even if a user nests a destination
  // under a watched source root.
  ".manifest.sqlite",
  ".manifest.json",
]);
const EXCLUDE_PATH_FRAGMENTS = ["/.Trash/", "/.git/", "/node_modules/"];

export interface WalkedFile {
  abs: string;
  rel: string;
  mtimeMs: number;
  size: number;
}

export async function* walk(root: string, prefix?: string): AsyncIterable<WalkedFile> {
  const glob = new Glob("**/*");
  for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
    const base = rel.split("/").pop() ?? rel;
    if (EXCLUDE_NAMES.has(base)) continue;
    if (EXCLUDE_PATH_FRAGMENTS.some((f) => `/${rel}/`.includes(f))) continue;
    const abs = `${root}/${rel}`;
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    yield {
      abs,
      rel: prefix ? `${prefix}/${rel}` : rel,
      mtimeMs: Math.floor(st.mtimeMs),
      size: st.size,
    };
  }
}
