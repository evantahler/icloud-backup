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
});
