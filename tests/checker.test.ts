import { describe, expect, test } from "bun:test";
import { isNewerVersion, needsCheck } from "../src/update/checker.ts";

describe("isNewerVersion", () => {
  test("detects newer", () => {
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(true);
    expect(isNewerVersion("0.1.0", "1.0.0")).toBe(true);
  });
  test("rejects same / older", () => {
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.1", "0.1.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(false);
  });
});

describe("needsCheck", () => {
  test("true when no cache", () => {
    expect(needsCheck(undefined)).toBe(true);
  });
  test("false when cache is fresh", () => {
    expect(
      needsCheck({
        lastCheckAt: new Date().toISOString(),
        latestVersion: "0.1.0",
        hasUpdate: false,
      }),
    ).toBe(false);
  });
  test("true when cache is older than ttl", () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(needsCheck({ lastCheckAt: old, latestVersion: "0.1.0", hasUpdate: false })).toBe(true);
  });
});
