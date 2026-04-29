import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manifest } from "../src/manifest.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "icloud-backup-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("Manifest", () => {
  test("get returns undefined for unknown id", () => {
    const mf = new Manifest(`${tmp}/m.sqlite`);
    expect(mf.get("nope")).toBeUndefined();
    mf.close();
  });

  test("upsert + get round-trip", () => {
    const mf = new Manifest(`${tmp}/m.sqlite`);
    mf.upsert({
      source_id: "abc",
      dest_path: "/x/y.heic",
      source_key: "100|2048",
      size_bytes: 2048,
      backed_up_at: 1700000000000,
      version: 1,
    });
    expect(mf.get("abc")).toEqual({
      source_id: "abc",
      dest_path: "/x/y.heic",
      source_key: "100|2048",
      size_bytes: 2048,
      backed_up_at: 1700000000000,
      version: 1,
    });
    mf.close();
  });

  test("upsert overwrites prior entry", () => {
    const mf = new Manifest(`${tmp}/m.sqlite`);
    mf.upsert({
      source_id: "abc",
      dest_path: "/x/v1.heic",
      source_key: "100|2048",
      size_bytes: 2048,
      backed_up_at: 1,
      version: 1,
    });
    mf.upsert({
      source_id: "abc",
      dest_path: "/x/v2.heic",
      source_key: "200|4096",
      size_bytes: 4096,
      backed_up_at: 2,
      version: 2,
    });
    const got = mf.get("abc");
    expect(got?.version).toBe(2);
    expect(got?.source_key).toBe("200|4096");
    expect(got?.dest_path).toBe("/x/v2.heic");
    mf.close();
  });

  test("persists across reopen", () => {
    const path = `${tmp}/m.sqlite`;
    const mf = new Manifest(path);
    mf.upsert({
      source_id: "abc",
      dest_path: "/x/y",
      source_key: "k",
      size_bytes: 10,
      backed_up_at: 1,
      version: 1,
    });
    mf.close();
    const mf2 = new Manifest(path);
    expect(mf2.get("abc")?.size_bytes).toBe(10);
    mf2.close();
  });

  test("50 concurrent upserts all land", async () => {
    const mf = new Manifest(`${tmp}/m.sqlite`);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() =>
          mf.upsert({
            source_id: `id-${i}`,
            dest_path: `/x/${i}`,
            source_key: `k-${i}`,
            size_bytes: i,
            backed_up_at: i,
            version: 1,
          }),
        ),
      ),
    );
    expect(mf.all()).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(mf.get(`id-${i}`)?.size_bytes).toBe(i);
    }
    mf.close();
  });

  test("transaction commits all upserts atomically", () => {
    const mf = new Manifest(`${tmp}/m.sqlite`);
    mf.transaction(() => {
      for (let i = 0; i < 25; i++) {
        mf.upsert({
          source_id: `id-${i}`,
          dest_path: `/x/${i}`,
          source_key: `k-${i}`,
          size_bytes: i,
          backed_up_at: i,
          version: 1,
        });
      }
    });
    expect(mf.all()).toHaveLength(25);
    mf.close();
  });

  test("transaction rolls back on throw — prior rows untouched, inner upserts gone", () => {
    const mf = new Manifest(`${tmp}/m.sqlite`);
    mf.upsert({
      source_id: "seed",
      dest_path: "/x/seed",
      source_key: "k0",
      size_bytes: 1,
      backed_up_at: 1,
      version: 1,
    });

    expect(() =>
      mf.transaction(() => {
        mf.upsert({
          source_id: "in-txn",
          dest_path: "/x/txn",
          source_key: "k1",
          size_bytes: 2,
          backed_up_at: 2,
          version: 1,
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(mf.get("seed")?.size_bytes).toBe(1);
    expect(mf.get("in-txn")).toBeUndefined();
    mf.close();
  });

  test("transaction rolls back a clear() — lane stays populated on throw", () => {
    const mf = new Manifest(`${tmp}/m.sqlite`);
    mf.upsert({
      source_id: "keep",
      dest_path: "/x/keep",
      source_key: "k",
      size_bytes: 99,
      backed_up_at: 1,
      version: 1,
    });

    expect(() =>
      mf.transaction(() => {
        mf.clear();
        throw new Error("nope");
      }),
    ).toThrow("nope");

    expect(mf.get("keep")?.size_bytes).toBe(99);
    expect(mf.all()).toHaveLength(1);
    mf.close();
  });

  test("clear empties only the current lane", () => {
    const path = `${tmp}/m.sqlite`;
    const photos = new Manifest(path, "photos");
    const notes = new Manifest(path, "notes");
    photos.upsert({
      source_id: "p1",
      dest_path: "/x/p",
      source_key: "k",
      size_bytes: 10,
      backed_up_at: 1,
      version: 1,
    });
    notes.upsert({
      source_id: "n1",
      dest_path: "/x/n",
      source_key: "k",
      size_bytes: 20,
      backed_up_at: 1,
      version: 1,
    });

    photos.clear();
    expect(photos.all()).toEqual([]);
    expect(notes.get("n1")?.size_bytes).toBe(20);
    expect(notes.all()).toHaveLength(1);

    photos.close();
    notes.close();
  });

  test("get/all are lane-scoped — same source_id in different lanes is independent", () => {
    const path = `${tmp}/m.sqlite`;
    const photos = new Manifest(path, "photos");
    const drive = new Manifest(path, "drive");
    photos.upsert({
      source_id: "shared",
      dest_path: "/photos/x",
      source_key: "p",
      size_bytes: 1,
      backed_up_at: 1,
      version: 1,
    });
    drive.upsert({
      source_id: "shared",
      dest_path: "/drive/x",
      source_key: "d",
      size_bytes: 2,
      backed_up_at: 2,
      version: 1,
    });

    expect(photos.get("shared")?.dest_path).toBe("/photos/x");
    expect(drive.get("shared")?.dest_path).toBe("/drive/x");
    expect(photos.all()).toHaveLength(1);
    expect(drive.all()).toHaveLength(1);

    photos.close();
    drive.close();
  });

  test("snapshot writes .manifest.sqlite and .manifest.json with matching entries", async () => {
    const mf = new Manifest(`${tmp}/m.sqlite`);
    mf.upsert({
      source_id: "abc",
      dest_path: "/x/a.heic",
      source_key: "k1",
      size_bytes: 10,
      backed_up_at: 100,
      version: 1,
    });
    mf.upsert({
      source_id: "def",
      dest_path: "/x/b.heic",
      source_key: "k2",
      size_bytes: 20,
      backed_up_at: 200,
      version: 1,
    });

    await mf.snapshot(tmp);

    const sqliteSnap = `${tmp}/photos/.manifest.sqlite`;
    const jsonSnap = `${tmp}/photos/.manifest.json`;
    expect(await Bun.file(sqliteSnap).exists()).toBe(true);
    expect(await Bun.file(jsonSnap).exists()).toBe(true);

    const json = (await Bun.file(jsonSnap).json()) as {
      lane: string;
      generatedAt: string;
      count: number;
      entries: Array<{ source_id: string; lane: string }>;
    };
    expect(json.lane).toBe("photos");
    expect(json.count).toBe(2);
    expect(new Set(json.entries.map((e) => e.source_id))).toEqual(new Set(["abc", "def"]));
    expect(json.entries.every((e) => e.lane === "photos")).toBe(true);
    expect(typeof json.generatedAt).toBe("string");

    // The snapshot DB has the new schema with a `lane` column populated.
    const snapDb = new Database(sqliteSnap, { readonly: true });
    const cols = snapDb.query<{ name: string }, []>("PRAGMA table_info(entries)").all();
    expect(cols.some((c) => c.name === "lane")).toBe(true);
    const rows = snapDb
      .query<{ source_id: string; lane: string; size_bytes: number }, []>(
        "SELECT source_id, lane, size_bytes FROM entries ORDER BY source_id",
      )
      .all();
    expect(rows).toEqual([
      { source_id: "abc", lane: "photos", size_bytes: 10 },
      { source_id: "def", lane: "photos", size_bytes: 20 },
    ]);
    snapDb.close();

    mf.close();
  });

  test("snapshot is overwritable (re-running replaces the prior snapshot)", async () => {
    const mf = new Manifest(`${tmp}/m.sqlite`, "notes");
    mf.upsert({
      source_id: "abc",
      dest_path: "/x/a",
      source_key: "v1",
      size_bytes: 10,
      backed_up_at: 1,
      version: 1,
    });
    await mf.snapshot(tmp);

    mf.upsert({
      source_id: "abc",
      dest_path: "/x/a",
      source_key: "v2",
      size_bytes: 20,
      backed_up_at: 2,
      version: 2,
    });
    mf.upsert({
      source_id: "ghi",
      dest_path: "/x/c",
      source_key: "v1",
      size_bytes: 30,
      backed_up_at: 3,
      version: 1,
    });
    await mf.snapshot(tmp);

    const json = (await Bun.file(`${tmp}/notes/.manifest.json`).json()) as {
      count: number;
      entries: Array<{ source_id: string; size_bytes: number; version: number }>;
    };
    expect(json.count).toBe(2);
    const abc = json.entries.find((e) => e.source_id === "abc");
    expect(abc?.size_bytes).toBe(20);
    expect(abc?.version).toBe(2);

    mf.close();
  });

  test("snapshot leaves no .tmp files behind on success", async () => {
    const mf = new Manifest(`${tmp}/m.sqlite`, "drive");
    mf.upsert({
      source_id: "abc",
      dest_path: "/x/a",
      source_key: "k",
      size_bytes: 10,
      backed_up_at: 1,
      version: 1,
    });
    await mf.snapshot(tmp);

    const { readdirSync } = await import("node:fs");
    const files = readdirSync(`${tmp}/drive`);
    expect(files.some((f) => f.includes(".tmp."))).toBe(false);
    expect(files).toContain(".manifest.sqlite");
    expect(files).toContain(".manifest.json");

    mf.close();
  });

  test("snapshot only contains rows for this lane", async () => {
    const path = `${tmp}/m.sqlite`;
    const photos = new Manifest(path, "photos");
    const notes = new Manifest(path, "notes");
    photos.upsert({
      source_id: "p1",
      dest_path: "/p/1",
      source_key: "k",
      size_bytes: 1,
      backed_up_at: 1,
      version: 1,
    });
    notes.upsert({
      source_id: "n1",
      dest_path: "/n/1",
      source_key: "k",
      size_bytes: 2,
      backed_up_at: 2,
      version: 1,
    });

    await photos.snapshot(tmp);

    const snapDb = new Database(`${tmp}/photos/.manifest.sqlite`, { readonly: true });
    const rows = snapDb
      .query<{ source_id: string; lane: string }, []>("SELECT source_id, lane FROM entries")
      .all();
    expect(rows).toEqual([{ source_id: "p1", lane: "photos" }]);
    snapDb.close();

    photos.close();
    notes.close();
  });

  test("importSnapshotFile imports rows with the new schema", async () => {
    // Build a snapshot at <tmp>/photos/.manifest.sqlite (new schema).
    const photosSrc = new Manifest(`${tmp}/source.sqlite`, "photos");
    photosSrc.upsert({
      source_id: "x",
      dest_path: "/x/y",
      source_key: "k",
      size_bytes: 10,
      backed_up_at: 100,
      version: 1,
    });
    await photosSrc.snapshot(tmp);
    photosSrc.close();

    // Import into a fresh manifest at a different path.
    const target = new Manifest(`${tmp}/target.sqlite`, "photos");
    expect(target.importSnapshotFile(`${tmp}/photos/.manifest.sqlite`)).toBe(true);
    expect(target.get("x")?.size_bytes).toBe(10);
    expect(target.all()).toHaveLength(1);
    target.close();
  });

  test("importSnapshotFile tags old-schema (no lane column) rows with this lane", () => {
    // Build an old per-lane-format snapshot (no `lane` column) directly.
    const snapDir = `${tmp}/photos`;
    mkdirSync(snapDir, { recursive: true });
    const snapPath = `${snapDir}/.manifest.sqlite`;
    const oldDb = new Database(snapPath, { create: true });
    oldDb.exec(`
      CREATE TABLE entries (
        source_id    TEXT PRIMARY KEY,
        dest_path    TEXT NOT NULL,
        source_key   TEXT NOT NULL,
        size_bytes   INTEGER NOT NULL,
        backed_up_at INTEGER NOT NULL,
        version      INTEGER NOT NULL DEFAULT 1
      )
    `);
    oldDb.run("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)", [
      "legacy-id",
      "/old/path",
      "k",
      42,
      1700000000000,
      1,
    ]);
    oldDb.close();

    const target = new Manifest(`${tmp}/target.sqlite`, "photos");
    expect(target.importSnapshotFile(snapPath)).toBe(true);
    const row = target.get("legacy-id");
    expect(row?.dest_path).toBe("/old/path");
    expect(row?.size_bytes).toBe(42);
    expect(target.all()).toHaveLength(1);
    target.close();
  });

  test("beginBatch + flushBatch: rows commit only on flush", () => {
    const path = `${tmp}/m.sqlite`;
    const writer = new Manifest(path);
    writer.beginBatch();
    for (let i = 0; i < 10; i++) {
      writer.upsert({
        source_id: `id-${i}`,
        dest_path: `/x/${i}`,
        source_key: `k-${i}`,
        size_bytes: i,
        backed_up_at: i,
        version: 1,
      });
    }

    // A second connection sees the WAL snapshot at last commit — empty so far.
    const reader = new Manifest(path);
    expect(reader.all()).toHaveLength(0);
    reader.close();

    writer.flushBatch();

    const reader2 = new Manifest(path);
    expect(reader2.all()).toHaveLength(10);
    reader2.close();
    writer.close();
  });

  test("auto-flush fires at BATCH_FLUSH_THRESHOLD", () => {
    const path = `${tmp}/m.sqlite`;
    const writer = new Manifest(path);
    writer.beginBatch();
    const overshoot = 5;
    const total = Manifest.BATCH_FLUSH_THRESHOLD + overshoot;
    for (let i = 0; i < total; i++) {
      writer.upsert({
        source_id: `id-${i}`,
        dest_path: `/x/${i}`,
        source_key: `k-${i}`,
        size_bytes: i,
        backed_up_at: i,
        version: 1,
      });
    }

    // Threshold rows already committed by auto-flush; the trailing `overshoot`
    // rows are still pending until flushBatch.
    const reader = new Manifest(path);
    expect(reader.all()).toHaveLength(Manifest.BATCH_FLUSH_THRESHOLD);
    reader.close();

    writer.flushBatch();

    const reader2 = new Manifest(path);
    expect(reader2.all()).toHaveLength(total);
    reader2.close();
    writer.close();
  });

  test("close() flushes pending batched rows", () => {
    const path = `${tmp}/m.sqlite`;
    const writer = new Manifest(path);
    writer.beginBatch();
    writer.upsert({
      source_id: "tail",
      dest_path: "/x/tail",
      source_key: "k",
      size_bytes: 1,
      backed_up_at: 1,
      version: 1,
    });
    writer.close();

    const reader = new Manifest(path);
    expect(reader.get("tail")?.size_bytes).toBe(1);
    reader.close();
  });

  test("flushBatch outside a batch is a no-op; upsert after flush goes through immediately", () => {
    const path = `${tmp}/m.sqlite`;
    const mf = new Manifest(path);
    mf.flushBatch();
    mf.upsert({
      source_id: "post",
      dest_path: "/x/post",
      source_key: "k",
      size_bytes: 7,
      backed_up_at: 1,
      version: 1,
    });

    const reader = new Manifest(path);
    expect(reader.get("post")?.size_bytes).toBe(7);
    reader.close();
    mf.close();
  });

  test("importSnapshotFile is a no-op if the lane already has rows", async () => {
    // Build a snapshot.
    const photosSrc = new Manifest(`${tmp}/source.sqlite`, "photos");
    photosSrc.upsert({
      source_id: "from-snap",
      dest_path: "/p/snap",
      source_key: "k",
      size_bytes: 99,
      backed_up_at: 1,
      version: 1,
    });
    await photosSrc.snapshot(tmp);
    photosSrc.close();

    // Target already has a row in this lane.
    const target = new Manifest(`${tmp}/target.sqlite`, "photos");
    target.upsert({
      source_id: "existing",
      dest_path: "/p/existing",
      source_key: "k",
      size_bytes: 1,
      backed_up_at: 1,
      version: 1,
    });
    expect(target.importSnapshotFile(`${tmp}/photos/.manifest.sqlite`)).toBe(false);
    expect(target.get("from-snap")).toBeUndefined();
    expect(target.all()).toHaveLength(1);
    target.close();
  });
});
