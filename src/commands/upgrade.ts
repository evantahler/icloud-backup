import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import pc from "picocolors";
import pkg from "../../package.json" with { type: "json" };
import { run } from "../spawn.ts";
import { clearUpdateCache } from "../update/cache.ts";
import { detectInstallMethod, fetchLatestVersion, isNewerVersion } from "../update/checker.ts";

const GITHUB_REPO = pkg.repository.url
  .replace(/^https:\/\/github\.com\//, "")
  .replace(/\.git$/, "");

function platformArtifact(): string {
  if (process.platform !== "darwin") {
    throw new Error(`icloud-backup binaries are macOS-only (got ${process.platform})`);
  }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `icloud-backup-darwin-${arch}`;
}

export async function runUpgrade(): Promise<boolean> {
  const latest = await fetchLatestVersion();
  if (!isNewerVersion(pkg.version, latest)) {
    console.log(pc.green(`icloud-backup is already up to date (v${pkg.version})`));
    return true;
  }

  const method = detectInstallMethod();
  console.log(pc.dim(`Upgrading via ${method}: v${pkg.version} → v${latest}`));

  switch (method) {
    case "bun":
      return runShell(["bun", "install", "-g", `${pkg.name}@${latest}`]);
    case "npm":
      return runShell(["npm", "install", "-g", `${pkg.name}@${latest}`]);
    case "binary":
      return upgradeBinary(latest);
    case "local-dev":
      console.log(pc.yellow("Running from source. Use `git pull && bun install` to update."));
      return false;
  }
}

async function runShell(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code === 0) await clearUpdateCache();
  return code === 0;
}

async function upgradeBinary(latest: string): Promise<boolean> {
  const artifact = platformArtifact();
  const url = `https://github.com/${GITHUB_REPO}/releases/download/v${latest}/${artifact}`;
  const tmp = `${tmpdir()}/icloud-backup-upgrade-${Date.now()}`;
  const target = process.execPath;

  console.log(pc.dim(`Downloading ${url}`));
  const res = await fetch(url);
  if (!res.ok) {
    console.error(pc.red(`Failed to download binary: HTTP ${res.status}`));
    return false;
  }
  await Bun.write(tmp, await res.arrayBuffer());

  const chmod = await run(["chmod", "+x", tmp]);
  if (chmod.exitCode !== 0) {
    await safeUnlink(tmp);
    console.error(pc.red(`chmod failed: ${chmod.stderr}`));
    return false;
  }

  let mv = await run(["mv", tmp, target]);
  if (mv.exitCode !== 0) {
    console.log(pc.dim("Requires elevated permissions..."));
    mv = await run(["sudo", "mv", tmp, target]);
  }
  if (mv.exitCode !== 0) {
    await safeUnlink(tmp);
    console.error(pc.red(`Failed to install binary: ${mv.stderr}`));
    return false;
  }

  await clearUpdateCache();
  console.log(pc.green(`Upgraded to v${latest}`));
  return true;
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {}
}
