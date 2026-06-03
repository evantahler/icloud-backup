import { formatDuration } from "./duration.ts";
import type { Manifest } from "./manifest.ts";
import type { ProgressEvent } from "./tui.ts";

export interface IncrementalWindow {
  // The cutoff to hand the source: only items changed on/after this are
  // enumerated. `undefined` ⇒ full scan (no prior mark, or `--full`).
  since: Date | undefined;
  // A `log` event describing the window, to yield at lane start so the user
  // understands why the most-recent items re-sync every run.
  log: Extract<ProgressEvent, { type: "log" }>;
}

/**
 * Resolve the incremental-sync window for a lane from its high-water mark.
 *
 * `since = mark − rewindMs` (the overlap window). We deliberately rewind before
 * the mark because iCloud-synced items are timestamped on the originating
 * device and land here later; the overlap re-examines a trailing window so a
 * just-synced edit isn't missed. The per-item manifest diff still decides what
 * actually gets copied, so a wider window only costs re-examination, never
 * duplicate writes. `--full` (or a missing mark) forces a complete scan.
 */
export function computeWindow(mf: Manifest, full: boolean, rewindMs: number): IncrementalWindow {
  const mark = full ? undefined : mf.getLastSyncStartedAt();
  if (mark === undefined) {
    return {
      since: undefined,
      log: {
        type: "log",
        level: "info",
        message: `full scan: ${full ? "--full requested" : "no prior sync mark"} — examining all items`,
      },
    };
  }
  const since = new Date(mark - rewindMs);
  return {
    since,
    log: {
      type: "log",
      level: "info",
      message: `incremental: scanning items changed since ${since.toISOString()} (last sync ${new Date(mark).toISOString()} − ${formatDuration(rewindMs)} overlap); use --full to re-scan everything`,
    },
  };
}
