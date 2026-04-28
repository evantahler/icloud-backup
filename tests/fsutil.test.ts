import { describe, expect, test } from "bun:test";
import {
  errCode,
  errReason,
  fileUrlToPath,
  formatBytes,
  formatDuration,
  pad2,
  sanitizeFilename,
  sanitizeRelativePath,
  sha256,
} from "../src/fsutil.ts";

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
  test("truncates to 200 bytes", () => {
    const s = "a".repeat(300);
    expect(sanitizeFilename(s).length).toBe(200);
    expect(Buffer.byteLength(sanitizeFilename(s), "utf8")).toBe(200);
  });
  test("byte-caps multibyte names so emoji-heavy names don't blow the AFP limit", () => {
    // Each 🦘 is 4 UTF-8 bytes; 100 of them = 400 bytes, way over AFP's 255.
    const result = sanitizeFilename("🦘".repeat(100));
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(200);
    // Truncation must land on a UTF-8 boundary (no replacement chars).
    expect(result).not.toContain("�");
  });
  test("strips leading and trailing whitespace", () => {
    expect(sanitizeFilename(" \tfoo.png ")).toBe("foo.png");
  });
  test("strips trailing dots and spaces (rejected on Windows-family filesystems)", () => {
    expect(sanitizeFilename("foo.png.")).toBe("foo.png");
    expect(sanitizeFilename("foo. ")).toBe("foo");
    expect(sanitizeFilename("foo...")).toBe("foo");
  });
  test("strips zero-width and variation-selector chars that .trim() misses", () => {
    expect(sanitizeFilename("​​foo.png")).toBe("foo.png");
    expect(sanitizeFilename("﻿foo.png")).toBe("foo.png");
    expect(sanitizeFilename("️foo.png")).toBe("foo.png");
  });
  test("does not leave a leading underscore-space when input starts with control + space", () => {
    // Without leading-stripping order care, this becomes "_ foo.png". We want "foo.png".
    expect(sanitizeFilename("\x01 foo.png")).toBe("foo.png");
  });
  test("NFC-normalizes decomposed names so SMB shares don't reject them", () => {
    // "DALL·E" with a decomposed É (E + U+0301 combining acute) — the form
    // macOS APFS hands back. SMB shares typically expect NFC.
    const decomposed = "DALL·É";
    const composed = "DALL·É";
    expect(decomposed).not.toBe(composed);
    expect(sanitizeFilename(decomposed)).toBe(composed);
  });
});

describe("sanitizeRelativePath", () => {
  test("sanitizes each path component but preserves separators", () => {
    expect(sanitizeRelativePath("foo/bar*baz/qux")).toBe("foo/bar_baz/qux");
  });
  test("byte-caps each component independently", () => {
    const long = "a".repeat(300);
    const result = sanitizeRelativePath(`dir/${long}/leaf.png`);
    const parts = result.split("/");
    expect(parts).toHaveLength(3);
    expect(Buffer.byteLength(parts[1] ?? "", "utf8")).toBe(200);
    expect(parts[0]).toBe("dir");
    expect(parts[2]).toBe("leaf.png");
  });
  test("drops empty segments from accidental double-slashes", () => {
    expect(sanitizeRelativePath("foo//bar")).toBe("foo/bar");
  });
  test("strips trailing dots/spaces per component", () => {
    expect(sanitizeRelativePath("foo. /bar")).toBe("foo/bar");
  });
  test("NFC-normalizes each segment", () => {
    const decomposed = "DALL·É";
    expect(sanitizeRelativePath(`Documents/${decomposed}.png`)).toBe("Documents/DALL·É.png");
  });
  test("single-segment path round-trips when already valid", () => {
    expect(sanitizeRelativePath("simple.txt")).toBe("simple.txt");
  });
});

describe("errReason", () => {
  test("formats ErrnoException with code prefix", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(errReason(err)).toBe("EACCES: permission denied");
  });
  test("falls back to message when no code", () => {
    expect(errReason(new Error("plain"))).toBe("plain");
  });
  test("stringifies non-Error values", () => {
    expect(errReason("oops")).toBe("oops");
  });
});

describe("errCode", () => {
  test("returns errno code when present", () => {
    const err = Object.assign(new Error("nope"), { code: "ENAMETOOLONG" });
    expect(errCode(err)).toBe("ENAMETOOLONG");
  });
  test("returns ERR fallback when no code", () => {
    expect(errCode(new Error("plain"))).toBe("ERR");
    expect(errCode("oops")).toBe("ERR");
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

describe("formatDuration", () => {
  test("formats sub-minute durations as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(499)).toBe("0s");
    expect(formatDuration(500)).toBe("1s");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(59_499)).toBe("59s");
  });
  test("formats minutes with optional seconds", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(78_000)).toBe("1m 18s");
    expect(formatDuration(5 * 60_000 + 12_000)).toBe("5m 12s");
    expect(formatDuration(59 * 60_000 + 59_000)).toBe("59m 59s");
  });
  test("formats hours with optional minutes", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(83 * 60_000)).toBe("1h 23m");
    expect(formatDuration(2 * 60 * 60_000)).toBe("2h");
  });
  test("clamps negatives to 0s", () => {
    expect(formatDuration(-5000)).toBe("0s");
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
