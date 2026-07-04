import pc from "picocolors";
import { updater } from "../updater.ts";

export async function runUpgrade(): Promise<boolean> {
  const result = await updater.upgrade();

  if (!result.hasUpdate) {
    console.log(pc.green(`icloud-backup is already up to date (v${result.from})`));
    return true;
  }

  if (result.method === "local-dev") {
    console.log(pc.yellow("Running from source. Use `git pull && bun install` to update."));
    return false;
  }

  console.log(pc.dim(`Upgrading via ${result.method}: v${result.from} → v${result.to}`));

  if (result.success) {
    console.log(pc.green(`Upgraded to v${result.to}`));
    return true;
  }

  console.error(pc.red(`Upgrade failed: ${result.error ?? "unknown error"}`));
  return false;
}
