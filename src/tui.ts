import cliProgress from "cli-progress";
import pc from "picocolors";
import type { Service } from "./config.ts";
import { formatBytes } from "./fsutil.ts";

export type ProgressEvent =
  | { type: "phase"; label: string }
  | { type: "total"; files: number; bytes?: number }
  | { type: "file"; name: string; bytesDelta: number; index: number }
  | { type: "log"; level: "info" | "warn"; message: string }
  | { type: "done"; filesTransferred: number; bytesTransferred: number };

const LANE_COLOR: Record<Service, (s: string) => string> = {
  photos: pc.yellow,
  drive: pc.cyan,
  notes: pc.magenta,
  contacts: pc.green,
};

interface LaneState {
  service: Service;
  bar: cliProgress.SingleBar;
  totalFiles: number;
  totalBytes: number;
  bytesSoFar: number;
}

export interface TuiHandle {
  onEvent(service: Service, event: ProgressEvent): void;
  log(level: "info" | "warn", message: string): void;
  stop(): void;
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
    lanes.set(service, { service, bar, totalFiles: 0, totalBytes: 0, bytesSoFar: 0 });
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
          break;
        case "file":
          lane.bytesSoFar += event.bytesDelta;
          lane.bar.update(event.index, {
            bytes: formatBytes(lane.bytesSoFar),
            totalBytes: lane.totalBytes ? formatBytes(lane.totalBytes) : "?",
            filename: truncate(event.name, 60),
          });
          break;
        case "log":
          multibar.log(
            `${event.level === "warn" ? pc.yellow("warn") : pc.dim("info")} ${pc.dim(`[${service}]`)} ${event.message}\n`,
          );
          break;
        case "done":
          lane.bar.update(lane.totalFiles || 1, {
            bytes: formatBytes(event.bytesTransferred),
            totalBytes: formatBytes(event.bytesTransferred),
            filename: pc.green(`done (${event.filesTransferred} files)`),
          });
          break;
      }
    },
    log(level, message) {
      multibar.log(`${level === "warn" ? pc.yellow("warn") : pc.dim("info")} ${message}\n`);
    },
    stop() {
      multibar.stop();
    },
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `…${s.slice(s.length - max + 1)}`;
}
