import pc from "picocolors";
import pkg from "../../package.json" with { type: "json" };
import { ENV_NO_UPDATE_CHECK, UPDATE_CHECK_TIMEOUT_MS } from "../constants.ts";
import { loadUpdateCache, saveUpdateCache } from "./cache.ts";
import { checkForUpdate, needsCheck, type UpdateCache } from "./checker.ts";

function formatNotice(currentVersion: string, latestVersion: string, changelog?: string): string {
  const lines: string[] = [
    "",
    pc.yellow(`Update available: v${currentVersion} → v${latestVersion}`),
  ];
  if (changelog) {
    lines.push("", pc.dim(changelog));
  }
  lines.push("", pc.cyan("Run `icloud-backup --upgrade` to install"), "");
  return lines.join("\n");
}

/**
 * Non-blocking update check. Returns a formatted notice if an update is available,
 * or null otherwise. Never throws.
 */
export async function maybeCheckForUpdate(): Promise<string | null> {
  try {
    if (process.env[ENV_NO_UPDATE_CHECK] === "1") return null;
    if (!process.stderr.isTTY) return null;

    const cache = await loadUpdateCache();
    if (!needsCheck(cache)) {
      return cache?.hasUpdate
        ? formatNotice(pkg.version, cache.latestVersion, cache.changelog)
        : null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
    try {
      const info = await checkForUpdate(pkg.version, controller.signal);
      const newCache: UpdateCache = {
        lastCheckAt: new Date().toISOString(),
        latestVersion: info.latestVersion,
        hasUpdate: info.hasUpdate,
        changelog: info.changelog,
      };
      await saveUpdateCache(newCache);
      return info.hasUpdate ? formatNotice(pkg.version, info.latestVersion, info.changelog) : null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}
