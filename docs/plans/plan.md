# icloud-backup — Bun CLI

## Context

A small **manually-invoked, append-only backup CLI** that copies your iCloud-synced data onto any locally-mounted directory. Distributed as a Bun package — invoke with `bunx icloud-backup`. Each service flag takes its own destination so you can fan out to different drives if you want.

Four services:
- **Photos** (originals + JSON metadata sidecars)
- **Drive** — iCloud Drive Desktop & Documents
- **Notes** (markdown + attachments)
- **Contacts** (vCard or JSON per contact, vCard default)

Two foundations make this clean:
1. **`macos-ts`** — your TypeScript library at `~/workspace/macos-ts/`. Direct SQLite reads of Photos / Notes / Contacts. No `osxphotos`, no AppleScript, no network calls. We own the iteration loops, so totals are known up-front.
2. **`bun:sqlite`-backed manifests** in `~/.icloud-backup/`. We track what's been copied and decide what's new ourselves. All file I/O uses `Bun.file` / `Bun.write` — **no rsync**.

## CLI

```
icloud-backup [options]

Service flags (each takes a destination directory):
  --photos    <path>     back up Photos library originals → <path>/photos/
  --drive     <path>     back up iCloud Drive Desktop & Documents → <path>/drive/
  --notes     <path>     back up Apple Notes as markdown → <path>/notes/
  --contacts  <path>     back up Apple Contacts → <path>/contacts/  (--format vcard|json, default vcard)
  --all       <path>     shorthand for all four → <path>/{photos,drive,notes,contacts}/

Other:
  --doctor               run preflight checks and exit
  --rebuild              walk destinations and rebuild manifests
  --no-manifest-snapshot skip writing .manifest.sqlite/.json next to backed-up data
  --check-update         force a fresh npm-registry check, print result, exit
  --upgrade              upgrade to the latest published version (in-place)
  --help, -h
  --version, -v

Environment:
  ICLOUD_BACKUP_NO_UPDATE_CHECK=1   suppress the background "update available" notice

Examples:
  bunx @evantahler/icloud-backup --all /Volumes/icloud-backup-evan
  icloud-backup --photos /Volumes/photos-ssd --notes /Volumes/cloud-docs
  icloud-backup --all /Volumes/main --photos /Volumes/photo-archive   # photos override
  icloud-backup --upgrade
```

Per-service flag wins over `--all` for that service. At least one service flag (or one of `--doctor`/`--rebuild`/`--upgrade`/`--check-update`) is required.

State (manifests, lock, update cache) always lives at **`~/.icloud-backup/`**, regardless of where the actual files are written. Keeps SQLite local (fast), independent of slow destinations, and survives destinations being unmounted.

## UX target

```
┌────────────────────────────────────────────────────────────────────────┐
│ icloud-backup                                                           │
├────────────────────────────────────────────────────────────────────────┤
│ Photos    │ ████████████░░░░░░░░░  54% │  6,712/12,341 │ 14.2/26.1 GB │
│           │ 2024/05/IMG_4823.HEIC                                       │
│                                                                        │
│ Drive     │ ███████████████████░░  87% │     421/  483 │  1.8/ 2.1 GB │
│           │ Documents/Taxes/2024/W2.pdf                                 │
│                                                                        │
│ Notes     │ ███████████░░░░░░░░░░  48% │     118/  243 │   3.1/ 6.4 MB │
│           │ Personal/Recipes/Pizza dough.md                             │
│                                                                        │
│ Contacts  │ ████████████████████░  96% │     487/  503 │ 412/ 428 KB  │
│           │ Jane Doe.vcf                                                │
└────────────────────────────────────────────────────────────────────────┘
elapsed 3m 42s · ETA 1m 18s
```

Only the lanes that were actually selected by flags appear. On completion, bars freeze at 100% and a summary table prints.

## Architecture

```
bunx icloud-backup --photos <P> --drive <D> --notes <N> --contacts <C>
   │
   ├──► Photos    ──► macos-ts Photos:   iterate → diff manifest → Bun.write → JSON sidecar  → <P>/photos/
   ├──► Drive     ──► Bun.Glob walk:     brctl download → stat → diff manifest → Bun.write   → <D>/drive/
   ├──► Notes     ──► macos-ts Notes:    iterate → diff manifest → write .md + attachments   → <N>/notes/
   └──► Contacts  ──► macos-ts Contacts: iterate → diff manifest (sha256) → write .vcf|.json  → <C>/contacts/

State (always local):
  ~/.icloud-backup/
    ├── manifests/{photos,drive,notes,contacts}.sqlite
    ├── icloud-backup.lock
    └── logs/<timestamp>.log

Snapshot at end of each lane (atomic, one write per lane):
  <dest>/<lane>/.manifest.sqlite     # copy of the local manifest as of run completion
  <dest>/<lane>/.manifest.json       # human-readable export of entries
```

Each lane is an `async function* (cfg, dest): AsyncIterable<ProgressEvent>` yielding:

```ts
type ProgressEvent =
  | { type: 'phase';  label: string }
  | { type: 'total';  files: number; bytes?: number }
  | { type: 'file';   name: string; bytesDelta: number; index: number }
  | { type: 'log';    level: 'info'|'warn'; message: string }
  | { type: 'done';   filesTransferred: number; bytesTransferred: number };
```

Selected lanes run with `Promise.allSettled`; events feed a `cli-progress` multibar.

## Versioning, distribution & auto-upgrade

Modeled on `~/workspace/mcpx`'s release pipeline. Three install paths, all driven from a single GitHub Actions workflow:

| Method        | How user installs                                                | How `--upgrade` works                            |
|---------------|------------------------------------------------------------------|--------------------------------------------------|
| `bun` global  | `bun install -g @evantahler/icloud-backup`                       | `bun install -g @evantahler/icloud-backup@<new>` |
| `npm` global  | `npm install -g @evantahler/icloud-backup`                       | `npm install -g @evantahler/icloud-backup@<new>` |
| `binary`      | curl from GitHub releases (`icloud-backup-darwin-{arm64,x64}`)   | download new binary, `mv` into `process.execPath`, sudo fallback |
| `local-dev`   | `bun link` from `~/workspace/icloud-backup`                             | print "use `git pull && bun install`"            |

**Platform scope:** macOS-only. `macos-ts` reads macOS-specific SQLite databases and we shell out to `brctl`. So the auto-release workflow builds **only `darwin-arm64` and `darwin-x64`** binaries — no linux/windows. The npm package itself runs anywhere Bun runs, but actually invoking it on non-macOS errors out at the doctor step.

### Version detection

`--version` reads `version` from `package.json` (Bun supports JSON imports natively):
```ts
import pkg from "../package.json";
console.log(pkg.version);
```

### Update check (background notice)

On every regular run (not on `--upgrade`/`--check-update`/non-TTY/explicit opt-out), we do a non-blocking npm registry check:

1. Read `~/.icloud-backup/update.json` cache; if `lastCheckAt < 24h ago`, use cached result.
2. Otherwise, `fetch("https://registry.npmjs.org/@evantahler/icloud-backup/latest")` with a short timeout (3s, abort on signal).
3. Compare via `Bun.semver.order(current, latest)`.
4. If newer is available, fetch GitHub releases changelog between the two versions, save to cache, print a yellow notice on stderr **after** the backup completes (so it doesn't fight the TUI).
5. Failures are silent — never blocks or errors the actual backup.

`--check-update` forces a fresh check and prints the result regardless of cache.

### `--upgrade` command

Detects install method by inspecting `process.argv[1]` and `process.execPath`:

```ts
function detectInstallMethod(): "npm" | "bun" | "binary" | "local-dev" {
  const script = process.argv[1] ?? "";
  const execPath = process.execPath;
  if (script.includes("src/index.ts") && !script.includes("node_modules")) return "local-dev";
  if (!execPath.includes("bun") && !execPath.includes("node")) return "binary";
  if (script.includes(".bun/install") || script.includes(".bun/bin")) return "bun";
  return "npm";
}
```

Then dispatches:
- **bun/npm**: `Bun.$\`bun install -g @evantahler/icloud-backup@${latest}\`` (or `npm`).
- **binary**: download `https://github.com/evantahler/icloud-backup/releases/download/v${latest}/icloud-backup-${platform}-${arch}`, `chmod +x`, `mv` into `process.execPath`. On EACCES, retry with `sudo mv`.
- **local-dev**: print *"Running from source. Use `git pull && bun install` to update."*

After successful upgrade: `clearUpdateCache()` so the next run revalidates.

### Auto-release pipeline (`.github/workflows/auto-release.yml`)

Identical structure to mcpx's:

1. **`check-version`** — read `version` from `package.json`, check if `gh release view v$VERSION` already exists. Output `should_release` boolean.
2. **`create-release`** — if `should_release`, `gh release create v$VERSION --generate-notes`.
3. **`ci`** — `bun install --frozen-lockfile`, `bun lint`, `bun test`. Must pass before publish/binaries.
4. **`publish-npm`** — `npm publish --provenance --access public`. Requires `id-token: write` permission for SLSA provenance attestation. (Use a scoped name `@evantahler/icloud-backup` so npm's free public-package rules apply.)
5. **`build-binaries`** — matrix over `bun-darwin-arm64` and `bun-darwin-x64`. For each:
   ```
   bun build --compile --minify --sourcemap \
     --target=bun-darwin-arm64 ./src/index.ts \
     --outfile dist/icloud-backup-darwin-arm64
   gh release upload v$VERSION dist/icloud-backup-darwin-arm64 --clobber
   ```

Triggering a release: bump `version` in `package.json`, commit, push to `main`. Workflow does the rest.

## Resume & incremental detection (the manifest)

One SQLite manifest per lane at `~/.icloud-backup/manifests/<lane>.sqlite`:

```sql
CREATE TABLE entries (
  source_id     TEXT PRIMARY KEY,   -- photos/notes/contacts: db row id; drive: relative path
  dest_path     TEXT NOT NULL,      -- absolute path within the lane's destination
  source_key    TEXT NOT NULL,      -- mtime|size for drive/photos; modifiedAt for notes; sha256 for contacts
  size_bytes    INTEGER NOT NULL,
  backed_up_at  INTEGER NOT NULL,   -- ms epoch
  version       INTEGER DEFAULT 1   -- bumped each time we archive a prior copy
);
CREATE INDEX entries_dest ON entries(dest_path);
```

Per-lane decision rule:

| Lane     | `source_key` we compute       | Action if `manifest.source_key !== current`                    |
|----------|-------------------------------|----------------------------------------------------------------|
| Photos   | `${modifiedAt}|${size}`       | move existing dest → `<dest>/_overwritten/<date>/v<n>/`, copy fresh |
| Drive    | `${mtime}|${size}`            | move existing dest → `<dest>/_overwritten/<date>/v<n>/`, copy fresh |
| Notes    | `${modifiedAt}`               | move existing `.md` → `<dest>/_overwritten/<date>/v<n>/`, write fresh |
| Contacts | `sha256(JSON.stringify(...))` | move existing `.vcf`/`.json` → `<dest>/_overwritten/<date>/v<n>/`, write fresh (also re-emitted on a `--format` switch since `dest_path` changes) |

Why this works:
- **Crash mid-run:** writes are atomic (write-to-tmp, fsync, rename). Manifest upsert is the *last* step per file. Crash before upsert → next run sees no entry → re-copies. Idempotent.
- **Lost manifest** (new laptop, disk reformat): `bunx icloud-backup --rebuild --all <path>` walks destinations and reconstructs manifests from `dest_path` + stat.
- **Append-only:** never write on top of an existing dest without first archiving it.
- **Destination changes:** if you move from `/Volumes/A` to `/Volumes/B` and re-run, the manifest's `dest_path` won't match the new dest — the file gets re-copied (one-time cost). To avoid that, run `--rebuild` after the move.

We don't sha256 every file (too expensive for a photo library). Stat-based diff is enough except for Contacts where `modifiedAt` isn't reliable.

### Destination-side manifest snapshots

The authoritative manifest stays at `~/.icloud-backup/manifests/<lane>.sqlite` (local-fast, survives unmounted destinations). At the **end of each lane** we also drop a frozen copy of that manifest next to the data:

```
<dest>/<lane>/.manifest.sqlite     # binary copy of the local manifest
<dest>/<lane>/.manifest.json       # JSON export of entries[]
```

Why end-of-run only (not dual-write during the lane):
- Destinations can be SMB / USB / external SSDs. SQLite on those is slow and prone to lock issues — that's why state is local in the first place.
- One `Bun.write` per lane (atomic write-to-tmp + rename) is essentially free, even on slow destinations.
- The snapshot is *frozen at completion*. If the run crashes mid-lane the local manifest is still authoritative; the previous snapshot stays untouched.

Behavior:
- Always-on for successful lanes. If a lane is `rejected` (allSettled), we skip overwriting the previous snapshot — better to keep a stale-but-complete snapshot than a partial one. (Future: a `partial: true` sidecar if we want to surface this.)
- Atomic: write `.manifest.sqlite.tmp` then rename. Same for `.json`.
- The `.json` export mirrors the `entries` table columns plus a top-level `{ lane, version, generatedAt, count }` header for human inspection.
- Hidden filenames (leading `.`) so they don't clutter directory listings — and the lane scanners explicitly skip `.manifest.*` when walking destinations.

What this buys us:
- **Fast disaster recovery.** If `~/.icloud-backup/` is lost (laptop dies, fresh OS), we can rehydrate the local manifests by *importing* the snapshots — O(entries) read, vs `--rebuild`'s O(files) walk + stat of the entire destination tree. On a multi-TB photo library this is the difference between seconds and tens of minutes.
- **Portability across machines.** Point a new machine at the same destination, import the snapshots, resume. One run of staleness is fine — diffs are idempotent.
- **Audit trail.** The `.json` is grep-able next to the data without `sqlite3`.

Startup behavior (lane bootstrap):
1. If `~/.icloud-backup/manifests/<lane>.sqlite` exists → use it (today's behavior).
2. Else if `<dest>/<lane>/.manifest.sqlite` exists → copy it into `~/.icloud-backup/manifests/<lane>.sqlite` and proceed (log: *"restored manifest from destination snapshot"*).
3. Else fall back to either an empty manifest (first run) or `--rebuild` if the user passed it.

Escape hatch: `--no-manifest-snapshot` skips the snapshot write. Off by default; only useful if the destination has a hard reason to reject hidden files (legacy filesystems, pedantic sync tools).

## Filename sanitization

**Policy: destinations target the SMB lowest-common-denominator, not APFS.** A backup that succeeds on a local disk should also succeed when the same destination is moved to a NAS share. Rather than per-filesystem branching, every destination path goes through the same sanitizer.

| Constraint                          | SMB (worst-case observed)        | APFS / HFS+ |
|-------------------------------------|----------------------------------|-------------|
| Filename byte length per component  | **143 bytes** (HVTVault probe)\* | 255 bytes   |
| Total path length                   | 1024 bytes (PATH_MAX)            | 1024 bytes  |
| Trailing dot or space in name       | rejected                         | allowed     |
| Reserved chars (`\ : * ? " < > \|`) | rejected                         | allowed     |
| Filename encoding                   | NFC (UTF-16 on the wire)         | NFD         |
| Leading dot                         | allowed but hides on Unix        | allowed     |

\* The 143-byte ceiling is server-specific. macOS `smbfs` against a Samba server advertises NAME_MAX=255 via `pathconf` but actual writes can fail far below that — we've observed 143 bytes on HVTVault, and other deployments cap at 255 UTF-16 chars. We don't trust `pathconf`.

**`sanitizeFilename(name, { maxBytes })`** in `src/fsutil.ts` does the per-component work: NFC normalization, reserved-char substitution, trailing-dot strip, byte-cap truncation on a UTF-8 codepoint boundary. **`sanitizeRelativePath(rel, maxBytes)`** runs it per segment with separators preserved.

**`probeMaxFilenameBytes(dir)`** binary-searches the destination at lane startup to find the actual per-component byte limit (writes `.<sessionId>-<aaa...>` probe files in the lane root, unlinks them on the way out). Each lane derives `nameCap = min(probed - laneReserve, 200)`:

| Lane     | Lane reserve                                              |
|----------|-----------------------------------------------------------|
| Drive    | `TEMP_SUFFIX_BYTES` (atomicCopy temp file)                |
| Photos   | `TEMP_SUFFIX_BYTES + 5` (also writes `<base>.json`)       |
| Notes    | `TEMP_SUFFIX_BYTES + len(".attachments")`                 |
| Contacts | `TEMP_SUFFIX_BYTES` (the `-<id>.<ext>` suffix is reserved separately from the title cap) |

Default fallback is `DEFAULT_MAX_FILENAME_BYTES` (200) when the probe can't run (perm denied, dir missing). Don't loosen sanitization without keeping the probe — `pathconf` lies.

## Project layout: `~/workspace/icloud-backup/`

```
~/workspace/icloud-backup/
├── package.json              # @evantahler/icloud-backup; bin: ./src/index.ts
├── tsconfig.json
├── bunfig.toml
├── .gitignore                # node_modules, *.log, dist/
├── README.md
├── install.sh                # one-liner installer that downloads the right binary
├── .github/
│   └── workflows/
│       ├── auto-release.yml  # version-bump-triggered release: npm + binaries
│       └── ci.yml            # lint + test on PRs
└── src/
    ├── index.ts              # #!/usr/bin/env bun — argv parse, dispatch lanes
    ├── cli.ts                # parseArgs wrapper, --help output
    ├── config.ts             # resolves state dir, validates dests
    ├── tasks/
    │   ├── photos.ts         # generator: macos-ts Photos → diff → atomicCopy
    │   ├── drive.ts          # generator: brctl + Bun.Glob walk → diff → atomicCopy
    │   ├── notes.ts          # generator: macos-ts Notes → diff → write .md + attachments
    │   └── contacts.ts       # generator: macos-ts Contacts → sha256 diff → write .json
    ├── update/
    │   ├── checker.ts        # fetchLatestVersion, isNewerVersion, detectInstallMethod
    │   ├── cache.ts          # ~/.icloud-backup/update.json load/save/clear
    │   └── background.ts     # non-blocking notice, prints after backup
    ├── commands/
    │   ├── upgrade.ts        # --upgrade dispatch (npm / bun / binary / local-dev)
    │   └── check-update.ts   # --check-update forced check + print
    ├── manifest.ts           # bun:sqlite wrapper + rebuild() + snapshot()/restoreFromSnapshot()
    ├── copier.ts             # atomicCopy, atomicWrite, archiveOverwrite
    ├── walker.ts             # Bun.Glob recursive scan with stat + exclusions
    ├── spawn.ts              # Bun.spawn helper (brctl only)
    ├── tui.ts                # cli-progress multibar
    ├── lock.ts               # single-instance lockfile (O_EXCL)
    ├── fsutil.ts             # sanitizeFilename, fileUrlToPath, mkdirp, sha256
    └── doctor.ts             # preflight checks (invoked by --doctor)
```

### `package.json`

```json
{
  "name": "@evantahler/icloud-backup",
  "version": "0.1.0",
  "description": "Append-only backup of iCloud Photos, Drive, Notes, and Contacts to any local directory.",
  "type": "module",
  "bin": { "icloud-backup": "./src/index.ts" },
  "files": ["src/", "README.md", "LICENSE"],
  "scripts": {
    "dev":    "bun src/index.ts",
    "test":   "bun test",
    "lint":   "prettier --check .",
    "format": "prettier --write .",
    "build":  "bun build --compile --minify --sourcemap ./src/index.ts --outfile dist/icloud-backup"
  },
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "https://github.com/evantahler/icloud-backup.git" },
  "keywords": ["icloud", "backup", "photos", "notes", "contacts", "macos"],
  "author": "Evan Tahler",
  "license": "MIT",
  "dependencies": {
    "macos-ts": "file:../macos-ts",
    "cli-progress": "^3",
    "picocolors": "^1",
    "zod": "^3"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/cli-progress": "^3",
    "prettier": "^3",
    "typescript": "^5"
  },
  "engines": { "bun": ">=1.1" }
}
```

`src/index.ts` starts with `#!/usr/bin/env bun` so it's directly executable. Local development: `bun link` from `~/workspace/icloud-backup` → `icloud-backup` resolves globally. Publishing: bump `version` and push to `main` — the auto-release workflow handles npm + binaries.

### Module sketches

**`src/cli.ts`** — argv parsing via Node's built-in `util.parseArgs` (works in Bun, no dep):
```ts
import { parseArgs } from "util";
export function parse(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      photos:   { type: "string" },
      drive:    { type: "string" },
      notes:    { type: "string" },
      contacts: { type: "string" },
      all:      { type: "string" },
      doctor:   { type: "boolean" },
      rebuild:  { type: "boolean" },
      "no-manifest-snapshot": { type: "boolean" },
      help:     { type: "boolean", short: "h" },
      version:  { type: "boolean", short: "v" },
    },
    strict: true,
  });
  // Resolve per-service destinations, with --all as fallback
  const lanes: { service: 'photos'|'drive'|'notes'|'contacts'; dest: string }[] = [];
  for (const s of ['photos','drive','notes','contacts'] as const) {
    const dest = values[s] ?? values.all;
    if (dest) lanes.push({ service: s, dest });
  }
  return {
    lanes,
    doctor: !!values.doctor,
    rebuild: !!values.rebuild,
    snapshot: !values["no-manifest-snapshot"],   // default true
    help: !!values.help,
    version: !!values.version,
  };
}
```

**`src/index.ts`**
```ts
#!/usr/bin/env bun
import pkg from "../package.json";
import { parse } from "./cli";
import { runUpgrade } from "./commands/upgrade";
import { runCheckUpdate } from "./commands/check-update";
import { maybeCheckForUpdate } from "./update/background";

const flags = parse(process.argv.slice(2));
if (flags.help)         { printHelp(); process.exit(0); }
if (flags.version)      { console.log(pkg.version); process.exit(0); }
if (flags.checkUpdate)  { process.exit(await runCheckUpdate() ? 0 : 1); }
if (flags.upgrade)      { process.exit(await runUpgrade() ? 0 : 1); }
if (flags.doctor)       { process.exit(await runDoctor(flags.lanes) ? 0 : 1); }
if (flags.rebuild)      { await runRebuild(flags.lanes); process.exit(0); }
if (flags.lanes.length === 0) { printHelp(); process.exit(2); }

await acquireLock(`${HOME}/.icloud-backup/icloud-backup.lock`);

// Kick off non-blocking update check; surface the notice after the backup completes.
const updateNoticePromise = maybeCheckForUpdate();

// Bootstrap: if local manifest is missing, hydrate from any destination snapshot.
for (const l of flags.lanes) {
  if (await Manifest.restoreFromSnapshot(l.service, l.dest)) {
    console.log(`Restored ${l.service} manifest from ${l.dest}/${l.service}/.manifest.sqlite`);
  }
}

const tui = createTui(flags.lanes.map(l => l.service));
const taskFns = { photos: runPhotos, drive: runDrive, notes: runNotes, contacts: runContacts };
const results = await Promise.allSettled(
  flags.lanes.map(l =>
    consume(l.service, taskFns[l.service]({ dest: l.dest, snapshot: flags.snapshot }), tui)
  )
);
tui.stop();
printSummary(results);

const notice = await updateNoticePromise;
if (notice) process.stderr.write(notice);

process.exit(results.some(r => r.status === 'rejected') ? 1 : 0);
```

**`src/update/checker.ts`** — adapted from mcpx:
```ts
import pkg from "../../package.json";
const NPM_URL = `https://registry.npmjs.org/${pkg.name}/latest`;
const GH_REPO = pkg.repository.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");

export function isNewerVersion(cur: string, latest: string): boolean {
  return Bun.semver.order(cur, latest) === -1;
}
export async function fetchLatestVersion(signal?: AbortSignal): Promise<string> {
  try {
    const res = await fetch(NPM_URL, { signal });
    if (!res.ok) return pkg.version;
    return ((await res.json()) as { version: string }).version;
  } catch { return pkg.version; }
}
export async function fetchChangelog(from: string, to: string, signal?: AbortSignal): Promise<string | undefined> {
  // GET https://api.github.com/repos/${GH_REPO}/releases?per_page=20, filter by tag_name in (from, to], join bodies.
}
export type InstallMethod = "npm" | "bun" | "binary" | "local-dev";
export function detectInstallMethod(): InstallMethod {
  const script = process.argv[1] ?? "";
  const exec = process.execPath;
  if (script.includes("src/index.ts") && !script.includes("node_modules")) return "local-dev";
  if (!exec.includes("bun") && !exec.includes("node")) return "binary";
  if (script.includes(".bun/install") || script.includes(".bun/bin")) return "bun";
  return "npm";
}
```

**`src/update/cache.ts`** — `~/.icloud-backup/update.json`:
```ts
const CACHE = `${process.env.HOME}/.icloud-backup/update.json`;
export interface UpdateCache { lastCheckAt: string; latestVersion: string; hasUpdate: boolean; changelog?: string; }
export async function loadUpdateCache(): Promise<UpdateCache | undefined> { /* read JSON, swallow errors */ }
export async function saveUpdateCache(c: UpdateCache): Promise<void>     { /* write JSON, swallow errors */ }
export async function clearUpdateCache(): Promise<void>                  { /* unlink if exists */ }
export function needsCheck(cache?: UpdateCache, ttlMs = 24 * 60 * 60 * 1000): boolean {
  return !cache?.lastCheckAt || Date.now() - new Date(cache.lastCheckAt).getTime() > ttlMs;
}
```

**`src/update/background.ts`** — non-blocking notice:
```ts
export async function maybeCheckForUpdate(): Promise<string | null> {
  if (process.env.ICLOUD_BACKUP_NO_UPDATE_CHECK === "1") return null;
  if (!process.stderr.isTTY) return null;

  const cache = await loadUpdateCache();
  if (!needsCheck(cache)) {
    return cache?.hasUpdate ? formatNotice(pkg.version, cache.latestVersion, cache.changelog) : null;
  }
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 3000);
  try {
    const latest = await fetchLatestVersion(ctrl.signal);
    const hasUpdate = isNewerVersion(pkg.version, latest);
    const changelog = hasUpdate ? await fetchChangelog(pkg.version, latest, ctrl.signal) : undefined;
    await saveUpdateCache({ lastCheckAt: new Date().toISOString(), latestVersion: latest, hasUpdate, changelog });
    return hasUpdate ? formatNotice(pkg.version, latest, changelog) : null;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}
```

**`src/commands/upgrade.ts`** — adapted from mcpx, dispatching by install method:
```ts
export async function runUpgrade(): Promise<boolean> {
  const cache = await loadUpdateCache();
  const latest = !needsCheck(cache) && cache ? cache.latestVersion : await fetchLatestVersion();
  if (!isNewerVersion(pkg.version, latest)) {
    console.log(green(`icloud-backup is already up to date (v${pkg.version})`)); return true;
  }
  const method = detectInstallMethod();
  switch (method) {
    case "bun":      return shell(`bun install -g ${pkg.name}@${latest}`).then(ok => { ok && clearUpdateCache(); return ok; });
    case "npm":      return shell(`npm install -g ${pkg.name}@${latest}`).then(ok => { ok && clearUpdateCache(); return ok; });
    case "binary":   return upgradeBinary(latest);  // download GH release artifact, mv into process.execPath, sudo fallback
    case "local-dev":console.log(yellow("Running from source. Use `git pull && bun install`.")); return false;
  }
}
function platformArtifact() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `icloud-backup-darwin-${arch}`;       // macOS-only
}
async function upgradeBinary(latest: string): Promise<boolean> {
  const url = `https://github.com/evantahler/icloud-backup/releases/download/v${latest}/${platformArtifact()}`;
  const tmp = `${tmpdir()}/icloud-backup-upgrade-${Date.now()}`;
  await Bun.write(tmp, await (await fetch(url)).arrayBuffer());
  await Bun.$`chmod +x ${tmp}`;
  const mv = await Bun.$`mv ${tmp} ${process.execPath}`.nothrow();
  if (mv.exitCode !== 0) await Bun.$`sudo mv ${tmp} ${process.execPath}`;
  return true;
}
```

**`src/commands/check-update.ts`** — forced check, prints + exits:
```ts
export async function runCheckUpdate(): Promise<boolean> {
  const latest = await fetchLatestVersion();
  const hasUpdate = isNewerVersion(pkg.version, latest);
  await saveUpdateCache({ lastCheckAt: new Date().toISOString(), latestVersion: latest, hasUpdate });
  if (!hasUpdate) { console.log(green(`Up to date (v${pkg.version})`)); return true; }
  console.log(yellow(`Update available: v${pkg.version} → v${latest}`));
  console.log(cyan(`Run \`icloud-backup --upgrade\` to install`));
  return true;
}
```

**`src/manifest.ts`** — `bun:sqlite` wrapper:
```ts
import { Database } from "bun:sqlite";
const STATE_DIR = `${process.env.HOME}/.icloud-backup`;
export class Manifest {
  private db: Database;
  constructor(lane: 'photos'|'drive'|'notes'|'contacts') {
    fs.mkdirSync(`${STATE_DIR}/manifests`, { recursive: true });
    this.db = new Database(`${STATE_DIR}/manifests/${lane}.sqlite`, { create: true });
    this.db.run(`CREATE TABLE IF NOT EXISTS entries (
      source_id TEXT PRIMARY KEY, dest_path TEXT NOT NULL, source_key TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, backed_up_at INTEGER NOT NULL, version INTEGER DEFAULT 1)`);
  }
  get(id: string)  { return this.db.query("SELECT * FROM entries WHERE source_id=?").get(id); }
  upsert(e: Entry) { this.db.run("INSERT INTO entries (...) VALUES (...) ON CONFLICT(source_id) DO UPDATE SET ...", [...]); }
  close()          { this.db.close(); }

  // End-of-run snapshot: copy the .sqlite + JSON export into <dest>/<lane>/.
  async snapshot(lane: string, dest: string): Promise<void> {
    const laneDir = `${dest}/${lane}`;
    await mkdirp(laneDir);
    // 1) Binary copy via Bun.write (atomic: tmp + rename).
    const sqliteSrc = `${STATE_DIR}/manifests/${lane}.sqlite`;
    const sqliteDst = `${laneDir}/.manifest.sqlite`;
    const sqliteTmp = `${sqliteDst}.tmp.${process.pid}.${Date.now()}`;
    await Bun.write(sqliteTmp, Bun.file(sqliteSrc));
    await fs.rename(sqliteTmp, sqliteDst);
    // 2) JSON export with header for humans/grep.
    const rows = this.db.query("SELECT * FROM entries").all();
    const json = { lane, generatedAt: new Date().toISOString(), count: rows.length, entries: rows };
    const jsonDst = `${laneDir}/.manifest.json`;
    const jsonTmp = `${jsonDst}.tmp.${process.pid}.${Date.now()}`;
    await Bun.write(jsonTmp, JSON.stringify(json, null, 2));
    await fs.rename(jsonTmp, jsonDst);
  }

  // Bootstrap: if local manifest is missing but destination has a snapshot, hydrate from it.
  static async restoreFromSnapshot(lane: string, dest: string): Promise<boolean> {
    const localPath = `${STATE_DIR}/manifests/${lane}.sqlite`;
    if (await Bun.file(localPath).exists()) return false;
    const snap = `${dest}/${lane}/.manifest.sqlite`;
    if (!(await Bun.file(snap).exists())) return false;
    fs.mkdirSync(`${STATE_DIR}/manifests`, { recursive: true });
    await Bun.write(localPath, Bun.file(snap));
    return true;
  }
}
```

**`src/copier.ts`** — atomic copy/write + overwrite archive:
```ts
export async function atomicCopy(src: string, dest: string): Promise<number> {
  await mkdirp(dirname(dest));
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  const bytes = await Bun.write(tmp, Bun.file(src));   // streams large files
  await fs.rename(tmp, dest);
  return bytes;
}
export async function atomicWrite(dest: string, content: string | Uint8Array): Promise<number> { /* same shape */ }
export async function archiveOverwrite(dest: string, version: number, root: string): Promise<void> {
  if (!(await Bun.file(dest).exists())) return;
  const today = new Date().toISOString().slice(0, 10);
  const archived = join(root, '_overwritten', today, `v${version}`, basename(dest));
  await mkdirp(dirname(archived));
  await fs.rename(dest, archived);
}
```

**`src/tasks/photos.ts`** (cfg = `{ dest: string }`)
```ts
import { Photos } from "macos-ts";
export async function* runPhotos({ dest }: TaskCfg) {
  const db = new Photos();
  const mf = new Manifest('photos');
  const all = db.photos();
  yield { type: 'total', files: all.length };
  for (const [i, p] of all.entries()) {
    const { url, locallyAvailable } = db.getPhotoUrl(p.id);
    if (!locallyAvailable) {
      yield { type: 'log', level: 'warn', message: `iCloud-only, skipped: ${p.filename}` };
      yield tickEvent(i, p.filename, 0); continue;
    }
    const src = fileUrlToPath(url);
    const stat = await Bun.file(src).stat();
    const sourceKey = `${p.modifiedAt}|${stat.size}`;
    const existing = mf.get(p.id);
    const out = `${dest}/photos/${p.created.year}/${pad(p.created.month)}/${p.filename}`;
    if (existing && existing.source_key === sourceKey) { yield tickEvent(i, p.filename, 0); continue; }
    if (existing) await archiveOverwrite(existing.dest_path, existing.version, dest);
    const bytes = await atomicCopy(src, out);
    await Bun.write(`${out}.json`, JSON.stringify(db.getPhoto(p.id), null, 2));
    await maybeCopyLivePhotoMov(src, out);
    mf.upsert({ source_id: p.id, source_key: sourceKey, dest_path: out, size_bytes: bytes, backed_up_at: Date.now(), version: (existing?.version ?? 0) + 1 });
    yield { type: 'file', name: relative(dest, out), bytesDelta: bytes, index: i + 1 };
  }
  if (cfg.snapshot !== false) await mf.snapshot('photos', dest);
  mf.close(); db.close();
}
```

**`src/tasks/drive.ts`** (no rsync — Bun walk + atomicCopy)
```ts
import { Glob } from "bun";
export async function* runDrive({ dest }: TaskCfg) {
  yield { type: 'phase', label: 'materializing' };
  await Bun.spawn(['brctl', 'download', `${HOME}/Desktop`]).exited;
  await Bun.spawn(['brctl', 'download', `${HOME}/Documents`]).exited;

  yield { type: 'phase', label: 'scanning' };
  const mf = new Manifest('drive');
  const files: { src: string; rel: string; mtime: number; size: number }[] = [];
  for (const root of ['Desktop', 'Documents']) {
    for await (const rel of new Glob('**/*').scan({ cwd: `${HOME}/${root}`, onlyFiles: true, dot: false })) {
      if (rel.endsWith('.DS_Store') || rel.includes('/.Trash/')) continue;
      const src = `${HOME}/${root}/${rel}`;
      const st = await Bun.file(src).stat();
      files.push({ src, rel: `${root}/${rel}`, mtime: Math.floor(st.mtimeMs), size: st.size });
    }
  }
  yield { type: 'total', files: files.length, bytes: files.reduce((s,f)=>s+f.size,0) };

  yield { type: 'phase', label: 'transferring' };
  for (const [i, f] of files.entries()) {
    const sourceKey = `${f.mtime}|${f.size}`;
    const existing = mf.get(f.rel);
    const out = `${dest}/drive/${f.rel}`;
    if (existing && existing.source_key === sourceKey) { yield tickEvent(i, f.rel, 0); continue; }
    if (existing) await archiveOverwrite(existing.dest_path, existing.version, dest);
    const bytes = await atomicCopy(f.src, out);
    mf.upsert({ source_id: f.rel, source_key: sourceKey, dest_path: out, size_bytes: bytes, backed_up_at: Date.now(), version: (existing?.version ?? 0) + 1 });
    yield { type: 'file', name: f.rel, bytesDelta: bytes, index: i + 1 };
  }
  if (cfg.snapshot !== false) await mf.snapshot('drive', dest);
  mf.close();
}
```

**`src/tasks/notes.ts`** & **`src/tasks/contacts.ts`** follow the same shape as before — iterate macos-ts, diff manifest, archive on change, write fresh, upsert, then `mf.snapshot(lane, dest)` if `cfg.snapshot !== false`. Each writes under `<dest>/notes/...` or `<dest>/contacts/...`.

Note: lane scanners (the Drive walker in particular) must skip `.manifest.sqlite` and `.manifest.json` so they don't try to back up their own snapshot files.

**`src/tui.ts`** — `cli-progress.MultiBar` with N lanes (only the selected services). Format: `{lane} │ {bar} {percentage}% │ {value}/{total} │ {bytesFormatted} │ {filename}`. `picocolors` for color (yellow/cyan/magenta/green per lane).

**`src/lock.ts`** — `fs.openSync('~/.icloud-backup/icloud-backup.lock', 'wx')` with PID; reclaim if stale.

**`src/doctor.ts`** — runs when `--doctor` is passed:
- ✓/✗ `brctl` available (built into macOS)
- ✓/✗ Photos.app "Download Originals to this Mac" enabled
- ✓/✗ iCloud Drive Desktop & Documents enabled
- ✓/✗ **Full Disk Access**: open a `Notes` DB and read one row. On `DatabaseNotFoundError`, print *"Grant Full Disk Access to <terminal> in System Settings → Privacy & Security → Full Disk Access, then re-run."* (terminal name from `process.env.TERM_PROGRAM`).
- ✓/✗ `~/.icloud-backup/` exists and is writable.
- ✓/✗ For each service flag passed: destination exists, is a directory, is writable.

## Output layout

For `bunx icloud-backup --all /Volumes/icloud-backup-evan`:

```
/Volumes/icloud-backup-evan/
├── photos/
│   ├── .manifest.sqlite                       # frozen end-of-run snapshot
│   ├── .manifest.json                         # human-readable export
│   ├── 2024/01/IMG_0001.HEIC + IMG_0001.HEIC.json (+ IMG_0001.mov for Live Photos)
│   └── 2024/02/...
├── drive/
│   ├── .manifest.sqlite
│   ├── .manifest.json
│   ├── Desktop/...
│   └── Documents/...
├── notes/
│   ├── .manifest.sqlite
│   ├── .manifest.json
│   ├── Personal/Recipes/Pizza dough-12345.md
│   └── Work/Meetings/Q1 review-12350.md (+ Q1 review-12350.md.attachments/diagram.png)
├── contacts/
│   ├── .manifest.sqlite
│   ├── .manifest.json
│   ├── Jane Doe-42.vcf      # default (--format vcard)
│   └── John Smith-87.vcf    # (or *.json with --format json)
└── _overwritten/2026-04-25/v2/...
```

Per-service flags can split this across multiple drives — each destination gets its own `<service>/` subtree and its own `_overwritten/` archive.

## Prerequisites (one-time)

User-side:
1. Photos.app → Settings → iCloud → **Download Originals to this Mac**.
2. System Settings → Apple ID → iCloud → iCloud Drive → **Desktop & Documents Folders** = on.
3. **Full Disk Access** for your terminal app.
4. Mount your destination(s) at stable paths. Add to Login Items if it's a network share.

Install (any of):
- `bun install -g @evantahler/icloud-backup`
- `npm install -g @evantahler/icloud-backup`
- One-liner binary: `curl -fsSL https://raw.githubusercontent.com/evantahler/icloud-backup/main/install.sh | bash`
- Local dev: `cd ~/workspace/icloud-backup && bun install && bun link`

Repo-side (one-time, before first publish):
- Create empty GitHub repo `evantahler/icloud-backup`.
- Add `NPM_TOKEN` to GitHub Actions secrets (or rely entirely on `--provenance` + npm trusted publishers — preferred; no secret needed).
- Set npm package access: `@evantahler/icloud-backup` is a scoped public package; `publishConfig.access: "public"` handles it.

## Usage

```
$ icloud-backup --doctor
$ icloud-backup --all /Volumes/icloud-backup-evan
$ icloud-backup --notes /Volumes/cloud-docs --photos /Volumes/photo-archive
$ icloud-backup --rebuild --all /Volumes/icloud-backup-evan
$ icloud-backup --all /Volumes/icloud-backup-evan --no-manifest-snapshot
$ icloud-backup --version
$ icloud-backup --check-update
$ icloud-backup --upgrade
```

Or transient via `bunx`: `bunx @evantahler/icloud-backup --all /Volumes/...`

## Files to create

- `~/workspace/icloud-backup/package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `README.md`, `LICENSE`, `install.sh`
- `~/workspace/icloud-backup/.github/workflows/{auto-release,ci}.yml`
- `~/workspace/icloud-backup/src/{index,cli,config,manifest,copier,walker,spawn,tui,lock,fsutil,doctor}.ts`
- `~/workspace/icloud-backup/src/tasks/{photos,drive,notes,contacts}.ts`
- `~/workspace/icloud-backup/src/update/{checker,cache,background}.ts`
- `~/workspace/icloud-backup/src/commands/{upgrade,check-update}.ts`

User-side:
- Destination(s) mounted
- Full Disk Access granted to your terminal
- `bun link` run once in `~/workspace/icloud-backup`

## Verification

1. **`bunx icloud-backup --doctor`** — all green.
2. **First run:** `bunx icloud-backup --all /Volumes/icloud-backup-evan`. Confirm 4 parallel lanes tick with current filenames; files land under `<dest>/{photos,drive,notes,contacts}/`.
3. **Selective run:** `bunx icloud-backup --notes /tmp/notes-only`. Only the Notes lane appears; only `/tmp/notes-only/notes/` gets written.
4. **Resume check:** Ctrl-C mid-run, restart. Already-copied files skip instantly (manifest hit).
5. **Append-only check (Photos):** delete a test photo from iCloud Photos, wait for sync, re-run. File still on destination = ✓.
6. **Modification check (Notes):** edit a note, re-run. Previous markdown lands in `<dest>/_overwritten/<today>/v1/`, fresh version replaces it. Manifest version increments.
7. **Manifest rebuild:** delete `~/.icloud-backup/manifests/drive.sqlite`, run `--rebuild --drive <dest>`, then run `--drive <dest>` again — confirms it skips everything (manifest correctly inferred from destination).
8. **Manifest snapshot round-trip:** after a successful run, confirm `<dest>/<lane>/.manifest.sqlite` and `.manifest.json` exist and the JSON `count` matches `entries` in the SQLite. Then `rm ~/.icloud-backup/manifests/photos.sqlite` and re-run `--photos <dest>` — the run should log *"restored manifest from destination snapshot"* and skip everything (no re-copy, no `--rebuild` needed).
9. **Snapshot opt-out:** run with `--no-manifest-snapshot`; confirm `.manifest.sqlite`/`.manifest.json` are *not* written/updated.
10. **Drive scanner ignores snapshots:** drop a fake `.manifest.sqlite` into `<dest>/drive/Desktop/`. Confirm the next Drive run does **not** re-copy the snapshot file back (scanner exclusion working).
11. **Restore test:** copy a random month's photos folder + a notes folder + the contacts dir back to a scratch location; confirm files open (HEIC, .mov pair, .md renders, JSON parses).
12. **Version & upgrade:**
   - `icloud-backup --version` prints the version from `package.json`.
   - `icloud-backup --check-update` shows "up to date" against npm.
   - Bump `version` in `package.json`, push to `main`, watch `auto-release` workflow create a GitHub release, publish to npm with provenance, and upload `icloud-backup-darwin-{arm64,x64}` binaries.
   - On a clean machine: `bun install -g @evantahler/icloud-backup` then `icloud-backup --version` matches.
   - Bump version again, then on the global install run `icloud-backup --upgrade` — confirm in-place upgrade succeeds and the new version reports.

## Notes & gotchas

- **Full Disk Access** is the most common failure mode. Granted per-terminal-app. `--doctor` detects this and points at the right Settings page.
- **`bun link` for local development**: since `macos-ts` is `file:../macos-ts`, the package isn't yet publishable. `bun link` from `~/workspace/icloud-backup` registers it globally so `bunx icloud-backup` resolves to your local checkout. Switch to a published `macos-ts` and `bun publish` for real distribution.
- **State always at `~/.icloud-backup/`** regardless of destinations. This keeps SQLite local (fast, no SMB locking issues) and means destinations are pure file dumps — easy to inspect, easy to move, easy to back up further.
- **Manifest snapshots on destination** (`<dest>/<lane>/.manifest.{sqlite,json}`) are written at the *end* of each successful lane only. They're authoritative-as-of-completion, not live. The local manifest at `~/.icloud-backup/manifests/<lane>.sqlite` is the source of truth during a run. If a lane fails, its snapshot stays at the previous successful state — better stale than corrupt.
- **Live Photos:** the `.mov` companion lives next to the `.HEIC`. The photos task copies any `<basename>.mov` sibling. Edited versions (under `resources/renders/`) are not exported in v1.
- **iCloud-only photos** are skipped with a `log` warning per file. They still count toward totals. Once "Download Originals" finishes, the next run picks them up.
- **Notes attachments** copy alongside the markdown into a `<title>-<id>.md.attachments/` sibling directory. The `.md` uses relative links into it so the export is self-contained.
- **Contacts** emit vCard 3.0 by default (`.vcf`, universally re-importable into Contacts.app, Google Contacts, Outlook, etc.) or JSON via `--format json` (diff-friendly, scriptable). One file per contact, sha256-keyed in the manifest since Apple's `modifiedAt` on contacts isn't reliable. The hash is over the contact data, not the on-disk format, so switching formats archives the old file under `_overwritten/` and re-emits in the new format on the next run.
- **2FA / app-specific passwords are not needed** — we read local databases, never talk to Apple's servers.
- **Destination disappearing mid-run** (sleep, network blip, drive ejected): writes fail; the affected lane logs failure in red; next run resumes cleanly thanks to the manifest.
- **macos-ts as `file:../macos-ts`** is fine for development but blocks `npm publish` (npm rejects file: deps). Before the first auto-release, switch to a published version of `macos-ts` (or to a Git URL like `github:evantahler/macos-ts#v0.x`). The auto-release workflow's `bun install --frozen-lockfile` step will fail loudly if this is missed.
- **npm provenance**: the `id-token: write` permission in the workflow + `npm publish --provenance` produces a SLSA attestation that ties the published tarball to the GitHub commit. Same setup as mcpx — no separate `NPM_TOKEN` needed if using npm trusted publishers.
- **Binary install path detection** depends on `process.execPath`. If a user installs the binary somewhere unusual (e.g., via Homebrew formula in the future), `--upgrade` may fail to swap it. Falls back gracefully — prints the error, doesn't corrupt anything.
- **Out of scope:** Mail, Messages (easy add — `macos-ts` already supports it), Keychain, Calendar, Reminders, full iCloud Drive (only Desktop & Documents), automatic scheduling, Linux/Windows support.
