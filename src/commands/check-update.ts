import pc from "picocolors";
import { updater } from "../updater.ts";

export async function runCheckUpdate(): Promise<boolean> {
  const info = await updater.checkForUpdate();

  await updater.saveCache({
    lastCheckAt: new Date().toISOString(),
    latestVersion: info.latestVersion,
    hasUpdate: info.hasUpdate,
    changelog: info.changelog,
  });

  if (!info.hasUpdate) {
    if (info.aheadOfLatest) {
      console.log(pc.dim(`Local v${info.currentVersion} is ahead of npm v${info.latestVersion}`));
    } else {
      console.log(pc.green(`icloud-backup is up to date (v${info.currentVersion})`));
    }
    return true;
  }

  console.log(pc.yellow(`Update available: v${info.currentVersion} → v${info.latestVersion}`));
  if (info.changelog) {
    console.log("");
    console.log(pc.dim(info.changelog));
  }
  console.log("");
  console.log(pc.cyan("Run `icloud-backup upgrade` to install"));
  return true;
}
