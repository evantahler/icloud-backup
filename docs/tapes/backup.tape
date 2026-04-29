Source docs/tapes/_common.tape
Output docs/assets/backup.gif

# Four lanes (photos, drive, notes, contacts) running to completion against
# the fake-source fixtures set up by scripts/capture.ts. Concurrency stays at
# the default (5) so the per-lane slot bars are visible in the recording.

Sleep 800ms
Type "icloud-backup all /tmp/icloud-backup/dest"
Sleep 400ms
Enter
Sleep 12s
