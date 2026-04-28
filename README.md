# icloud-backup

Append-only backup of iCloud Photos, Drive (Desktop & Documents), Notes, and Contacts to any locally-mounted directory. macOS-only. No network calls to Apple — reads local SQLite databases directly via [`macos-ts`](https://github.com/evantahler/macos-ts).

```
bunx @evantahler/icloud-backup --all /Volumes/icloud-backup-evan
```

## Install

```bash
# Bun
bun install -g @evantahler/icloud-backup

# npm
npm install -g @evantahler/icloud-backup

# Standalone binary (darwin-arm64 or darwin-x64)
curl -fsSL https://raw.githubusercontent.com/evantahler/icloud-backup/main/install.sh | bash
```

## Prerequisites (one-time)

1. **Photos.app** → Settings → iCloud → "Download Originals to this Mac"
2. **System Settings** → Apple ID → iCloud → iCloud Drive → "Desktop & Documents Folders" = on
3. **Full Disk Access** for your terminal app (System Settings → Privacy & Security → Full Disk Access)
4. Mount your destination(s) at stable paths

Run `icloud-backup --doctor` to verify all of the above before your first backup.

## Usage

```
icloud-backup [options]

Service flags (each takes a destination directory):
  --photos    <path>     back up Photos library originals → <path>/photos/
  --drive     <path>     back up iCloud Drive Desktop & Documents → <path>/drive/
  --notes     <path>     back up Apple Notes as markdown → <path>/notes/
  --contacts  <path>     back up Apple Contacts as JSON → <path>/contacts/
  --all       <path>     shorthand for all four → <path>/{photos,drive,notes,contacts}/

Other:
  --doctor               run preflight checks and exit
  --rebuild              walk destinations and rebuild manifests
  --check-update         force a fresh npm-registry check, print result, exit
  --upgrade              upgrade to the latest published version (in-place)
  --help, -h
  --version, -v

Environment:
  ICLOUD_BACKUP_NO_UPDATE_CHECK=1   suppress the background "update available" notice
```

Per-service flags override `--all` for that service:

```bash
icloud-backup --all /Volumes/main --photos /Volumes/photo-archive
```

## How it works

- **Photos**: iterates the Photos SQLite library, copies originals + a JSON metadata sidecar, copies the `.mov` companion for Live Photos.
- **Drive**: `brctl download` materializes Desktop & Documents, then walks them with `Bun.Glob` and copies changed files.
- **Notes**: iterates Notes, writes each as a markdown file with attachments in a sibling `.attachments/` directory.
- **Contacts**: iterates Contacts, writes one JSON file per contact, sha256 of contents is the change key.

State (manifests, lock, update cache) lives at `~/.icloud-backup/` regardless of where backups land — keeps SQLite local-fast and survives unmounted destinations.

When a source changes, the existing destination file is moved to `<dest>/_overwritten/<date>/v<n>/` before the new version is written. Append-only.

## Resume & rebuild

Crash-safe: writes are atomic (write-to-tmp, fsync, rename); the manifest upsert is the last step per file. If the manifest is lost, run `icloud-backup --rebuild --all <path>` to walk destinations and reconstruct it.

## Output layout

```
/Volumes/icloud-backup-evan/
├── photos/2024/01/IMG_0001.HEIC + IMG_0001.HEIC.json
├── drive/{Desktop,Documents}/...
├── notes/<folder>/<title>-<id>.md (+ .attachments/ sibling)
├── contacts/<displayName>-<id>.json
└── _overwritten/<date>/v<n>/...
```

## Destination compatibility

The destination can be any locally-mounted directory: APFS-formatted external SSD, exFAT USB stick, or an SMB share to a NAS. Filenames coming out of iCloud sometimes contain characters or lengths that work on macOS-local filesystems but get rejected on shares — long DALL·E prompt-named PNGs, decomposed-Unicode names, trailing dots, etc.

Rather than supporting each filesystem's quirks separately, **all destination paths are sanitized to fit the strictest commonly-deployed SMB share** (the lowest common denominator). A backup that works to a local disk will also work when the same destination is later moved to a NAS.

| Constraint                          | SMB (worst-case observed)        | APFS / HFS+ |
|-------------------------------------|----------------------------------|-------------|
| Filename byte length per component  | **143 bytes** (HVTVault probe)\* | 255 bytes   |
| Total path length                   | 1024 bytes (PATH_MAX)            | 1024 bytes  |
| Trailing dot or space in name       | rejected                         | allowed     |
| Reserved chars (`\ : * ? " < > \|`) | rejected                         | allowed     |
| Filename encoding                   | NFC (UTF-16 on the wire)         | NFD         |
| Leading dot                         | allowed but hides on Unix        | allowed     |

\* The 143-byte ceiling is server-specific — some Samba builds cap at 255 UTF-16 chars, others lower. The byte cap is therefore **probed at the start of each lane** by binary-searching test writes against the destination root. The discovered cap is logged at run start (e.g. `destination NAME_MAX=143, sanitizing filenames to 126 bytes`).

Truncated filenames keep their extension when possible and never split a multi-byte UTF-8 codepoint. Decomposed names are NFC-normalized so `DALL·É` round-trips identically on both ends.

## License

MIT © Evan Tahler
