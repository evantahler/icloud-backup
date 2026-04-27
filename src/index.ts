#!/usr/bin/env bun
import pc from "picocolors";
import { buildProgram, flagsFromOpts, type ParsedFlags } from "./cli.ts";
import { runCheckUpdate } from "./commands/check-update.ts";
import { runRebuild } from "./commands/rebuild.ts";
import { runUpgrade } from "./commands/upgrade.ts";
import type { Lane, Service } from "./config.ts";
import { validateDestination } from "./config.ts";
import { explainAccessError, runDoctor } from "./doctor.ts";
import { acquireLock, LockError } from "./lock.ts";
import { runContacts } from "./tasks/contacts.ts";
import { runDrive } from "./tasks/drive.ts";
import { runNotes } from "./tasks/notes.ts";
import { runPhotos } from "./tasks/photos.ts";
import type { TuiHandle } from "./tui.ts";
import { createTui, type ProgressEvent } from "./tui.ts";
import { maybeCheckForUpdate } from "./update/background.ts";

const TASK_FNS: Record<
  Service,
  (cfg: { dest: string; concurrency: number }) => AsyncIterable<ProgressEvent>
> = {
  photos: runPhotos,
  drive: runDrive,
  notes: runNotes,
  contacts: runContacts,
};

async function consume(
  service: Service,
  iterable: AsyncIterable<ProgressEvent>,
  tui: TuiHandle,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for await (const event of iterable) {
    tui.onEvent(service, event);
    if (event.type === "done") {
      files = event.filesTransferred;
      bytes = event.bytesTransferred;
    }
  }
  return { files, bytes };
}

async function runBackup(flags: ParsedFlags): Promise<number> {
  for (const lane of flags.lanes) {
    try {
      await validateDestination(lane.dest);
    } catch (err) {
      console.error(pc.red(`✗ ${(err as Error).message}`));
      return 2;
    }
  }

  let release: (() => void) | null = null;
  try {
    release = await acquireLock();
  } catch (err) {
    if (err instanceof LockError) {
      console.error(pc.red(`✗ ${err.message}`));
      return 1;
    }
    throw err;
  }

  const updateNoticePromise = maybeCheckForUpdate();

  const tui = createTui(flags.lanes.map((l) => l.service));
  const startedAt = Date.now();
  const results = await Promise.allSettled(
    flags.lanes.map((lane) =>
      consume(
        lane.service,
        TASK_FNS[lane.service]({ dest: lane.dest, concurrency: flags.concurrency }),
        tui,
      ),
    ),
  );
  tui.stop();
  release?.();

  printSummary(flags.lanes, results, Date.now() - startedAt);

  const failed = results.some((r) => r.status === "rejected");
  if (failed) {
    for (const [i, r] of results.entries()) {
      if (r.status === "rejected") {
        const lane = flags.lanes[i] as Lane;
        const explain = explainAccessError(r.reason);
        console.error(pc.red(`✗ [${lane.service}] ${(r.reason as Error)?.message ?? r.reason}`));
        if (explain) console.error(`  ${explain}`);
      }
    }
  }

  const notice = await updateNoticePromise;
  if (notice) process.stderr.write(notice);

  return failed ? 1 : 0;
}

function printSummary(
  lanes: Lane[],
  results: PromiseSettledResult<{ files: number; bytes: number }>[],
  elapsedMs: number,
): void {
  console.log("");
  console.log(pc.bold("Summary"));
  for (const [i, r] of results.entries()) {
    const lane = lanes[i] as Lane;
    if (r.status === "fulfilled") {
      console.log(
        `  ${pc.green("✓")} ${lane.service}: ${r.value.files} files, ${formatBytesLocal(r.value.bytes)}`,
      );
    } else {
      console.log(`  ${pc.red("✗")} ${lane.service}: failed`);
    }
  }
  console.log(pc.dim(`elapsed ${(elapsedMs / 1000).toFixed(1)}s`));
}

function formatBytesLocal(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let v = n;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

async function main(): Promise<number> {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const code = (err as { code?: string; exitCode?: number }).code;
    if (code === "commander.helpDisplayed" || code === "commander.version") return 0;
    if (code === "commander.help") return 0;
    return (err as { exitCode?: number }).exitCode ?? 1;
  }

  const flags = flagsFromOpts(program.opts());

  if (flags.checkUpdate) return (await runCheckUpdate()) ? 0 : 1;
  if (flags.upgrade) return (await runUpgrade()) ? 0 : 1;
  if (flags.doctor) return (await runDoctor(flags.lanes)) ? 0 : 1;
  if (flags.rebuild) {
    if (flags.lanes.length === 0) {
      console.error(pc.red("--rebuild requires at least one service flag (or --all)"));
      return 2;
    }
    return (await runRebuild(flags.lanes)) ? 0 : 1;
  }

  if (flags.lanes.length === 0) {
    program.outputHelp();
    return 2;
  }

  return runBackup(flags);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(pc.red(`Fatal: ${(err as Error).stack ?? err}`));
    process.exit(1);
  });
