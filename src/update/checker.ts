import pkg from "../../package.json" with { type: "json" };
import { type InstallMethod, UPDATE_CHECK_TTL_MS } from "../constants.ts";

const NPM_REGISTRY_URL = `https://registry.npmjs.org/${pkg.name}/latest`;
const GITHUB_REPO = pkg.repository.url
  .replace(/^https:\/\/github\.com\//, "")
  .replace(/\.git$/, "");

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  changelog?: string;
}

export interface UpdateCache {
  lastCheckAt: string;
  latestVersion: string;
  hasUpdate: boolean;
  changelog?: string;
}

export function isNewerVersion(current: string, latest: string): boolean {
  return Bun.semver.order(current, latest) === -1;
}

export async function fetchLatestVersion(signal?: AbortSignal): Promise<string> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, { signal });
    if (!res.ok) return pkg.version;
    const data = (await res.json()) as { version: string };
    return data.version;
  } catch {
    return pkg.version;
  }
}

export async function fetchChangelog(
  fromVersion: string,
  toVersion: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`, {
      signal,
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!res.ok) return undefined;
    const releases = (await res.json()) as Array<{ tag_name: string; body: string | null }>;
    const relevant = releases.filter((r) => {
      const v = r.tag_name.replace(/^v/, "");
      return isNewerVersion(fromVersion, v) && !isNewerVersion(toVersion, v);
    });
    if (relevant.length === 0) return undefined;
    return relevant
      .map((r) => `## ${r.tag_name}\n${r.body ?? ""}`)
      .join("\n\n")
      .trim();
  } catch {
    return undefined;
  }
}

export async function checkForUpdate(
  currentVersion: string,
  signal?: AbortSignal,
): Promise<UpdateInfo> {
  const latestVersion = await fetchLatestVersion(signal);
  const hasUpdate = isNewerVersion(currentVersion, latestVersion);
  const changelog = hasUpdate
    ? await fetchChangelog(currentVersion, latestVersion, signal)
    : undefined;
  return { currentVersion, latestVersion, hasUpdate, changelog };
}

export function needsCheck(cache?: UpdateCache, ttlMs = UPDATE_CHECK_TTL_MS): boolean {
  if (!cache?.lastCheckAt) return true;
  return Date.now() - new Date(cache.lastCheckAt).getTime() > ttlMs;
}

export function detectInstallMethod(): InstallMethod {
  const script = process.argv[1] ?? "";
  const exec = process.execPath;
  if (script.includes("/src/index.ts") && !script.includes("node_modules")) return "local-dev";
  if (!exec.includes("bun") && !exec.includes("node")) return "binary";
  if (script.includes(".bun/install") || script.includes(".bun/bin")) return "bun";
  return "npm";
}
