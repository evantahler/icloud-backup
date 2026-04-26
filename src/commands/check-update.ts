import pc from "picocolors";
import pkg from "../../package.json" with { type: "json" };
import { saveUpdateCache } from "../update/cache.ts";
import { fetchChangelog, fetchLatestVersion, isNewerVersion } from "../update/checker.ts";

export async function runCheckUpdate(): Promise<boolean> {
  const latest = await fetchLatestVersion();
  const hasUpdate = isNewerVersion(pkg.version, latest);
  const changelog = hasUpdate ? await fetchChangelog(pkg.version, latest) : undefined;

  await saveUpdateCache({
    lastCheckAt: new Date().toISOString(),
    latestVersion: latest,
    hasUpdate,
    changelog,
  });

  if (!hasUpdate) {
    if (isNewerVersion(latest, pkg.version)) {
      console.log(pc.dim(`Local v${pkg.version} is ahead of npm v${latest}`));
    } else {
      console.log(pc.green(`icloud-backup is up to date (v${pkg.version})`));
    }
    return true;
  }

  console.log(pc.yellow(`Update available: v${pkg.version} → v${latest}`));
  if (changelog) {
    console.log("");
    console.log(pc.dim(changelog));
  }
  console.log("");
  console.log(pc.cyan("Run `icloud-backup --upgrade` to install"));
  return true;
}
