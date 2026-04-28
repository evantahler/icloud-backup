import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import cliProgress from "cli-progress";
import pc from "picocolors";
import { LANE_COLOR, LOG_DIR, type Service } from "./constants.ts";
import { formatBytes, formatDuration } from "./fsutil.ts";

export type ProgressEvent =
  | { type: "phase"; label: string }
  | { type: "total"; files: number; bytes?: number }
  | { type: "file"; name: string; bytesDelta: number; index: number }
  | { type: "log"; level: "info" | "warn"; message: string }
  | { type: "done"; filesTransferred: number; bytesTransferred: number };

interface LaneState {
  service: Service;
  bar: cliProgress.SingleBar;
  totalFiles: number;
  totalBytes: number;
  bytesSoFar: number;
  completedFiles: number;
}

export interface TuiHandle {
  onEvent(service: Service, event: ProgressEvent): void;
  log(level: "info" | "warn", message: string): void;
  stop(): void;
  logFile: string;
  hadWarnings(): boolean;
}

export function createTui(services: Service[]): TuiHandle {
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
    lanes.set(service, {
      service,
      bar,
      totalFiles: 0,
      totalBytes: 0,
      bytesSoFar: 0,
      completedFiles: 0,
    });
  }

  const startedAt = Date.now();
  const summaryBar = multibar.create(1, 0, { elapsed: "0s", eta: "…" }, { format: summaryFormat });

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
    for (const lane of lanes.values()) {
      if (lane.totalFiles === 0) continue;
      if (lane.completedFiles >= lane.totalFiles) continue;
      allDone = false;
      if (lane.completedFiles === 0 || elapsedMs < 2000) {
        unknown = true;
        continue;
      }
      const laneEtaMs = (elapsedMs * (lane.totalFiles - lane.completedFiles)) / lane.completedFiles;
      if (laneEtaMs > maxEtaMs) maxEtaMs = laneEtaMs;
    }
    const eta = allDone ? "" : unknown ? "…" : formatDuration(maxEtaMs);
    summaryBar.update(0, { elapsed: formatDuration(elapsedMs), eta });
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
        case "file":
          lane.bytesSoFar += event.bytesDelta;
          lane.completedFiles = event.index;
          lane.bar.update(event.index, {
            bytes: formatBytes(lane.bytesSoFar),
            totalBytes: lane.totalBytes ? formatBytes(lane.totalBytes) : "?",
            filename: truncate(event.name, 60),
          });
          updateSummary();
          break;
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
  const tail = payload.eta ? ` · ETA ${payload.eta}` : "";
  return pc.dim(`elapsed ${payload.elapsed}${tail}`);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `…${s.slice(s.length - max + 1)}`;
}
