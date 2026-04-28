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

export function sanitizeFilename(name: string, fallback = "untitled"): string {
  const cleaned = name.replace(INVALID_FILENAME_CHARS, "_").replace(/^\.+/, "_").trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
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
