import { createHash, randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LOG_DIR, STATE_DIR } from "./constants.ts";

export async function mkdirp(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function ensureStateDirs(): Promise<void> {
  await mkdirp(STATE_DIR);
  await mkdirp(LOG_DIR);
}

export function fileUrlToPath(url: string): string {
  if (url.startsWith("file://")) return fileURLToPath(url);
  return url;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ASCII control chars from filenames is intentional
const INVALID_FILENAME_CHARS = /[/\\:*?"<>|\x00-\x1f]/g;
// Zero-width and variation-selector code points pass through .trim() but
// produce invisible "ghost" prefixes that AFP/SMB shares can reject. Written
// with \u escapes so the source has no invisible bytes.
const ZERO_WIDTH_CHARS = /​|‌|‍|[︀-️]|﻿/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: trimming ASCII control chars at edges is intentional
const LEADING_GARBAGE = /^[\s\x00-\x1f]+/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: trailing dots/spaces/controls are rejected on SMB/exFAT/NTFS
const TRAILING_GARBAGE = /[\s.\x00-\x1f]+$/;
// Default per-component byte cap. We target SMB as the lowest-common-denominator
// destination (see README "Destination compatibility"); APFS/HFS+ NAME_MAX is 255
// but real-world SMB servers cap much lower (HVTVault: 143). Lanes should probe
// at runtime via probeMaxFilenameBytes and pass that value in — this constant
// is the fallback when the probe can't run.
export const DEFAULT_MAX_FILENAME_BYTES = 200;

export function sanitizeFilename(
  name: string,
  opts: { maxBytes?: number; fallback?: string } = {},
): string {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILENAME_BYTES;
  const fallback = opts.fallback ?? "untitled";
  // NFC-normalize first: macOS APFS/HFS+ stores names in NFD, and SMB shares
  // typically expect NFC. Without this, names like "DALL·E" (with a decomposed
  // É) round-trip through Bun.write to SMB as a byte sequence the share rejects.
  let s = name.normalize("NFC").replace(ZERO_WIDTH_CHARS, "");
  // Strip leading whitespace/control chars *before* substitution so that
  // "\x01 foo" doesn't get stuck as "_ foo" with a leading underscore-space.
  s = s.replace(LEADING_GARBAGE, "");
  s = s.replace(INVALID_FILENAME_CHARS, "_");
  // Leading dots become a single underscore so notes named ".secret" don't
  // produce hidden files on Unix-like filesystems.
  s = s.replace(/^\.+/, "_");
  s = truncateUtf8(s, maxBytes);
  // Run *after* truncation in case the byte-cap landed on a trailing dot/space.
  s = s.replace(TRAILING_GARBAGE, "");
  if (s.length === 0) return fallback;
  return s;
}

/** Sanitize each path component of a relative path. Separators are preserved. */
export function sanitizeRelativePath(rel: string, maxBytes = DEFAULT_MAX_FILENAME_BYTES): string {
  return rel
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => sanitizeFilename(seg, { maxBytes }))
    .join("/");
}

/**
 * Empirically discover the per-component filename byte limit of `dir` by
 * binary-searching ASCII probe writes. Returns the largest filename byte
 * length that succeeds, clamped to [floor, ceiling]. Returns `fallback` if
 * the probe itself can't run (e.g. dir doesn't exist, read-only, perm
 * denied) — caller should treat that as "use the default cap".
 *
 * Real-world example: macOS smbfs against HVTVault advertises NAME_MAX=255
 * via pathconf, but actually rejects writes >143 bytes. APFS/HFS+ accept
 * the full 255. We probe instead of trusting pathconf.
 */
export async function probeMaxFilenameBytes(
  dir: string,
  opts: { fallback?: number; floor?: number; ceiling?: number } = {},
): Promise<number> {
  const fallback = opts.fallback ?? DEFAULT_MAX_FILENAME_BYTES;
  const floor = opts.floor ?? 32;
  const ceiling = opts.ceiling ?? 255;
  const sessionId = randomBytes(4).toString("hex");
  const probedNames: string[] = [];
  const tryWrite = async (n: number): Promise<boolean> => {
    // Hidden + session-scoped so concurrent probes (shouldn't happen, but
    // cheap insurance) and partial cleanups don't collide.
    const padLen = n - (1 + sessionId.length + 1);
    if (padLen < 1) return false;
    const name = `.${sessionId}-${"a".repeat(padLen)}`;
    const full = `${dir}/${name}`;
    try {
      await writeFile(full, "");
      probedNames.push(full);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENAMETOOLONG") return false;
      // Anything else (ENOENT, EACCES, EROFS, etc.) means we can't probe at
      // all — bubble up so the caller falls back to the default cap.
      throw err;
    }
  };
  try {
    if (!(await tryWrite(floor))) return fallback;
    if (await tryWrite(ceiling)) return ceiling;
    let lo = floor;
    let hi = ceiling;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await tryWrite(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  } catch {
    return fallback;
  } finally {
    await Promise.all(probedNames.map((p) => unlink(p).catch(() => {})));
  }
}

export function errReason(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e?.code ? `${e.code}: ${e.message}` : ((e?.message as string) ?? String(err));
}

export function errCode(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e?.code ?? "ERR";
}

function truncateUtf8(s: string, maxBytes: number): string {
  const buf = new TextEncoder().encode(s);
  if (buf.length <= maxBytes) return s;
  // Walk back from maxBytes to a UTF-8 boundary so we don't split a multibyte
  // codepoint. Continuation bytes are 10xxxxxx (i.e. (b & 0xc0) === 0x80).
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(buf.subarray(0, end));
}

export function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let value = n;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec === 0 ? `${totalMin}m` : `${totalMin}m ${sec}s`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min === 0 ? `${hr}h` : `${hr}h ${min}m`;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
