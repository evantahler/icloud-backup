import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeWindow } from "../src/incremental.ts";
import { Manifest } from "../src/manifest.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "icloud-backup-incr-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshManifest(): Manifest {
  return new Manifest(`${tmp}/m.sqlite`);
}

describe("computeWindow", () => {
  test("no prior mark → full scan", () => {
    const mf = freshManifest();
    const { since, log } = computeWindow(mf, false, 86_400_000);
    expect(since).toBeUndefined();
    expect(log).toEqual({
      type: "log",
      level: "info",
      message: "full scan: no prior sync mark — examining all items",
    });
    mf.close();
  });

  test("--full ignores the mark and forces a full scan", () => {
    const mf = freshManifest();
    mf.setLastSyncStartedAt(1_700_000_000_000);
    const { since, log } = computeWindow(mf, true, 86_400_000);
    expect(since).toBeUndefined();
    expect(log.message).toBe("full scan: --full requested — examining all items");
    mf.close();
  });

  test("with a mark → since = mark − rewind, and the log explains the overlap", () => {
    const mf = freshManifest();
    const mark = Date.UTC(2026, 5, 2, 12, 0, 0); // 2026-06-02T12:00:00Z
    mf.setLastSyncStartedAt(mark);
    const rewindMs = 86_400_000; // 1d
    const { since, log } = computeWindow(mf, false, rewindMs);
    expect(since?.getTime()).toBe(mark - rewindMs);
    expect(log.message).toContain(`changed since ${new Date(mark - rewindMs).toISOString()}`);
    expect(log.message).toContain(`last sync ${new Date(mark).toISOString()}`);
    expect(log.message).toContain("1d overlap");
    expect(log.message).toContain("--full");
    mf.close();
  });

  test("a zero rewind makes since equal the mark", () => {
    const mf = freshManifest();
    mf.setLastSyncStartedAt(1_700_000_000_000);
    const { since } = computeWindow(mf, false, 0);
    expect(since?.getTime()).toBe(1_700_000_000_000);
    mf.close();
  });
});
