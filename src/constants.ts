import { homedir } from "node:os";
import pc from "picocolors";

// Service identity
export type Service = "photos" | "drive" | "notes" | "contacts";
export const SERVICES: readonly Service[] = ["photos", "drive", "notes", "contacts"] as const;

// State paths (always under $HOME, regardless of dest)
export const HOME = homedir();
export const STATE_DIR = `${HOME}/.icloud-backup`;
export const MANIFEST_DIR = `${STATE_DIR}/manifests`;
export const LOG_DIR = `${STATE_DIR}/logs`;
export const LOCK_PATH = `${STATE_DIR}/icloud-backup.lock`;
export const UPDATE_CACHE_PATH = `${STATE_DIR}/update.json`;

// Destination-side filenames written next to backed-up data
export const MANIFEST_SNAPSHOT_FILE = ".manifest.sqlite";
export const MANIFEST_JSON_FILE = ".manifest.json";
export const OVERWRITTEN_DIR = "_overwritten";

// iCloud Drive
export const DRIVE_ROOTS = ["Desktop", "Documents"] as const;

// Update checker
export type InstallMethod = "npm" | "bun" | "binary" | "local-dev";
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 3000;
export const ENV_NO_UPDATE_CHECK = "ICLOUD_BACKUP_NO_UPDATE_CHECK";

// TUI
export const LANE_COLOR: Record<Service, (s: string) => string> = {
  photos: pc.yellow,
  drive: pc.cyan,
  notes: pc.magenta,
  contacts: pc.green,
};
