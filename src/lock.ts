import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { ensureStateDirs, LOCK_PATH } from "./fsutil.ts";

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

export async function acquireLock(): Promise<() => void> {
  await ensureStateDirs();

  try {
    const fd = openSync(LOCK_PATH, "wx");
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (await isStaleLock()) {
      try {
        unlinkSync(LOCK_PATH);
      } catch {}
      return acquireLock();
    }
    const pid = readLockPid();
    throw new LockError(
      `another icloud-backup process is running (pid ${pid ?? "unknown"}). ` +
        `If you're sure it isn't, delete ${LOCK_PATH} and retry.`,
    );
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(LOCK_PATH);
    } catch {}
  };
  return release;
}

function readLockPid(): number | undefined {
  try {
    const raw = readFileSync(LOCK_PATH, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function isStaleLock(): Promise<boolean> {
  const pid = readLockPid();
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
