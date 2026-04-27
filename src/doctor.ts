import { access, constants, lstat, stat } from "node:fs/promises";
import { Notes } from "macos-ts";
import pc from "picocolors";
import { DRIVE_ROOTS, HOME, STATE_DIR } from "./constants.ts";
import type { Lane } from "./destination.ts";
import { ensureStateDirs } from "./fsutil.ts";
import { run } from "./spawn.ts";

interface Check {
  ok: boolean;
  name: string;
  detail?: string;
}

export async function runDoctor(lanes: Lane[]): Promise<boolean> {
  const checks: Check[] = [];

  if (process.platform !== "darwin") {
    checks.push({
      ok: false,
      name: "macOS host",
      detail: `running on ${process.platform} — icloud-backup is macOS-only`,
    });
  } else {
    checks.push({ ok: true, name: "macOS host" });
  }

  checks.push(await checkBrctl());
  checks.push(await checkICloudDrive());
  checks.push(await checkFullDiskAccess());
  checks.push(await checkStateDir());

  for (const lane of lanes) {
    checks.push(await checkDestination(lane));
  }

  for (const c of checks) printCheck(c);
  const allOk = checks.every((c) => c.ok);
  console.log("");
  console.log(allOk ? pc.green("All checks passed.") : pc.red("Some checks failed."));
  return allOk;
}

function printCheck(c: Check): void {
  const mark = c.ok ? pc.green("✓") : pc.red("✗");
  const detail = c.detail ? `  ${pc.dim(c.detail)}` : "";
  console.log(`${mark} ${c.name}${detail}`);
}

async function checkBrctl(): Promise<Check> {
  const r = await run(["which", "brctl"]);
  if (r.exitCode !== 0) {
    return { ok: false, name: "brctl available", detail: "brctl not on PATH" };
  }
  return { ok: true, name: "brctl available", detail: r.stdout.trim() };
}

async function checkICloudDrive(): Promise<Check> {
  const cloudDocs = `${HOME}/Library/Mobile Documents/com~apple~CloudDocs`;
  try {
    const st = await stat(cloudDocs);
    if (!st.isDirectory()) {
      return { ok: false, name: "iCloud Drive enabled", detail: `${cloudDocs} not a directory` };
    }
  } catch {
    return {
      ok: false,
      name: "iCloud Drive enabled",
      detail: "iCloud Drive container not found — enable iCloud Drive in System Settings",
    };
  }

  for (const folder of DRIVE_ROOTS) {
    const path = `${HOME}/${folder}`;
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink() || st.isDirectory()) continue;
      return {
        ok: false,
        name: "Desktop & Documents in iCloud",
        detail: `~/${folder} is not accessible`,
      };
    } catch {
      return {
        ok: false,
        name: "Desktop & Documents in iCloud",
        detail: `~/${folder} missing`,
      };
    }
  }
  return { ok: true, name: "iCloud Drive (Desktop & Documents)" };
}

async function checkFullDiskAccess(): Promise<Check> {
  let db: Notes | null = null;
  try {
    db = new Notes();
    db.notes({ limit: 1 });
    return { ok: true, name: "Full Disk Access" };
  } catch (err) {
    const term = process.env.TERM_PROGRAM ?? "your terminal";
    return {
      ok: false,
      name: "Full Disk Access",
      detail: `cannot read Notes DB (${(err as Error).name}). Grant Full Disk Access to ${term} in System Settings → Privacy & Security → Full Disk Access, then re-run.`,
    };
  } finally {
    db?.close();
  }
}

async function checkStateDir(): Promise<Check> {
  try {
    await ensureStateDirs();
    await access(STATE_DIR, constants.W_OK);
    return { ok: true, name: "state dir writable", detail: STATE_DIR };
  } catch (err) {
    return {
      ok: false,
      name: "state dir writable",
      detail: `${STATE_DIR}: ${(err as Error).message}`,
    };
  }
}

async function checkDestination(lane: Lane): Promise<Check> {
  const name = `destination [${lane.service}]`;
  try {
    const st = await stat(lane.dest);
    if (!st.isDirectory()) {
      return { ok: false, name, detail: `${lane.dest} is not a directory` };
    }
    await access(lane.dest, constants.W_OK);
    return { ok: true, name, detail: lane.dest };
  } catch {
    return { ok: false, name, detail: `${lane.dest} missing or not writable` };
  }
}

export function explainAccessError(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  if (err.name === "DatabaseNotFoundError" || err.name === "DatabaseAccessDeniedError") {
    const term = process.env.TERM_PROGRAM ?? "your terminal";
    return pc.yellow(
      `Full Disk Access required. Grant it to ${term} in System Settings → Privacy & Security → Full Disk Access, then re-run.`,
    );
  }
  return undefined;
}
