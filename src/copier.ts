import { rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { mkdirp, todayIso } from "./fsutil.ts";

/** Copy `src` → `dest` atomically. Returns bytes written. */
export async function atomicCopy(src: string, dest: string): Promise<number> {
  await mkdirp(dirname(dest));
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  try {
    const bytes = await Bun.write(tmp, Bun.file(src));
    await rename(tmp, dest);
    return bytes;
  } catch (err) {
    await safeUnlink(tmp);
    throw err;
  }
}

/** Write `content` → `dest` atomically. Returns bytes written. */
export async function atomicWrite(
  dest: string,
  content: string | Uint8Array | ArrayBuffer,
): Promise<number> {
  await mkdirp(dirname(dest));
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  try {
    const bytes = await Bun.write(tmp, content);
    await rename(tmp, dest);
    return bytes;
  } catch (err) {
    await safeUnlink(tmp);
    throw err;
  }
}

/**
 * If `dest` exists, move it to `<root>/_overwritten/<today>/v<version>/<rel>` so we never
 * write over a prior copy in place. `root` is the user's destination root for the lane.
 */
export async function archiveOverwrite(dest: string, version: number, root: string): Promise<void> {
  const exists = await fileExists(dest);
  if (!exists) return;
  const rel = relative(root, dest);
  const archived = join(root, "_overwritten", todayIso(), `v${version}`, rel || basename(dest));
  await mkdirp(dirname(archived));
  await rename(dest, archived);
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {}
}
