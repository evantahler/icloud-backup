import { Command, Option } from "commander";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { ENV_NO_UPDATE_CHECK, SERVICES, type Service } from "./constants.ts";
import type { Lane } from "./destination.ts";

export const DEFAULT_CONCURRENCY = 5;

export type Intent =
  | { kind: "backup"; lanes: Lane[]; snapshot: boolean; concurrency: number }
  | { kind: "doctor"; lanes: Lane[] }
  | { kind: "rebuild"; lanes: Lane[] }
  | { kind: "upgrade" }
  | { kind: "checkUpdate" };

export function buildProgram(onIntent: (intent: Intent) => void): Command {
  const program = new Command();
  applyTheme(program);
  program
    .name("icloud-backup")
    .description(pkg.description)
    .version(pkg.version, "-v, --version")
    .helpOption("-h, --help", "show help");

  for (const service of SERVICES) {
    addBackupCommand(program, service, onIntent);
  }
  addAllCommand(program, onIntent);
  addDoctorCommand(program, onIntent);
  addRebuildCommand(program, onIntent);
  addUpgradeCommand(program, onIntent);
  addCheckUpdateCommand(program, onIntent);

  program.addHelpText(
    "after",
    `
${pc.bold(pc.cyan("Environment:"))}
  ${pc.yellow(`${ENV_NO_UPDATE_CHECK}=1`)}   suppress the background "update available" notice

${pc.bold(pc.cyan("Examples:"))}
  $ icloud-backup ${pc.green("doctor")}
  $ icloud-backup ${pc.green("all")} ${pc.magenta("/Volumes/icloud-backup-evan")}
  $ icloud-backup ${pc.green("notes")} ${pc.magenta("/Volumes/cloud-docs")}
  $ icloud-backup ${pc.green("rebuild")} ${pc.magenta("/Volumes/icloud-backup-evan")}
  $ icloud-backup ${pc.green("upgrade")}
`,
  );

  program.configureOutput({ writeErr: (s) => process.stderr.write(s) });
  return program;
}

const SERVICE_DESCRIPTIONS: Record<Service, string> = {
  photos: "back up Photos library originals",
  drive: "back up iCloud Drive Desktop & Documents",
  notes: "back up Apple Notes as markdown",
  contacts: "back up Apple Contacts as JSON",
};

interface BackupOpts {
  manifestSnapshot?: boolean;
  concurrency?: number;
}

function snapshotOption(): Option {
  return new Option(
    "--no-manifest-snapshot",
    "skip writing .manifest.sqlite/.json next to backed-up data",
  );
}

function concurrencyOption(): Option {
  return new Option(
    "--concurrency <n>",
    `files in flight per lane (1..64, default ${DEFAULT_CONCURRENCY})`,
  )
    .argParser((v) => {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || String(n) !== v.trim() || n < 1 || n > 64) {
        throw new Error("--concurrency must be an integer between 1 and 64");
      }
      return n;
    })
    .default(DEFAULT_CONCURRENCY);
}

function addBackupCommand(
  program: Command,
  service: Service,
  onIntent: (intent: Intent) => void,
): void {
  const cmd = program
    .command(service)
    .description(SERVICE_DESCRIPTIONS[service])
    .argument("<dest>", "destination directory")
    .addOption(snapshotOption())
    .addOption(concurrencyOption())
    .action((dest: string, opts: BackupOpts) => {
      onIntent({
        kind: "backup",
        lanes: [{ service, dest }],
        snapshot: opts.manifestSnapshot !== false,
        concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
      });
    });
  applyTheme(cmd);
}

function addAllCommand(program: Command, onIntent: (intent: Intent) => void): void {
  const cmd = program
    .command("all")
    .description("back up all four services to one destination")
    .argument("<dest>", "destination directory shared by all four services")
    .addOption(snapshotOption())
    .addOption(concurrencyOption())
    .action((dest: string, opts: BackupOpts) => {
      onIntent({
        kind: "backup",
        lanes: SERVICES.map((service) => ({ service, dest })),
        snapshot: opts.manifestSnapshot !== false,
        concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
      });
    });
  applyTheme(cmd);
}

function addDoctorCommand(program: Command, onIntent: (intent: Intent) => void): void {
  const cmd = program
    .command("doctor")
    .description("run preflight checks and exit")
    .argument("[dest]", "optional destination to also check writability of")
    .action((dest: string | undefined) => {
      const lanes: Lane[] = dest ? SERVICES.map((service) => ({ service, dest })) : [];
      onIntent({ kind: "doctor", lanes });
    });
  applyTheme(cmd);
}

function addRebuildCommand(program: Command, onIntent: (intent: Intent) => void): void {
  const cmd = program
    .command("rebuild")
    .description(
      "rebuild manifests from destination contents (or clear them if destination is empty — forces full re-sync next run)",
    )
    .argument("<dest>", "destination directory")
    .addOption(new Option("--service <service>", "only rebuild one service").choices([...SERVICES]))
    .action((dest: string, opts: { service?: Service }) => {
      const services = opts.service ? [opts.service] : SERVICES;
      onIntent({
        kind: "rebuild",
        lanes: services.map((service) => ({ service, dest })),
      });
    });
  applyTheme(cmd);
}

function addUpgradeCommand(program: Command, onIntent: (intent: Intent) => void): void {
  const cmd = program
    .command("upgrade")
    .description("upgrade to the latest published version")
    .action(() => onIntent({ kind: "upgrade" }));
  applyTheme(cmd);
}

function addCheckUpdateCommand(program: Command, onIntent: (intent: Intent) => void): void {
  const cmd = program
    .command("check-update")
    .description("force a fresh npm-registry check")
    .action(() => onIntent({ kind: "checkUpdate" }));
  applyTheme(cmd);
}

function applyTheme(cmd: Command): void {
  cmd.configureHelp({
    styleTitle: (s) => pc.bold(pc.cyan(s)),
    styleCommandText: (s) => pc.bold(s),
    styleSubcommandText: (s) => pc.green(s),
    styleOptionTerm: (s) => pc.yellow(s),
    styleArgumentTerm: (s) => pc.magenta(s),
  });
}
