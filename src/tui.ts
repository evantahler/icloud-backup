import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import cliProgress from "cli-progress";
import pc from "picocolors";
import { LANE_COLOR, LOG_DIR, type Service } from "./constants.ts";
import { formatBytes, formatDuration } from "./fsutil.ts";

export type ProgressEvent =
  | { type: "phase"; label: string }
  | { type: "total"; files: number; bytes?: number }
  | { type: "start"; name: string; id: number }
  | { type: "progress"; id: number; fraction: number }
  | {
      type: "file";
      name: string;
      bytesDelta: number;
      // Source-side byte cost of this item if it had been copied. Lanes set
      // this so the TUI can subtract skipped/failed file sizes from the
      // displayed remaining-bytes total.
      bytesExpected?: number;
      index: number;
      id: number;
    }
  | { type: "log"; level: "info" | "warn"; message: string }
  | { type: "done"; filesTransferred: number; bytesTransferred: number };

interface LaneState {
  service: Service;
  bar: cliProgress.SingleBar;
  totalFiles: number;
  totalBytes: number;
  bytesSoFar: number;
  completedFiles: number;
  // Files that actually transferred bytes — drives the ETA divisor so
  // skipped/already-synced items don't poison the rate estimate.
  copiedFiles: number;
  slotBars: cliProgress.SingleBar[];
  slotIds: Array<number | null>;
  activeCount: number;
}

export interface TuiHandle {
  onEvent(service: Service, event: ProgressEvent): void;
  log(level: "info" | "warn", message: string): void;
  stop(): void;
  logFile: string;
  hadWarnings(): boolean;
}

export function createTui(services: Service[], concurrency = 1): TuiHandle {
  const slotCount = Math.max(1, concurrency);
  const multibar = new cliProgress.MultiBar(
    {
      format: laneFormat,
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: false,
      barCompleteChar: "█",
      barIncompleteChar: "░",
      barsize: 24,
      autopadding: true,
      forceRedraw: true,
    },
    cliProgress.Presets.shades_classic,
  );

  const lanes = new Map<Service, LaneState>();
  for (const service of services) {
    const bar = multibar.create(1, 0, {
      service: LANE_COLOR[service](service.padEnd(9)),
      bytes: "0 B",
      totalBytes: "?",
      filename: pc.dim("(starting)"),
    });
    const slotBars: cliProgress.SingleBar[] = [];
    for (let i = 0; i < slotCount; i++) {
      slotBars.push(
        multibar.create(1, 0, { filename: pc.dim("(idle)"), pie: " " }, { format: slotFormat }),
      );
    }
    lanes.set(service, {
      service,
      bar,
      totalFiles: 0,
      totalBytes: 0,
      bytesSoFar: 0,
      completedFiles: 0,
      copiedFiles: 0,
      slotBars,
      slotIds: new Array<number | null>(slotCount).fill(null),
      activeCount: 0,
    });
  }

  const startedAt = Date.now();
  const summaryBar = multibar.create(
    1,
    0,
    { elapsed: "0s", eta: "…", speed: "" },
    { format: summaryFormat },
  );

  // Per-run warn log; lazy-opened on first warn so empty runs leave no file.
  // ISO timestamp with `:` and `.` swapped for `-` to be safe across filesystems.
  const logFile = join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  let logStream: WriteStream | null = null;
  let warnSeen = false;
  function appendWarn(service: Service | "tui", message: string): void {
    if (!logStream) logStream = createWriteStream(logFile, { flags: "a" });
    warnSeen = true;
    logStream.write(`${new Date().toISOString()} [${service}] ${message}\n`);
  }

  function updateSummary(): void {
    const elapsedMs = Date.now() - startedAt;
    let maxEtaMs = 0;
    let unknown = false;
    let allDone = true;
    let totalBytesSoFar = 0;
    for (const lane of lanes.values()) {
      totalBytesSoFar += lane.bytesSoFar;
      if (lane.totalFiles === 0) continue;
      if (lane.completedFiles >= lane.totalFiles) continue;
      allDone = false;
      if (lane.copiedFiles === 0 || elapsedMs < 2000) {
        unknown = true;
        continue;
      }
      const laneEtaMs = (elapsedMs * (lane.totalFiles - lane.completedFiles)) / lane.copiedFiles;
      if (laneEtaMs > maxEtaMs) maxEtaMs = laneEtaMs;
    }
    const eta = allDone ? "" : unknown ? "…" : formatDuration(maxEtaMs);
    const speed =
      elapsedMs >= 2000 && totalBytesSoFar > 0
        ? formatBytes(totalBytesSoFar / (elapsedMs / 1000))
        : "";
    summaryBar.update(0, { elapsed: formatDuration(elapsedMs), eta, speed });
  }

  const handle: TuiHandle = {
    onEvent(service, event) {
      const lane = lanes.get(service);
      if (!lane) return;
      switch (event.type) {
        case "phase":
          lane.bar.update(undefined as unknown as number, { filename: pc.dim(event.label) });
          break;
        case "total":
          lane.totalFiles = event.files;
          lane.totalBytes = event.bytes ?? 0;
          lane.bar.setTotal(Math.max(1, event.files));
          lane.bar.update(0, {
            bytes: "0 B",
            totalBytes: lane.totalBytes ? formatBytes(lane.totalBytes) : "?",
            filename: pc.dim("(starting)"),
          });
          updateSummary();
          break;
        case "start": {
          lane.activeCount++;
          const idx = lane.slotIds.indexOf(null);
          const slot = idx >= 0 ? lane.slotBars[idx] : undefined;
          if (idx >= 0 && slot) {
            lane.slotIds[idx] = event.id;
            // Pie stays blank until a progress event fires — files that
            // dedup-skip never trigger atomicCopy and so never get a pie.
            slot.update(0, {
              filename: truncate(event.name, slotMaxWidth()),
              pie: " ",
            });
          }
          lane.bar.update(undefined as unknown as number, {
            filename: activeLabel(lane.activeCount),
          });
          break;
        }
        case "progress": {
          const idx = lane.slotIds.indexOf(event.id);
          const slot = idx >= 0 ? lane.slotBars[idx] : undefined;
          if (idx >= 0 && slot) {
            slot.update(0, { pie: pieChar(event.fraction) });
          }
          break;
        }
        case "file": {
          const idx = lane.slotIds.indexOf(event.id);
          const slot = idx >= 0 ? lane.slotBars[idx] : undefined;
          if (idx >= 0 && slot) {
            lane.slotIds[idx] = null;
            slot.update(0, { filename: pc.dim("(idle)"), pie: " " });
          }
          lane.activeCount = Math.max(0, lane.activeCount - 1);
          lane.bytesSoFar += event.bytesDelta;
          lane.completedFiles = event.index;
          if (event.bytesDelta > 0) lane.copiedFiles++;
          if (
            event.bytesDelta === 0 &&
            event.bytesExpected !== undefined &&
            event.bytesExpected > 0 &&
            lane.totalBytes > 0
          ) {
            lane.totalBytes = Math.max(lane.bytesSoFar, lane.totalBytes - event.bytesExpected);
          }
          lane.bar.update(event.index, {
            bytes: formatBytes(lane.bytesSoFar),
            totalBytes: lane.totalBytes ? formatBytes(lane.totalBytes) : "?",
            filename: activeLabel(lane.activeCount),
          });
          updateSummary();
          break;
        }
        case "log":
          multibar.log(
            `${event.level === "warn" ? pc.yellow("warn") : pc.dim("info")} ${pc.dim(`[${service}]`)} ${event.message}\n`,
          );
          if (event.level === "warn") appendWarn(service, event.message);
          break;
        case "done":
          lane.completedFiles = lane.totalFiles;
          lane.bar.update(lane.totalFiles || 1, {
            bytes: formatBytes(event.bytesTransferred),
            totalBytes: formatBytes(event.bytesTransferred),
            filename: pc.green(`done (${event.filesTransferred} files)`),
          });
          for (const slot of lane.slotBars) multibar.remove(slot);
          lane.slotBars = [];
          lane.slotIds = [];
          updateSummary();
          break;
      }
    },
    log(level, message) {
      multibar.log(`${level === "warn" ? pc.yellow("warn") : pc.dim("info")} ${message}\n`);
      if (level === "warn") appendWarn("tui", message);
    },
    stop() {
      multibar.stop();
      logStream?.end();
    },
    logFile,
    hadWarnings: () => warnSeen,
  };

  return handle;
}

function laneFormat(
  options: cliProgress.Options,
  params: cliProgress.Params,
  payload: Record<string, string>,
): string {
  const total = Math.max(1, params.total);
  const value = Math.min(params.value, total);
  const pct = Math.round((value / total) * 100);
  const barCompleteChar = options.barCompleteChar ?? "█";
  const barIncompleteChar = options.barIncompleteChar ?? "░";
  const barsize = options.barsize ?? 24;
  const completeSize = Math.round((value / total) * barsize);
  const bar =
    barCompleteChar.repeat(completeSize) + barIncompleteChar.repeat(barsize - completeSize);
  const counts = `${value}/${total}`.padStart(13);
  const bytes = `${payload.bytes}/${payload.totalBytes}`.padStart(16);
  return `${payload.service} │ ${bar} ${pct.toString().padStart(3)}% │ ${counts} │ ${bytes} │ ${payload.filename}`;
}

function summaryFormat(
  _options: cliProgress.Options,
  _params: cliProgress.Params,
  payload: Record<string, string>,
): string {
  const etaTail = payload.eta ? ` · ETA ${payload.eta}` : "";
  const speedTail = payload.speed ? ` · ${payload.speed}/s` : "";
  return pc.dim(`elapsed ${payload.elapsed}${etaTail}${speedTail}`);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `…${s.slice(s.length - max + 1)}`;
}

const SLOT_PREFIX = `${" ".repeat(12)}↳ `;
const PIE_CHARS = ["○", "◔", "◑", "◕", "●"] as const;

function slotFormat(
  _options: cliProgress.Options,
  _params: cliProgress.Params,
  payload: Record<string, string>,
): string {
  const pie = payload.pie ?? " ";
  return `${SLOT_PREFIX}${pie} ${payload.filename ?? ""}`;
}

function slotMaxWidth(): number {
  const cols = process.stdout.columns ?? 100;
  // SLOT_PREFIX + pie char + space + 1 trailing margin
  return Math.max(20, cols - SLOT_PREFIX.length - 3);
}

function pieChar(fraction: number): string {
  if (!Number.isFinite(fraction)) return PIE_CHARS[0];
  const clamped = Math.max(0, Math.min(1, fraction));
  const idx = Math.min(PIE_CHARS.length - 1, Math.round(clamped * (PIE_CHARS.length - 1)));
  return PIE_CHARS[idx] ?? PIE_CHARS[0];
}

function activeLabel(active: number): string {
  if (active === 0) return "";
  return pc.dim(`${active} active`);
}
