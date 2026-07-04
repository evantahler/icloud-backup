import pc from "picocolors";
import { createUpdater } from "upgradr";
import pkg from "../package.json" with { type: "json" };
import { ENV_NO_UPDATE_CHECK, STATE_DIR, UPDATE_CHECK_TIMEOUT_MS } from "./constants.ts";

const repo = pkg.repository.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");

// The published command name (package.json `bin` key) is the single source of
// truth for both the release-asset prefix (icloud-backup-darwin-arm64/-x64) and
// the name shown in notices — deriving it here keeps them from drifting.
const binName = Object.keys(pkg.bin)[0];
if (!binName) throw new Error("package.json `bin` must define the CLI name");

/**
 * The self-updater, backed by the `upgradr` package. Owns the npm version check,
 * GitHub-releases changelog, install-method detection, the 24h `update.json`
 * cache (in `STATE_DIR`), and the in-place binary swap. Presentation lives in the
 * `check-update` / `upgrade` commands and the background notice call site — this
 * module is just the configured instance.
 */
export const updater = createUpdater({
  currentVersion: pkg.version,
  packageName: pkg.name,
  repo,
  binaryName: binName,
  cacheDir: STATE_DIR, // ~/.icloud-backup → update.json
  cliName: binName,
  noUpdateCheckEnv: ENV_NO_UPDATE_CHECK,
  // Our entry is src/index.ts, not upgradr's default src/cli.ts. Without this,
  // `bun run dev` would be misdetected as an npm/binary install.
  localDevEntry: "src/index.ts",
  timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
  onProgress: (m) => console.log(pc.dim(m)),
});
