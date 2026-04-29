import { stat } from "node:fs/promises";
import { basename } from "node:path";
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
import { Manifest, type ManifestEntry } from "../manifest.ts";
import { createTui, type TuiHandle } from "../tui.ts";

export async function runRebuild(lanes: Lane[]): Promise<boolean> {
  const tui = createTui(
    lanes.map((l) => l.service),
    1,
  );
  let ok = true;
  try {
    for (const lane of lanes) {
      const mf = await Manifest.open(lane.service);
      try {
        await rebuildLane(lane.service, lane.dest, mf, tui);
      } catch (err) {
        ok = false;
        tui.onEvent(lane.service, {
          type: "log",
          level: "warn",
          message: `failed: ${(err as Error).message}`,
        });
        tui.onEvent(lane.service, { type: "done", filesTransferred: 0, bytesTransferred: 0 });
      } finally {
        mf.close();
      }
    }
  } finally {
    tui.stop();
  }

  if (tui.hadWarnings()) {
    console.log(pc.dim(`warnings logged to ${tui.logFile}`));
  }
  return ok;
}

export async function rebuildLane(
  service: Service,
  dest: string,
  mf: Manifest,
  tui: TuiHandle,
): Promise<number> {
  const root = `${dest}/${service}`;
  if (!(await isDirectory(root))) {
    mf.transaction(() => {
      mf.clear();
    });
    tui.onEvent(service, {
      type: "log",
      level: "warn",
      message: `${root} not found — manifest cleared; next run will re-copy everything`,
    });
    tui.onEvent(service, { type: "total", files: 0 });
    tui.onEvent(service, { type: "done", filesTransferred: 0, bytesTransferred: 0 });
    return 0;
  }

  tui.onEvent(service, { type: "phase", label: "scanning" });
  const total = await countServiceFiles(service, root);
  tui.onEvent(service, { type: "total", files: total });

  const entries: ManifestEntry[] = [];
  let bytes = 0;
  for await (const e of walkServiceDest(service, root)) {
    entries.push(e);
    bytes += e.size_bytes;
    tui.onEvent(service, {
      type: "file",
      id: 0,
      index: entries.length,
      name: basename(e.dest_path),
      bytesDelta: e.size_bytes,
    });
  }

  tui.onEvent(service, { type: "phase", label: "writing manifest" });
  mf.transaction(() => {
    mf.clear();
    for (const e of entries) mf.upsert(e);
  });

  tui.onEvent(service, {
    type: "done",
    filesTransferred: entries.length,
    bytesTransferred: bytes,
  });
  return entries.length;
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

function servicePattern(service: Service): string {
  switch (service) {
    case "drive":
      return "**/*";
    case "photos":
      return "**/*.json";
    case "notes":
      return "**/*.md";
    case "contacts":
      return "*.{json,vcf}";
  }
}

/**
 * Counts files matching a lane's destination pattern. Used to seed the
 * progress bar before `walkServiceDest` extracts metadata. The count is an
 * upper bound: the walk may yield fewer entries when sidecars are orphaned,
 * filenames lack a trailing `-<id>`, or a contact / note can't be resolved.
 */
export async function countServiceFiles(service: Service, root: string): Promise<number> {
  if (!(await isDirectory(root))) return 0;
  const glob = new Glob(servicePattern(service));
  let n = 0;
  for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
    if (rel.startsWith(`${OVERWRITTEN_DIR}/`)) continue;
    if (isManifestSnapshot(rel)) continue;
    n++;
  }
  return n;
}

export async function* walkServiceDest(
  service: Service,
  root: string,
): AsyncIterable<ManifestEntry> {
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
        const glob = new Glob("*.{json,vcf}");
        for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
          if (rel.startsWith(`${OVERWRITTEN_DIR}/`)) continue;
          if (isManifestSnapshot(rel)) continue;
          const abs = `${root}/${rel}`;
          const id = parseTrailingId(rel.replace(/\.(json|vcf)$/, ""));
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
