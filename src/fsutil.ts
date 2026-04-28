import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LOG_DIR, MANIFEST_DIR } from "./constants.ts";

export async function mkdirp(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function ensureStateDirs(): Promise<void> {
  await mkdirp(MANIFEST_DIR);
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
// AFP/HFS+ caps each path component at 255 bytes; stay under that with headroom
// for the `.tmp.<pid>.<ts>` suffix atomicCopy appends.
const MAX_FILENAME_BYTES = 200;

export function sanitizeFilename(name: string, fallback = "untitled"): string {
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
  s = truncateUtf8(s, MAX_FILENAME_BYTES);
  // Run *after* truncation in case the byte-cap landed on a trailing dot/space.
  s = s.replace(TRAILING_GARBAGE, "");
  if (s.length === 0) return fallback;
  return s;
}

/** Sanitize each path component of a relative path. Separators are preserved. */
export function sanitizeRelativePath(rel: string): string {
  return rel
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => sanitizeFilename(seg))
    .join("/");
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
