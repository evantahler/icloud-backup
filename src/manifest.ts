import { Database } from "bun:sqlite";
import { copyFile, rename, unlink } from "node:fs/promises";
import type { Service } from "./config.ts";
import { ensureStateDirs, MANIFEST_DIR, mkdirp } from "./fsutil.ts";

export interface ManifestEntry {
  source_id: string;
  dest_path: string;
  source_key: string;
  size_bytes: number;
  backed_up_at: number;
  version: number;
}

interface DbRow {
  source_id: string;
  dest_path: string;
  source_key: string;
  size_bytes: number;
  backed_up_at: number;
  version: number;
}

export class Manifest {
  private readonly db: Database;
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly allStmt;

  static async open(lane: Service): Promise<Manifest> {
    await ensureStateDirs();
    return new Manifest(`${MANIFEST_DIR}/${lane}.sqlite`);
  }

  /**
   * If the local manifest at `${MANIFEST_DIR}/${lane}.sqlite` is missing but the destination
   * has a `.manifest.sqlite` snapshot, copy it into place so the next run resumes from it
   * (much cheaper than --rebuild). Returns true if a restore happened.
   */
  static async restoreFromSnapshot(lane: Service, dest: string): Promise<boolean> {
    const localPath = `${MANIFEST_DIR}/${lane}.sqlite`;
    if (await Bun.file(localPath).exists()) return false;
    const snap = `${dest}/${lane}/.manifest.sqlite`;
    if (!(await Bun.file(snap).exists())) return false;
    await ensureStateDirs();
    await copyFile(snap, localPath);
    return true;
  }

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        source_id    TEXT PRIMARY KEY,
        dest_path    TEXT NOT NULL,
        source_key   TEXT NOT NULL,
        size_bytes   INTEGER NOT NULL,
        backed_up_at INTEGER NOT NULL,
        version      INTEGER NOT NULL DEFAULT 1
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS entries_dest ON entries(dest_path)");

    this.getStmt = this.db.query<DbRow, [string]>(
      "SELECT source_id, dest_path, source_key, size_bytes, backed_up_at, version FROM entries WHERE source_id = ?",
    );
    this.upsertStmt = this.db.query<void, [string, string, string, number, number, number]>(`
      INSERT INTO entries (source_id, dest_path, source_key, size_bytes, backed_up_at, version)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        dest_path    = excluded.dest_path,
        source_key   = excluded.source_key,
        size_bytes   = excluded.size_bytes,
        backed_up_at = excluded.backed_up_at,
        version      = excluded.version
    `);
    this.allStmt = this.db.query<DbRow, []>(
      "SELECT source_id, dest_path, source_key, size_bytes, backed_up_at, version FROM entries",
    );
  }

  get(sourceId: string): ManifestEntry | undefined {
    return this.getStmt.get(sourceId) ?? undefined;
  }

  upsert(e: ManifestEntry): void {
    this.upsertStmt.run(
      e.source_id,
      e.dest_path,
      e.source_key,
      e.size_bytes,
      e.backed_up_at,
      e.version,
    );
  }

  all(): ManifestEntry[] {
    return this.allStmt.all();
  }

  clear(): void {
    this.db.exec("DELETE FROM entries");
  }

  /**
   * End-of-run snapshot: write a frozen `.manifest.sqlite` (via VACUUM INTO, atomic + WAL-flushed)
   * and a sibling `.manifest.json` export to `<dest>/<lane>/`. Safe to call while the DB is open;
   * VACUUM INTO writes a fresh, fully-checkpointed copy of the schema/data.
   */
  async snapshot(lane: Service, dest: string): Promise<void> {
    const laneDir = `${dest}/${lane}`;
    await mkdirp(laneDir);

    const sqliteDst = `${laneDir}/.manifest.sqlite`;
    const sqliteTmp = `${sqliteDst}.tmp.${process.pid}.${Date.now()}`;
    try {
      await unlink(sqliteTmp);
    } catch {}
    this.db.exec(`VACUUM INTO '${sqliteTmp.replace(/'/g, "''")}'`);
    try {
      await rename(sqliteTmp, sqliteDst);
    } catch (err) {
      try {
        await unlink(sqliteTmp);
      } catch {}
      throw err;
    }

    const rows = this.allStmt.all();
    const json = {
      lane,
      generatedAt: new Date().toISOString(),
      count: rows.length,
      entries: rows,
    };
    const jsonDst = `${laneDir}/.manifest.json`;
    const jsonTmp = `${jsonDst}.tmp.${process.pid}.${Date.now()}`;
    try {
      await Bun.write(jsonTmp, `${JSON.stringify(json, null, 2)}\n`);
      await rename(jsonTmp, jsonDst);
    } catch (err) {
      try {
        await unlink(jsonTmp);
      } catch {}
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
