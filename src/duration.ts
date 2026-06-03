// Tiny duration parser for the `--rewind-time` flag (the incremental-sync
// overlap window). Accepts a non-negative integer with an optional unit
// suffix: `d` (days), `h` (hours), `m` (minutes), `s` (seconds). A bare
// integer is treated as seconds. Returns milliseconds.

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a duration like `1d`, `12h`, `90m`, `30s`, or a bare `3600` (seconds)
 * into milliseconds. Throws on anything else (negative, fractional, unknown
 * unit, empty). The error text mirrors the `--concurrency` argParser style.
 */
export function parseDuration(input: string): number {
  const s = input.trim();
  const m = s.match(/^(\d+)([dhms]?)$/);
  if (!m) {
    throw new Error(
      "--rewind-time must be a non-negative integer with an optional unit (e.g. 1d, 12h, 90m, 30s, or a bare number of seconds)",
    );
  }
  const value = Number.parseInt(m[1] as string, 10);
  const unit = m[2] || "s";
  return value * (UNIT_MS[unit] as number);
}

/**
 * Render milliseconds back to the shortest exact unit suffix (`1d`, `12h`,
 * `90m`, `30s`), for human-readable log lines. Falls back to seconds when the
 * value isn't a whole number of any larger unit.
 */
export function formatDuration(ms: number): string {
  if (ms === 0) return "0s";
  for (const unit of ["d", "h", "m", "s"] as const) {
    const scale = UNIT_MS[unit] as number;
    if (ms % scale === 0) return `${ms / scale}${unit}`;
  }
  return `${Math.round(ms / 1000)}s`;
}
