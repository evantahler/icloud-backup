# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repo is **pre-implementation**. The only file under version control is `docs/plans/plan.md`, which is the authoritative design spec for the project. Read it before doing any work — it covers the CLI surface, architecture, manifest schema, release pipeline, and per-lane logic in detail.

The actual `package.json`, `tsconfig.json`, `src/`, and `.github/workflows/` files described in the plan **do not exist yet**. When implementing, follow the layout and module sketches in `docs/plans/plan.md` rather than inventing a new structure.

## What this is

`@evantahler/icloud-backup` — a Bun CLI that does manually-invoked, append-only backups of iCloud Photos, Drive (Desktop & Documents), Notes, and Contacts to any local directory. macOS-only. No network calls to Apple — reads local SQLite databases via `macos-ts`.

Entry point will be `src/index.ts` with `#!/usr/bin/env bun`. Distributed three ways: `bun install -g`, `npm install -g`, and curl'd standalone binaries from GitHub Releases.

## Key external dependencies

- **`macos-ts`** lives at `~/workspace/macos-ts/` and is consumed via `file:../macos-ts` during development. It owns all the macOS SQLite reads (Photos, Notes, Contacts). Before publishing to npm, this must be switched to a published version or git URL — npm rejects `file:` deps.
- **`bun:sqlite`** for per-lane manifests at `~/.icloud-backup/manifests/<lane>.sqlite`. Manifests track what's been copied so re-runs are incremental and crash-safe.
- **`brctl`** (built into macOS) for materializing iCloud Drive files before copying.
- **No rsync.** All file I/O goes through `Bun.file` / `Bun.write` with atomic write-to-tmp + rename.

## Architectural conventions to preserve

- **State always at `~/.icloud-backup/`** regardless of where backups land. Manifests, lockfile, and update cache live here so SQLite stays local-fast and survives unmounted destinations.
- **Each lane is an `async function*`** yielding `ProgressEvent`s (`phase` / `total` / `file` / `log` / `done`). Lanes run under `Promise.allSettled` and feed a `cli-progress` multibar.
- **Append-only, never overwrite in place.** When a source changes, archive the existing destination file under `<dest>/_overwritten/<date>/v<n>/` *before* writing the new version. Manifest upsert is the *last* step per file so a crash mid-copy is idempotent on retry.
- **Per-service flags override `--all`.** At least one service flag (or `--doctor` / `--rebuild` / `--upgrade` / `--check-update`) is required.
- **Auto-release pipeline mirrors `~/workspace/mcpx`.** Version bump in `package.json` → push to `main` → workflow creates GH release, publishes to npm with `--provenance`, builds `darwin-arm64` and `darwin-x64` binaries. Reference mcpx for workflow YAML structure when implementing `.github/workflows/auto-release.yml`.

## Diff rules per lane (don't change without good reason)

| Lane     | `source_key`                  |
|----------|-------------------------------|
| Photos   | `${modifiedAt}\|${size}`      |
| Drive    | `${mtime}\|${size}`           |
| Notes    | `${modifiedAt}`               |
| Contacts | `sha256(JSON.stringify(...))` |

Contacts uses sha256 because Apple's `modifiedAt` on contacts isn't reliable. Photos/Drive intentionally avoid hashing for performance.

## Commands (once implemented per plan)

The plan specifies these `package.json` scripts; when they exist, prefer them over inventing new ones:

- `bun src/index.ts` — run from source
- `bun test` — run tests
- `prettier --check .` — lint
- `bun build --compile --minify --sourcemap ./src/index.ts --outfile dist/icloud-backup` — build a binary

For local development the plan calls for `bun link` from this directory so `icloud-backup` resolves globally.

## Out of scope

Mail, Messages, Keychain, Calendar, Reminders, full iCloud Drive (only Desktop & Documents), automatic scheduling, Linux/Windows. Don't add these without an explicit ask.
