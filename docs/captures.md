# Doc captures (screenshots & GIFs)

Screenshots and GIFs of `icloud-backup` are **generated**, not hand-taken, so
they stay current as the CLI evolves. One command regenerates every asset; the
diff of `docs/assets/` tells reviewers what changed.

## How it works

Two pieces:

1. **[VHS](https://github.com/charmbracelet/vhs)** drives a real PTY and
   renders a declarative `.tape` script (typed keystrokes + sleeps) into a
   GIF, MP4, or PNG.
2. **Fake-source mode** — when `ICLOUD_BACKUP_FAKE=1` is set, the macos-ts
   `Photos` / `Notes` / `Contacts` classes are swapped (via `src/macos.ts`)
   for in-process stubs that read fixtures from
   `docs/tapes/fixtures/data/{photos,notes,contacts}.json`. The Drive lane's
   walker is pointed at `ICLOUD_BACKUP_FAKE_DRIVE_ROOT` instead of `$HOME`,
   and the `brctl download` shell-out is skipped. Captures need no Full Disk
   Access, no real iCloud library, and produce stable, hermetic output.

## Install once

```bash
brew install vhs ttyd ffmpeg
```

(Linux: `apt install ttyd ffmpeg` plus VHS from its
[releases page](https://github.com/charmbracelet/vhs/releases).)

## Regenerate all assets

```bash
bun run capture
```

The script wipes `/tmp/icloud-backup/`, materialises the fixtures (zero-filled
binaries sized per the JSON specs), then runs VHS once per tape in
`docs/tapes/` — serially, since VHS contends for the tty. Output lands in
`docs/assets/`. Commit those changes alongside the CLI change that prompted
them.

Run a single tape:

```bash
bun run capture doctor
bun run capture backup
```

## Adding a new capture

1. **Decide what you're capturing.** A still PNG of a one-shot command? Use
   `Screenshot path.png` at the right point. An animated GIF of a multi-step
   flow? Use `Output path.gif`.

2. **Write the tape** at `docs/tapes/<name>.tape`:

   ```tape
   Source docs/tapes/_common.tape
   Output docs/assets/<name>.gif

   Sleep 800ms
   Type "icloud-backup all /tmp/icloud-backup/dest"
   Sleep 400ms
   Enter
   Sleep 12s
   ```

   `_common.tape` pins terminal dimensions, theme, font, and typing speed —
   source it from every tape for a consistent look.

3. **Extend the fixtures** if the new capture needs different data. Edit
   `docs/tapes/fixtures/data/{photos,notes,contacts,drive}.json`. The fixtures
   are shared across tapes today; if a capture needs its own data, add a
   per-tape fixture directory and have the tape set
   `ICLOUD_BACKUP_FAKE_FIXTURES_DIR`.

4. **Run** `bun run capture <name>` and review the output in `docs/assets/`.

5. **Embed** the asset in the relevant doc:
   ```markdown
   ![alt](./assets/<name>.gif)
   ```

## Why this approach

- **Up-to-date.** A README screenshot drifts the moment you change the multi-bar
  format string. Regenerated captures track the code.
- **Hermetic.** No iCloud account, no Full Disk Access, no network. CI could
  regenerate captures on merge if we ever want it to.
- **Diff-able.** Fake fixtures + pinned VHS settings + a fixed `/tmp/icloud-backup`
  workdir mean re-runs produce visually identical output. `git diff
  docs/assets/` is meaningful (modulo the elapsed/ETA/speed footer, which ticks
  in real time and inherently varies by ~1s between runs).

## Known VHS / tape gotchas

A few sharp edges from building the pipeline; worth knowing before you write a
new tape.

- **Absolute paths break `Output`.** VHS's tape parser treats the leading `/`
  in `Output /tmp/foo.gif` as a token boundary and errors with `Invalid
  command: tmp`. Use a relative path (resolved against the cwd VHS was
  launched from — `scripts/capture.ts` runs VHS from the repo root).
- **`Output` requires a value.** A tape whose only keeper is `Screenshot
  path.png` still has to declare an `Output` — point it at a throwaway
  filename like `docs/assets/.<name>-recording.gif` and let the capture script
  prune it after the run.
- **PNG `Output` produces a directory of frames, not a single PNG.** If you
  want a single still, use `Screenshot path.png` and keep `Output` as a GIF.
- **`Sleep N` is seconds.** `Sleep 500` is 8 minutes 20 seconds. Always
  suffix: `Sleep 500ms`, `Sleep 2s`.
- **TUI-style updates need a real PTY.** `cli-progress` renders bars by
  rewriting the same line. Outside a TTY (e.g. piping the run through `tail`),
  payload fields render as `undefined` and bars stack as text. VHS provides a
  real PTY through ttyd, so this only bites when you're smoke-testing
  interactively — not during capture.
- **`brctl download` skipped under fake mode.** The "Materializing iCloud
  Drive…" line still prints (so the recording shows it), but the actual
  shell-out is gated on `ICLOUD_BACKUP_FAKE !== "1"` in `src/index.ts`. Don't
  remove that gate without re-running `bun run capture` to confirm the GIF
  doesn't 30s-stall waiting on a non-existent `bird` daemon.

## Files & layout

```
docs/
├── tapes/
│   ├── _common.tape              # shared VHS settings (theme, dims, font)
│   ├── doctor.tape               # → docs/assets/doctor.png (still)
│   ├── backup.tape               # → docs/assets/backup.gif (animated)
│   └── fixtures/data/
│       ├── photos.json           # 24 photo entries incl. one 200 MB MP4 to slow the bar
│       ├── notes.json            # 14 notes, 5 attachments
│       ├── contacts.json         # 24 contacts
│       └── drive.json            # 28 drive files (Desktop/, Documents/)
└── assets/                       # committed; regenerated by `bun run capture`
    ├── doctor.png
    └── backup.gif

scripts/capture.ts                # VHS driver
src/macos.ts                      # env-flag indirection over macos-ts
src/macos-fake.ts                 # fixture-driven Photos/Notes/Contacts stubs
```
