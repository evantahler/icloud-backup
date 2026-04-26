import { describe, expect, test } from "bun:test";
import { fileUrlToPath, formatBytes, pad2, sanitizeFilename, sha256 } from "../src/fsutil.ts";

describe("sanitizeFilename", () => {
  test("removes invalid chars", () => {
    expect(sanitizeFilename('a/b\\c:d*?"<>|e')).toBe("a_b_c_d______e");
  });
  test("falls back when input is empty after stripping", () => {
    expect(sanitizeFilename("")).toBe("untitled");
    expect(sanitizeFilename("///")).toBe("___");
  });
  test("strips leading dots", () => {
    expect(sanitizeFilename("...secret")).toBe("_secret");
  });
  test("truncates to 200 chars", () => {
    const s = "a".repeat(300);
    expect(sanitizeFilename(s).length).toBe(200);
  });
});

describe("sha256", () => {
  test("produces stable hex hash", () => {
    expect(sha256("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("pad2", () => {
  test("pads single digit", () => {
    expect(pad2(1)).toBe("01");
    expect(pad2(12)).toBe("12");
  });
});

describe("formatBytes", () => {
  test("formats bytes / KB / MB / GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});

describe("fileUrlToPath", () => {
  test("decodes file:// URLs", () => {
    expect(fileUrlToPath("file:///Users/foo/bar.HEIC")).toBe("/Users/foo/bar.HEIC");
    expect(fileUrlToPath("file:///Users/foo/with%20space.jpg")).toBe("/Users/foo/with space.jpg");
  });
  test("passes through non-file URLs", () => {
    expect(fileUrlToPath("/Users/foo/bar")).toBe("/Users/foo/bar");
  });
});
