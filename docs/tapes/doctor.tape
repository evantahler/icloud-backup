Source docs/tapes/_common.tape

# Single-frame PNG of `icloud-backup doctor` against an ephemeral destination.
# scripts/capture.ts sets DEST to a tmp directory the wrapper can write to.
# `Output` is required by VHS but unused — `Screenshot` writes the keeper PNG.
# scripts/capture.ts cleans this throwaway up after the run.
Output docs/assets/.doctor-recording.gif

Sleep 800ms
Type "icloud-backup doctor /tmp/icloud-backup/dest"
Sleep 400ms
Enter
Sleep 2s
Screenshot docs/assets/doctor.png
