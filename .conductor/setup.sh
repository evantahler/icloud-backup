#!/bin/bash
set -e

bun install

# icloud-backup's runtime state (manifests, lockfile, update cache) lives at
# ~/.icloud-backup/ — global per-user, already shared across worktrees. Nothing
# per-worktree to seed here.
