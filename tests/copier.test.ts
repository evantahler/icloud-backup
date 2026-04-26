import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveOverwrite, atomicCopy, atomicWrite, fileExists } from "../src/copier.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "icloud-backup-copier-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("atomicCopy", () => {
  test("copies file to nested dest, creating parent dirs", async () => {
    const src = `${tmp}/src.txt`;
    const dest = `${tmp}/a/b/c/dest.txt`;
    writeFileSync(src, "hello");
    const bytes = await atomicCopy(src, dest);
    expect(bytes).toBe(5);
    expect(readFileSync(dest, "utf8")).toBe("hello");
  });
});

describe("atomicWrite", () => {
  test("writes content + creates parent dirs", async () => {
    const dest = `${tmp}/a/b/note.md`;
    const bytes = await atomicWrite(dest, "# title\n");
    expect(bytes).toBe(8);
    expect(readFileSync(dest, "utf8")).toBe("# title\n");
  });

  test("does not leave a tmp file on success", async () => {
    const dest = `${tmp}/note.md`;
    await atomicWrite(dest, "x");
    const entries = await readdir(tmp);
    expect(entries).toEqual(["note.md"]);
  });
});

describe("archiveOverwrite", () => {
  test("moves an existing dest under _overwritten/<date>/v<n>/", async () => {
    const root = `${tmp}/root`;
    mkdirSync(root, { recursive: true });
    const dest = `${root}/photos/2024/01/IMG.HEIC`;
    mkdirSync(`${root}/photos/2024/01`, { recursive: true });
    writeFileSync(dest, "v1");

    await archiveOverwrite(dest, 1, root);

    expect(await fileExists(dest)).toBe(false);
    const overwrittenRoot = `${root}/_overwritten`;
    const dates = await readdir(overwrittenRoot);
    expect(dates.length).toBe(1);
    const archived = `${overwrittenRoot}/${dates[0]}/v1/photos/2024/01/IMG.HEIC`;
    expect(readFileSync(archived, "utf8")).toBe("v1");
  });

  test("is a no-op when dest does not exist", async () => {
    const root = `${tmp}/root`;
    mkdirSync(root, { recursive: true });
    await archiveOverwrite(`${root}/missing.heic`, 1, root);
    expect(await fileExists(`${root}/_overwritten`)).toBe(false);
  });
});
