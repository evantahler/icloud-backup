import { unlink } from "node:fs/promises";
import { UPDATE_CACHE_PATH } from "../constants.ts";
import { ensureStateDirs } from "../fsutil.ts";
import type { UpdateCache } from "./checker.ts";

export async function loadUpdateCache(): Promise<UpdateCache | undefined> {
  try {
    const file = Bun.file(UPDATE_CACHE_PATH);
    if (!(await file.exists())) return undefined;
    return (await file.json()) as UpdateCache;
  } catch {
    return undefined;
  }
}

export async function saveUpdateCache(cache: UpdateCache): Promise<void> {
  try {
    await ensureStateDirs();
    await Bun.write(UPDATE_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {}
}

export async function clearUpdateCache(): Promise<void> {
  try {
    await unlink(UPDATE_CACHE_PATH);
  } catch {}
}
