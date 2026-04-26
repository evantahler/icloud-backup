import { access, constants, stat } from "node:fs/promises";

export type Service = "photos" | "drive" | "notes" | "contacts";
export const SERVICES: readonly Service[] = ["photos", "drive", "notes", "contacts"] as const;

export interface Lane {
  service: Service;
  /** The user-supplied destination root. The lane's files land at `${dest}/${service}/...`. */
  dest: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export async function validateDestination(dest: string): Promise<void> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(dest);
  } catch {
    throw new ConfigError(`destination does not exist: ${dest}`);
  }
  if (!st.isDirectory()) {
    throw new ConfigError(`destination is not a directory: ${dest}`);
  }
  try {
    await access(dest, constants.W_OK);
  } catch {
    throw new ConfigError(`destination is not writable: ${dest}`);
  }
}
