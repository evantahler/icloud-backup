import { Database } from "bun:sqlite";
import { rename, unlink } from "node:fs/promises";
import {
  MANIFEST_JSON_FILE,
  MANIFEST_PATH,
  MANIFEST_SNAPSHOT_FILE,
  type Service,
} from "./constants.ts";
import { ensureStateDirs, mkdirp } from "./fsutil.ts";

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

const SCHEMA_USER_VERSION = 1;

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      lane         TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      dest_path    TEXT NOT NULL,
      source_key   TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      backed_up_at INTEGER NOT NULL,
      version      INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (lane, source_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS entries_lane_dest ON entries(lane, dest_path)");
  db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION}`);
}

// How many buffered upserts to accumulate before auto-flushing inside a
// single transaction. Bounds the work re-done on a crash mid-run (we re-copy
// at most this many files, all idempotent because the destination atomic
// rename has already landed) while collapsing thousands of per-row WAL appends
// into one BEGIN/COMMIT.
const UPSERT_BUFFER_SIZE = 64;

export class Manifest {
  private readonly db: Database;
  private readonly lane: Service;
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly allStmt;
  private readonly clearStmt;
  private readonly txn;
  private pendingUpserts: ManifestEntry[] = [];

  static async open(lane: Service): Promise<Manifest> {
    await ensureStateDirs();
    return new Manifest(MANIFEST_PATH, lane);
  }

  /**
   * If the unified manifest has no rows for `lane` but the destination has a
   * `.manifest.sqlite` snapshot, import the snapshot's rows so the next run
   * resumes from it (much cheaper than --rebuild). Returns true if rows were
   * imported. Tolerates old per-lane snapshot schema (no `lane` column) by
   * tagging imported rows with `lane`.
   */
  static async restoreFromSnapshot(lane: Service, dest: string): Promise<boolean> {
    const snap = `${dest}/${lane}/${MANIFEST_SNAPSHOT_FILE}`;
    if (!(await Bun.file(snap).exists())) return false;
    const mf = await Manifest.open(lane);
    try {
      return mf.importSnapshotFile(snap);
    } finally {
      mf.close();
    }
  }

  /**
   * Opens a manifest at `path`, scoped to `lane`. WAL mode lets multiple
   * concurrent lane processes share `MANIFEST_PATH` safely; bun:sqlite calls
   * serialize within a process via the JS event loop. Defaults to the
   * "photos" lane purely so existing test code that constructs `new
   * Manifest(path)` keeps working.
   */
  constructor(path: string, lane: Service = "photos") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    // Safe with WAL: never corrupts the DB, only risks losing the last
    // committed transaction on power loss. Acceptable because the manifest is
    // a derived index — `rebuild` can reconstruct it from the destination.
    this.db.exec("PRAGMA synchronous = NORMAL");
    initSchema(this.db);
    this.lane = lane;

    this.getStmt = this.db.query<DbRow, [string, string]>(
      "SELECT source_id, dest_path, source_key, size_bytes, backed_up_at, version FROM entries WHERE lane = ? AND source_id = ?",
    );
    this.upsertStmt = this.db.query<
      void,
      [string, string, string, string, number, number, number]
    >(`
      INSERT INTO entries (lane, source_id, dest_path, source_key, size_bytes, backed_up_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lane, source_id) DO UPDATE SET
        dest_path    = excluded.dest_path,
        source_key   = excluded.source_key,
        size_bytes   = excluded.size_bytes,
        backed_up_at = excluded.backed_up_at,
        version      = excluded.version
    `);
    this.allStmt = this.db.query<DbRow, [string]>(
      "SELECT source_id, dest_path, source_key, size_bytes, backed_up_at, version FROM entries WHERE lane = ?",
    );
    this.clearStmt = this.db.query<void, [string]>("DELETE FROM entries WHERE lane = ?");
    this.txn = this.db.transaction((fn: () => void) => fn());
  }

  /**
   * Run `fn` inside a single SQLite transaction. bun:sqlite emits BEGIN /
   * COMMIT around the call and rolls back if `fn` throws. `fn` must be
   * synchronous — buffer any awaited work first, then call this.
   */
  transaction<T>(fn: () => T): T {
    let out!: T;
    this.txn(() => {
      out = fn();
    });
    return out;
  }

  get(sourceId: string): ManifestEntry | undefined {
    return this.getStmt.get(this.lane, sourceId) ?? undefined;
  }

  upsert(e: ManifestEntry): void {
    this.upsertStmt.run(
      this.lane,
      e.source_id,
      e.dest_path,
      e.source_key,
      e.size_bytes,
      e.backed_up_at,
      e.version,
    );
  }

  all(): ManifestEntry[] {
    return this.allStmt.all(this.lane);
  }

  /**
   * Lane snapshot as a Map keyed by `source_id`, for hot-path lookups during
   * sync. Built once at lane start so workers do O(1) Map gets instead of
   * N prepared-statement calls.
   */
  allMap(): Map<string, ManifestEntry> {
    const out = new Map<string, ManifestEntry>();
    for (const e of this.allStmt.all(this.lane)) out.set(e.source_id, e);
    return out;
  }

  clear(): void {
    this.clearStmt.run(this.lane);
  }

  /**
   * Buffer `e` for later flush. Auto-flushes once the buffer hits
   * UPSERT_BUFFER_SIZE so a long-running lane still persists incrementally.
   * Callers MUST call `flushPending()` before lane teardown (and in `finally`)
   * so the trailing partial batch lands.
   *
   * Buffer mutation is synchronous and therefore safe under concurrent JS
   * workers: between awaits, only one worker is on the stack at a time.
   */
  upsertBuffered(e: ManifestEntry): void {
    this.pendingUpserts.push(e);
    if (this.pendingUpserts.length >= UPSERT_BUFFER_SIZE) this.flushPending();
  }

  /** Flush any buffered upserts in a single transaction. Idempotent. */
  flushPending(): void {
    if (this.pendingUpserts.length === 0) return;
    const batch = this.pendingUpserts;
    this.pendingUpserts = [];
    this.txn(() => {
      for (const e of batch) {
        this.upsertStmt.run(
          this.lane,
          e.source_id,
          e.dest_path,
          e.source_key,
          e.size_bytes,
          e.backed_up_at,
          e.version,
        );
      }
    });
  }

  /**
   * Import rows from `snap` into this manifest, scoped to this lane. No-op if
   * this lane already has any rows (caller wanted a clean restore). Detects
   * old per-lane snapshot schema (no `lane` column) and tags imported rows
   * with this lane. Returns true if rows were imported.
   */
  importSnapshotFile(snap: string): boolean {
    const existingCount = this.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM entries WHERE lane = ?")
      .get(this.lane);
    if ((existingCount?.n ?? 0) > 0) return false;

    this.db.exec(`ATTACH DATABASE '${snap.replace(/'/g, "''")}' AS snap`);
    try {
      const cols = this.db.query<{ name: string }, []>("PRAGMA snap.table_info(entries)").all();
      const hasLane = cols.some((c) => c.name === "lane");
      if (hasLane) {
        this.db
          .query<void, [string]>(
            `INSERT OR IGNORE INTO main.entries
               (lane, source_id, dest_path, source_key, size_bytes, backed_up_at, version)
             SELECT lane, source_id, dest_path, source_key, size_bytes, backed_up_at, version
             FROM snap.entries WHERE lane = ?`,
          )
          .run(this.lane);
      } else {
        this.db
          .query<void, [string]>(
            `INSERT OR IGNORE INTO main.entries
               (lane, source_id, dest_path, source_key, size_bytes, backed_up_at, version)
             SELECT ?, source_id, dest_path, source_key, size_bytes, backed_up_at, version
             FROM snap.entries`,
          )
          .run(this.lane);
      }
    } finally {
      this.db.exec("DETACH DATABASE snap");
    }
    return true;
  }

  /**
   * End-of-run snapshot: write a frozen `.manifest.sqlite` (filtered to this
   * lane's rows) and a sibling `.manifest.json` export to `<dest>/<lane>/`.
   * The snapshot's schema mirrors the unified DB, including the `lane` column.
   */
  async snapshot(dest: string): Promise<void> {
    const laneDir = `${dest}/${this.lane}`;
    await mkdirp(laneDir);

    const sqliteDst = `${laneDir}/${MANIFEST_SNAPSHOT_FILE}`;
    const sqliteTmp = `${sqliteDst}.tmp.${process.pid}.${Date.now()}`;
    try {
      await unlink(sqliteTmp);
    } catch {}

    // Create an empty schema-matching DB at the tmp path. Default rollback
    // journal mode (no WAL) so the snapshot is a single self-contained file
    // with no -wal/-shm sidecars next to it.
    const tmpDb = new Database(sqliteTmp, { create: true });
    initSchema(tmpDb);
    tmpDb.close();

    this.db.exec(`ATTACH DATABASE '${sqliteTmp.replace(/'/g, "''")}' AS snap`);
    try {
      this.db
        .query<void, [string]>(
          `INSERT INTO snap.entries
             (lane, source_id, dest_path, source_key, size_bytes, backed_up_at, version)
           SELECT lane, source_id, dest_path, source_key, size_bytes, backed_up_at, version
           FROM main.entries WHERE lane = ?`,
        )
        .run(this.lane);
    } finally {
      this.db.exec("DETACH DATABASE snap");
    }

    try {
      await rename(sqliteTmp, sqliteDst);
    } catch (err) {
      try {
        await unlink(sqliteTmp);
      } catch {}
      throw err;
    }

    const rows = this.all();
    const json = {
      lane: this.lane,
      generatedAt: new Date().toISOString(),
      count: rows.length,
      entries: rows.map((r) => ({ lane: this.lane, ...r })),
    };
    const jsonDst = `${laneDir}/${MANIFEST_JSON_FILE}`;
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
    // Safety net for callers that forget to flush. Lanes still flush
    // explicitly before snapshot() so the snapshot includes the final batch.
    try {
      this.flushPending();
    } finally {
      this.db.close();
    }
  }
}
