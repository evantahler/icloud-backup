import { Database } from "bun:sqlite";
import type { Service } from "./config.ts";
import { ensureStateDirs, MANIFEST_DIR } from "./fsutil.ts";

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

  close(): void {
    this.db.close();
  }
}
