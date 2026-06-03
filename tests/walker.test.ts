import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../src/spawn.ts";
import { mdfindChangedSince, type WalkedFile } from "../src/walker.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "icloud-backup-walk-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runnerReturning(stdout: string, exitCode = 0): (cmd: string[]) => Promise<SpawnResult> {
  return async () => ({ exitCode, stdout, stderr: exitCode === 0 ? "" : "boom" });
}

async function collect(iter: AsyncIterable<WalkedFile>): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  for await (const f of iter) out.push(f);
  return out;
}

describe("mdfindChangedSince", () => {
  test("maps mdfind absolute paths to prefixed WalkedFiles, applying exclusions", async () => {
    mkdirSync(join(tmp, "sub"), { recursive: true });
    mkdirSync(join(tmp, "dir"), { recursive: true });
    writeFileSync(join(tmp, "a.txt"), "aaa");
    writeFileSync(join(tmp, "sub", "b.txt"), "bb");
    writeFileSync(join(tmp, ".hidden.txt"), "x");
    writeFileSync(join(tmp, ".DS_Store"), "x");

    // mdfind would print absolute paths, one per line (with a trailing newline).
    const stdout = `${[
      join(tmp, "a.txt"),
      join(tmp, "sub", "b.txt"),
      join(tmp, ".hidden.txt"), // hidden — excluded
      join(tmp, ".DS_Store"), // excluded name
      join(tmp, "dir"), // directory — not a regular file
      join(tmp, "ghost.txt"), // listed but missing on disk
      "/somewhere/else/outside.txt", // outside root
    ].join("\n")}\n`;

    const files = await collect(
      mdfindChangedSince(tmp, "Desktop", new Date(0), runnerReturning(stdout)),
    );

    expect(files.map((f) => f.rel)).toEqual(["Desktop/a.txt", "Desktop/sub/b.txt"]);
    expect(files.map((f) => f.size)).toEqual([3, 2]);
    expect(files[0]?.abs).toBe(join(tmp, "a.txt"));
  });

  test("works without a prefix", async () => {
    writeFileSync(join(tmp, "a.txt"), "aaa");
    const files = await collect(
      mdfindChangedSince(tmp, undefined, new Date(0), runnerReturning(`${join(tmp, "a.txt")}\n`)),
    );
    expect(files.map((f) => f.rel)).toEqual(["a.txt"]);
  });

  test("passes a valid $time.iso query and -onlyin root to mdfind", async () => {
    let captured: string[] = [];
    const since = new Date("2026-06-02T12:00:00.000Z");
    await collect(
      mdfindChangedSince(tmp, "Desktop", since, async (cmd) => {
        captured = cmd;
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    );
    expect(captured[0]).toBe("mdfind");
    expect(captured).toContain("-onlyin");
    expect(captured).toContain(tmp);
    expect(captured[captured.length - 1]).toBe(
      "kMDItemFSContentChangeDate >= $time.iso(2026-06-02T12:00:00.000Z)",
    );
  });

  test("throws on a non-zero mdfind exit so the caller can fall back to a walk", async () => {
    await expect(
      collect(mdfindChangedSince(tmp, "Desktop", new Date(0), runnerReturning("", 1))),
    ).rejects.toThrow(/mdfind exited 1/);
  });
});
