# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repo is **implemented and shipping**. `docs/plans/plan.md` is the authoritative design spec — read it before making non-trivial changes; the actual code under `src/` follows its layout. When the plan and the code drift, decide which one is right and fix the other in the same change.

## What this is

`@evantahler/icloud-backup` — a Bun CLI that does manually-invoked, append-only backups of iCloud Photos, Drive (Desktop & Documents), Notes, and Contacts to any local directory. macOS-only. No network calls to Apple — reads local SQLite databases via `macos-ts`.

Entry point will be `src/index.ts` with `#!/usr/bin/env bun`. Distributed three ways: `bun install -g`, `npm install -g`, and curl'd standalone binaries from GitHub Releases.

## Key external dependencies

- **`macos-ts`** is consumed from npm (`^0.9.2`). It owns all the macOS SQLite reads (Photos, Notes, Contacts). Source also lives at `~/workspace/macos-ts/` if you need to fix something upstream — see "Fixing dependencies upstream" below.
- **`bun:sqlite`** for the unified manifest at `~/.icloud-backup/manifest.sqlite`. One `entries` table with a `lane` column tracks what's been copied across all four services so re-runs are incremental and crash-safe.
- **`brctl`** (built into macOS) for materializing iCloud Drive files before copying.
- **No rsync.** All file I/O goes through `Bun.file` / `Bun.write` with atomic write-to-tmp + rename.

## Architectural conventions to preserve

- **State always at `~/.icloud-backup/`** regardless of where backups land. Manifests, lockfile, and update cache live here so SQLite stays local-fast and survives unmounted destinations.
- **Each lane is an `async function*`** yielding `ProgressEvent`s (`phase` / `total` / `file` / `log` / `done`). Lanes run under `Promise.allSettled` and feed a `cli-progress` multibar.
- **Append-only, never overwrite in place.** When a source changes, archive the existing destination file under `<dest>/_overwritten/<date>/v<n>/` *before* writing the new version. Manifest upsert is the *last* step per file so a crash mid-copy is idempotent on retry.
- **Per-service flags override `--all`.** At least one service flag (or `--doctor` / `--rebuild` / `--upgrade` / `--check-update`) is required.
- **Destination filename rules target SMB**, not APFS — see README's "Destination compatibility" section for the constraints table. The byte cap is *probed* at lane start via `probeMaxFilenameBytes` because `pathconf(NAME_MAX)` is unreliable on smbfs. Don't loosen sanitization or skip the probe.
- **Auto-release pipeline mirrors `~/workspace/mcpx`.** Version bump in `package.json` → push to `main` → workflow creates GH release, publishes to npm with `--provenance`, builds `darwin-arm64` and `darwin-x64` binaries. Reference mcpx for workflow YAML structure when implementing `.github/workflows/auto-release.yml`.
- **Always bump `package.json` `version` when shipping code changes.** Any commit that modifies behavior (new feature, bug fix, breaking change) bumps the version in the *same* commit. The auto-release workflow keys off the `version` field, so an un-bumped change is invisible to npm/binary consumers. Use semver: patch for fixes, minor for features, major for breaking. Doc-only / test-only / formatting-only commits do not need a bump — anything that ships in `src/` does.

## Diff rules per lane (don't change without good reason)

| Lane     | `source_key`                  |
|----------|-------------------------------|
| Photos   | `${modifiedAt}\|${size}`      |
| Drive    | `${mtime}\|${size}`           |
| Notes    | `${modifiedAt}`               |
| Contacts | `sha256(JSON.stringify(...))` |

Contacts uses sha256 because Apple's `modifiedAt` on contacts isn't reliable. Photos/Drive intentionally avoid hashing for performance.

## Commands

Use the `package.json` scripts; don't invent new ones:

- `bun run dev` — run from source (`bun run src/index.ts`)
- `bun test` — run tests
- `bun run lint` — typecheck + biome check (`tsc --noEmit && biome check .`)
- `bun run format` — biome auto-fix (`biome check --write .`)
- `bun run build` — compile a standalone binary

For local development: `bun link` from this directory so `icloud-backup` resolves globally.

## Fixing dependencies upstream

When a bug or limitation is in a package the user owns (e.g. `macos-ts` at `~/workspace/macos-ts/`), **fix it in that package** rather than working around it here. File a GitHub issue, push a PR upstream, then bump the version range. Local workarounds like `tsconfig.json` `paths` mappings, patch-package, or shim modules are a smell and should be avoided unless the upstream fix is infeasible.

Example: macos-ts 0.9.2 was missing `exports`/`main`/`types` in its `package.json`, causing TS bundler resolution to fail. The right fix was [evantahler/macos-ts#29](https://github.com/evantahler/macos-ts/issues/29) — not a `paths` workaround here.

## Out of scope

Mail, Messages, Keychain, Calendar, Reminders, full iCloud Drive (only Desktop & Documents), automatic scheduling, Linux/Windows. Don't add these without an explicit ask.
