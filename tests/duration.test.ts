import { describe, expect, test } from "bun:test";
import { parseDuration } from "../src/duration.ts";

describe("parseDuration", () => {
  test("parses unit suffixes to milliseconds", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("12h")).toBe(43_200_000);
    expect(parseDuration("90m")).toBe(5_400_000);
    expect(parseDuration("30s")).toBe(30_000);
  });

  test("treats a bare integer as seconds", () => {
    expect(parseDuration("3600")).toBe(3_600_000);
    expect(parseDuration("0")).toBe(0);
  });

  test("trims surrounding whitespace", () => {
    expect(parseDuration("  2d ")).toBe(172_800_000);
  });

  test("allows a zero-length window", () => {
    expect(parseDuration("0d")).toBe(0);
  });

  test("throws on invalid input", () => {
    expect(() => parseDuration("")).toThrow();
    expect(() => parseDuration("-1d")).toThrow();
    expect(() => parseDuration("1.5d")).toThrow();
    expect(() => parseDuration("1w")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
    expect(() => parseDuration("d")).toThrow();
  });
});
