import { stat } from "node:fs/promises";
import { Glob } from "bun";
import { Contacts, Notes } from "macos-ts";
import pc from "picocolors";
import {
  MANIFEST_JSON_FILE,
  MANIFEST_SNAPSHOT_FILE,
  OVERWRITTEN_DIR,
  type Service,
} from "../constants.ts";
import type { Lane } from "../destination.ts";
import { sha256 } from "../fsutil.ts";
import { Manifest } from "../manifest.ts";

export async function runRebuild(lanes: Lane[]): Promise<boolean> {
  for (const lane of lanes) {
    console.log(pc.dim(`Rebuilding manifest for ${lane.service}...`));
    const count = await rebuildLane(lane.service, lane.dest);
    console.log(pc.green(`  ${lane.service}: ${count} entries`));
  }
  return true;
}

async function rebuildLane(service: Service, dest: string): Promise<number> {
  const root = `${dest}/${service}`;
  const mf = await Manifest.open(service);
  mf.clear();

  try {
    if (!(await isDirectory(root))) {
      console.log(
        pc.yellow(
          `  ${service}: ${root} not found — manifest cleared; next run will re-copy everything`,
        ),
      );
      return 0;
    }

    let count = 0;
    for await (const entry of walkServiceDest(service, root)) {
      mf.upsert(entry);
      count++;
    }
    return count;
  } finally {
    mf.close();
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function isManifestSnapshot(rel: string): boolean {
  const base = rel.split("/").pop();
  return base === MANIFEST_SNAPSHOT_FILE || base === MANIFEST_JSON_FILE;
}

export async function* walkServiceDest(
  service: Service,
  root: string,
): AsyncIterable<{
  source_id: string;
  dest_path: string;
  source_key: string;
  size_bytes: number;
  backed_up_at: number;
  version: number;
}> {
  if (!(await isDirectory(root))) return;

  switch (service) {
    case "drive": {
      const glob = new Glob("**/*");
      for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
        if (rel.startsWith(`${OVERWRITTEN_DIR}/`)) continue;
        if (isManifestSnapshot(rel)) continue;
        const abs = `${root}/${rel}`;
        const st = await stat(abs);
        const mtimeMs = Math.floor(st.mtimeMs);
        yield {
          source_id: rel,
          dest_path: abs,
          source_key: `${mtimeMs}|${st.size}`,
          size_bytes: st.size,
          backed_up_at: mtimeMs,
          version: 1,
        };
      }
      return;
    }
    case "photos": {
      const glob = new Glob("**/*.json");
      for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
        if (rel.startsWith(`${OVERWRITTEN_DIR}/`)) continue;
        if (isManifestSnapshot(rel)) continue;
        const sidecar = `${root}/${rel}`;
        const original = sidecar.slice(0, -".json".length);
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(original);
        } catch {
          continue;
        }
        let id: number;
        try {
          const parsed = (await Bun.file(sidecar).json()) as { id: number };
          id = parsed.id;
        } catch {
          continue;
        }
        const mtimeMs = Math.floor(st.mtimeMs);
        yield {
          source_id: `${id}`,
          dest_path: original,
          source_key: `${mtimeMs}|${st.size}`,
          size_bytes: st.size,
          backed_up_at: mtimeMs,
          version: 1,
        };
      }
      return;
    }
    case "notes": {
      const db = new Notes();
      try {
        const byId = new Map<number, number>();
        for (const n of db.notes()) byId.set(n.id, n.modifiedAt.getTime());

        const glob = new Glob("**/*.md");
        for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
          if (rel.startsWith(`${OVERWRITTEN_DIR}/`)) continue;
          if (isManifestSnapshot(rel)) continue;
          const abs = `${root}/${rel}`;
          const id = parseTrailingId(rel.replace(/\.md$/, ""));
          if (id === null) continue;
          const modifiedAt = byId.get(id);
          if (modifiedAt === undefined) continue;
          const st = await stat(abs);
          // Mirror the lane's source_key format so a post-rebuild run dedups
          // correctly. See src/tasks/notes.ts where sourceKey is built.
          const attachmentCount = db.listAttachments(id).length;
          yield {
            source_id: `${id}`,
            dest_path: abs,
            source_key: `${modifiedAt}|${attachmentCount}`,
            size_bytes: st.size,
            backed_up_at: modifiedAt,
            version: 1,
          };
        }
      } finally {
        db.close();
      }
      return;
    }
    case "contacts": {
      const db = new Contacts();
      try {
        const glob = new Glob("*.json");
        for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
          if (rel.startsWith(`${OVERWRITTEN_DIR}/`)) continue;
          if (isManifestSnapshot(rel)) continue;
          const abs = `${root}/${rel}`;
          const id = parseTrailingId(rel.replace(/\.json$/, ""));
          if (id === null) continue;
          let canonical: string;
          try {
            canonical = stableStringify(db.getContact(id));
          } catch {
            continue;
          }
          const st = await stat(abs);
          yield {
            source_id: `${id}`,
            dest_path: abs,
            source_key: sha256(canonical),
            size_bytes: st.size,
            backed_up_at: Math.floor(st.mtimeMs),
            version: 1,
          };
        }
      } finally {
        db.close();
      }
      return;
    }
  }
}

function parseTrailingId(name: string): number | null {
  const m = name.match(/-(\d+)$/);
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 10);
  return Number.isFinite(n) ? n : null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}
