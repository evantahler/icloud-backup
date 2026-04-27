import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

  test("clear empties the table", () => {
    const mf = new Manifest(`${tmp}/m.sqlite`);
    mf.upsert({
      source_id: "abc",
      dest_path: "/x/y",
      source_key: "k",
      size_bytes: 10,
      backed_up_at: 1,
      version: 1,
    });
    mf.clear();
    expect(mf.all()).toEqual([]);
    mf.close();
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

    await mf.snapshot("photos", tmp);

    const sqliteSnap = `${tmp}/photos/.manifest.sqlite`;
    const jsonSnap = `${tmp}/photos/.manifest.json`;
    expect(await Bun.file(sqliteSnap).exists()).toBe(true);
    expect(await Bun.file(jsonSnap).exists()).toBe(true);

    const json = (await Bun.file(jsonSnap).json()) as {
      lane: string;
      generatedAt: string;
      count: number;
      entries: Array<{ source_id: string }>;
    };
    expect(json.lane).toBe("photos");
    expect(json.count).toBe(2);
    expect(new Set(json.entries.map((e) => e.source_id))).toEqual(new Set(["abc", "def"]));
    expect(typeof json.generatedAt).toBe("string");

    // Open the snapshot DB directly — it should be a valid manifest with same rows.
    const restored = new Manifest(sqliteSnap);
    expect(restored.get("abc")?.size_bytes).toBe(10);
    expect(restored.get("def")?.size_bytes).toBe(20);
    expect(restored.all().length).toBe(2);
    restored.close();

    mf.close();
  });

  test("snapshot is overwritable (re-running replaces the prior snapshot)", async () => {
    const mf = new Manifest(`${tmp}/m.sqlite`);
    mf.upsert({
      source_id: "abc",
      dest_path: "/x/a",
      source_key: "v1",
      size_bytes: 10,
      backed_up_at: 1,
      version: 1,
    });
    await mf.snapshot("notes", tmp);

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
    await mf.snapshot("notes", tmp);

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
    const mf = new Manifest(`${tmp}/m.sqlite`);
    mf.upsert({
      source_id: "abc",
      dest_path: "/x/a",
      source_key: "k",
      size_bytes: 10,
      backed_up_at: 1,
      version: 1,
    });
    await mf.snapshot("drive", tmp);

    const { readdirSync } = await import("node:fs");
    const files = readdirSync(`${tmp}/drive`);
    expect(files.some((f) => f.includes(".tmp."))).toBe(false);
    expect(files).toContain(".manifest.sqlite");
    expect(files).toContain(".manifest.json");

    mf.close();
  });
});
