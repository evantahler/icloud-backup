import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countServiceFiles, rebuildLane, walkServiceDest } from "../src/commands/rebuild.ts";
import { Manifest } from "../src/manifest.ts";
import type { ProgressEvent, TuiHandle } from "../src/tui.ts";

function noopTui(events?: ProgressEvent[]): TuiHandle {
  return {
    onEvent: (_service, e) => {
      events?.push(e);
    },
    log: () => {},
    stop: () => {},
    logFile: "",
    hadWarnings: () => false,
  };
}

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

describe("countServiceFiles", () => {
  test("returns 0 when root does not exist", async () => {
    expect(await countServiceFiles("drive", `${tmp}/missing`)).toBe(0);
  });

  test("matches the walk yield count for a populated drive dest", async () => {
    const root = `${tmp}/drive`;
    await mkdir(`${root}/Documents/sub`, { recursive: true });
    await writeFile(`${root}/Documents/a.txt`, "alpha");
    await writeFile(`${root}/Documents/sub/b.txt`, "beta");
    await writeFile(`${root}/Documents/c.txt`, "gamma");

    const count = await countServiceFiles("drive", root);
    const entries = await collect(walkServiceDest("drive", root));
    expect(count).toBe(entries.length);
    expect(count).toBe(3);
  });

  test("excludes _overwritten/ tree and snapshot sidecars", async () => {
    const root = `${tmp}/drive`;
    await mkdir(`${root}/_overwritten/2025-01-01/v1`, { recursive: true });
    await writeFile(`${root}/_overwritten/2025-01-01/v1/old.txt`, "x");
    await writeFile(`${root}/.manifest.sqlite`, "");
    await writeFile(`${root}/.manifest.json`, "{}");
    await writeFile(`${root}/keep.txt`, "y");

    expect(await countServiceFiles("drive", root)).toBe(1);
  });
});

describe("rebuildLane", () => {
  test("clears stale rows and reinserts entries from the destination walk", async () => {
    const root = `${tmp}/drive`;
    await mkdir(`${root}/Documents`, { recursive: true });
    await writeFile(`${root}/Documents/a.txt`, "alpha");
    await writeFile(`${root}/Documents/b.txt`, "beta-beta");

    const mf = new Manifest(`${tmp}/m.sqlite`, "drive");
    mf.upsert({
      source_id: "stale-row",
      dest_path: "/gone/old.txt",
      source_key: "1|1",
      size_bytes: 1,
      backed_up_at: 1,
      version: 1,
    });

    const events: ProgressEvent[] = [];
    const n = await rebuildLane("drive", tmp, mf, noopTui(events));

    expect(n).toBe(2);
    expect(mf.get("stale-row")).toBeUndefined();
    expect(new Set(mf.all().map((r) => r.source_id))).toEqual(
      new Set(["Documents/a.txt", "Documents/b.txt"]),
    );

    expect(events.find((e) => e.type === "phase" && e.label === "scanning")).toBeDefined();
    expect(events.find((e) => e.type === "total")).toEqual({ type: "total", files: 2 });
    expect(events.filter((e) => e.type === "file")).toHaveLength(2);
    expect(events.find((e) => e.type === "phase" && e.label === "writing manifest")).toBeDefined();
    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({ type: "done", filesTransferred: 2, bytesTransferred: 5 + 9 });

    mf.close();
  });

  test("missing root clears the lane and emits a done(0,0)", async () => {
    const mf = new Manifest(`${tmp}/m.sqlite`, "drive");
    mf.upsert({
      source_id: "stale",
      dest_path: "/x",
      source_key: "k",
      size_bytes: 1,
      backed_up_at: 1,
      version: 1,
    });

    const n = await rebuildLane("drive", `${tmp}/no-such`, mf, noopTui());
    expect(n).toBe(0);
    expect(mf.all()).toEqual([]);
    mf.close();
  });
});
