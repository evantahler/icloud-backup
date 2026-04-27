import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkServiceDest } from "../src/commands/rebuild.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "icloud-backup-rebuild-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("walkServiceDest", () => {
  test("yields nothing when root does not exist (drive)", async () => {
    const entries = await collect(walkServiceDest("drive", `${tmp}/missing/drive`));
    expect(entries).toEqual([]);
  });

  test("yields nothing when root does not exist (notes — does not open Notes DB)", async () => {
    const entries = await collect(walkServiceDest("notes", `${tmp}/missing/notes`));
    expect(entries).toEqual([]);
  });

  test("yields nothing when root does not exist (contacts — does not open Contacts DB)", async () => {
    const entries = await collect(walkServiceDest("contacts", `${tmp}/missing/contacts`));
    expect(entries).toEqual([]);
  });

  test("yields nothing when root does not exist (photos)", async () => {
    const entries = await collect(walkServiceDest("photos", `${tmp}/missing/photos`));
    expect(entries).toEqual([]);
  });

  test("yields nothing when root is a file, not a directory", async () => {
    const path = `${tmp}/not-a-dir`;
    await writeFile(path, "");
    const entries = await collect(walkServiceDest("drive", path));
    expect(entries).toEqual([]);
  });

  test("walks an existing populated drive destination", async () => {
    const root = `${tmp}/drive`;
    await mkdir(`${root}/Documents/sub`, { recursive: true });
    await writeFile(`${root}/Documents/a.txt`, "alpha");
    await writeFile(`${root}/Documents/sub/b.txt`, "beta-beta");

    const entries = await collect(walkServiceDest("drive", root));
    const byId = new Map(entries.map((e) => [e.source_id, e]));

    expect(new Set(byId.keys())).toEqual(new Set(["Documents/a.txt", "Documents/sub/b.txt"]));
    expect(byId.get("Documents/a.txt")?.size_bytes).toBe(5);
    expect(byId.get("Documents/sub/b.txt")?.size_bytes).toBe(9);
    for (const e of entries) {
      expect(e.source_key).toMatch(/^\d+\|\d+$/);
      expect(e.version).toBe(1);
    }
  });

  test("skips _overwritten/ tree on drive walk", async () => {
    const root = `${tmp}/drive`;
    await mkdir(`${root}/_overwritten/2025-01-01/v1`, { recursive: true });
    await writeFile(`${root}/_overwritten/2025-01-01/v1/old.txt`, "x");
    await writeFile(`${root}/keep.txt`, "y");

    const entries = await collect(walkServiceDest("drive", root));
    expect(entries.map((e) => e.source_id)).toEqual(["keep.txt"]);
  });
});
