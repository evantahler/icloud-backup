import { randomBytes } from "node:crypto";
import { rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { OVERWRITTEN_DIR } from "./constants.ts";
import { mkdirp, todayIso } from "./fsutil.ts";

// Suffix added by atomicCopy/atomicWrite during the temp-file dance. Kept short
// so we preserve as much filename-byte budget as possible on strict SMB shares;
// the run-wide lockfile handles cross-process disambiguation. The byte length
// is fixed (1 + 12 + 4 = 17) so callers can budget for it when sizing destination
// names.
export const TEMP_SUFFIX_BYTES = 17;
function tempSuffix(): string {
  return `.${randomBytes(6).toString("hex")}.tmp`;
}

/** Copy `src` → `dest` atomically. Returns bytes written. */
export async function atomicCopy(
  src: string,
  dest: string,
  onProgress?: (fraction: number) => void,
): Promise<number> {
  await mkdirp(dirname(dest));
  const tmp = `${dest}${tempSuffix()}`;
  let pollHandle: ReturnType<typeof setInterval> | undefined;
  if (onProgress) {
    let total = 0;
    try {
      total = (await stat(src)).size;
    } catch {}
    onProgress(0);
    if (total > 0) {
      pollHandle = setInterval(() => {
        stat(tmp)
          .then((s) => onProgress(Math.min(0.99, s.size / total)))
          .catch(() => {});
      }, 200);
    }
  }
  try {
    const written = await Bun.write(tmp, Bun.file(src));
    await rename(tmp, dest);
    if (pollHandle) clearInterval(pollHandle);
    onProgress?.(1);
    // Bun.write returns 0 on AFP mounts even when the write succeeds; only
    // pay for the trailing stat in that fallback case.
    return written > 0 ? written : (await stat(dest)).size;
  } catch (err) {
    if (pollHandle) clearInterval(pollHandle);
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
  const tmp = `${dest}${tempSuffix()}`;
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
  const archived = join(root, OVERWRITTEN_DIR, todayIso(), `v${version}`, rel || basename(dest));
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
