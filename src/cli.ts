import { Command, Option } from "commander";
import pkg from "../package.json" with { type: "json" };
import type { Lane, Service } from "./config.ts";
import { SERVICES } from "./config.ts";

export interface ParsedFlags {
  lanes: Lane[];
  doctor: boolean;
  rebuild: boolean;
  checkUpdate: boolean;
  upgrade: boolean;
  /** Whether to write `<dest>/<lane>/.manifest.{sqlite,json}` snapshots at end of each successful lane. */
  snapshot: boolean;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("icloud-backup")
    .description(pkg.description)
    .version(pkg.version, "-v, --version")
    .helpOption("-h, --help", "show help")
    .addOption(new Option("--photos <path>", "back up Photos library originals"))
    .addOption(new Option("--drive <path>", "back up iCloud Drive Desktop & Documents"))
    .addOption(new Option("--notes <path>", "back up Apple Notes as markdown"))
    .addOption(new Option("--contacts <path>", "back up Apple Contacts as JSON"))
    .addOption(new Option("--all <path>", "shorthand for all four services"))
    .addOption(new Option("--doctor", "run preflight checks and exit"))
    .addOption(new Option("--rebuild", "walk destinations and rebuild manifests"))
    .addOption(
      new Option(
        "--no-manifest-snapshot",
        "skip writing .manifest.sqlite/.json next to backed-up data",
      ),
    )
    .addOption(new Option("--check-update", "force a fresh npm-registry check"))
    .addOption(new Option("--upgrade", "upgrade to the latest published version"))
    .addHelpText(
      "after",
      `
Environment:
  ICLOUD_BACKUP_NO_UPDATE_CHECK=1   suppress the background "update available" notice

Examples:
  $ icloud-backup --doctor
  $ icloud-backup --all /Volumes/icloud-backup-evan
  $ icloud-backup --notes /Volumes/cloud-docs --photos /Volumes/photo-archive
  $ icloud-backup --rebuild --all /Volumes/icloud-backup-evan
  $ icloud-backup --upgrade
`,
    );

  program.configureOutput({
    writeErr: (s) => process.stderr.write(s),
  });

  return program;
}

export function flagsFromOpts(opts: Record<string, unknown>): ParsedFlags {
  const lanes: Lane[] = [];
  const all = typeof opts.all === "string" ? opts.all : undefined;
  for (const service of SERVICES) {
    const flagDest = opts[service];
    const dest = typeof flagDest === "string" ? flagDest : all;
    if (dest) lanes.push({ service, dest });
  }
  // commander maps `--no-manifest-snapshot` → opts.manifestSnapshot === false.
  // Default (flag absent) is true.
  const snapshot = opts.manifestSnapshot !== false;
  return {
    lanes,
    doctor: !!opts.doctor,
    rebuild: !!opts.rebuild,
    checkUpdate: !!opts.checkUpdate,
    upgrade: !!opts.upgrade,
    snapshot,
  };
}

export function selectedServices(flags: ParsedFlags): Service[] {
  return flags.lanes.map((l) => l.service);
}
