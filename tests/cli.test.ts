import { describe, expect, test } from "bun:test";
import { buildProgram, DEFAULT_CONCURRENCY, type Intent } from "../src/cli.ts";

function parseIntent(argv: string[]): Intent {
  let captured: Intent | null = null;
  const program = buildProgram((i) => {
    captured = i;
  });
  program.exitOverride();
  program.parse(argv, { from: "user" });
  if (!captured) throw new Error("no intent captured");
  return captured;
}

describe("CLI subcommand parsing", () => {
  test("photos <dest> → backup intent for photos lane", () => {
    const i = parseIntent(["photos", "/Volumes/x"]);
    expect(i).toEqual({
      kind: "backup",
      lanes: [{ service: "photos", dest: "/Volumes/x" }],
      snapshot: true,
      concurrency: DEFAULT_CONCURRENCY,
    });
  });

  test("each service subcommand produces a single-lane backup", () => {
    for (const service of ["photos", "drive", "notes", "contacts"] as const) {
      const i = parseIntent([service, "/dest"]);
      expect(i.kind).toBe("backup");
      if (i.kind !== "backup") throw new Error("unreachable");
      expect(i.lanes).toEqual([{ service, dest: "/dest" }]);
    }
  });

  test("all <dest> expands to four lanes sharing the destination", () => {
    const i = parseIntent(["all", "/Volumes/x"]);
    expect(i.kind).toBe("backup");
    if (i.kind !== "backup") throw new Error("unreachable");
    expect(i.lanes.map((l) => l.service)).toEqual(["photos", "drive", "notes", "contacts"]);
    expect(i.lanes.every((l) => l.dest === "/Volumes/x")).toBe(true);
  });

  test("--no-manifest-snapshot turns snapshot off on backup commands", () => {
    expect(parseIntent(["all", "/x"])).toMatchObject({ snapshot: true });
    expect(parseIntent(["all", "/x", "--no-manifest-snapshot"])).toMatchObject({ snapshot: false });
    expect(parseIntent(["notes", "/x", "--no-manifest-snapshot"])).toMatchObject({
      snapshot: false,
    });
  });

  test("--concurrency defaults to 5 on every backup command", () => {
    for (const cmd of ["photos", "drive", "notes", "contacts", "all"]) {
      expect(parseIntent([cmd, "/x"])).toMatchObject({ concurrency: 5 });
    }
  });

  test("--concurrency parses an integer", () => {
    expect(parseIntent(["all", "/x", "--concurrency", "10"])).toMatchObject({ concurrency: 10 });
    expect(parseIntent(["all", "/x", "--concurrency", "1"])).toMatchObject({ concurrency: 1 });
    expect(parseIntent(["all", "/x", "--concurrency", "64"])).toMatchObject({ concurrency: 64 });
    expect(parseIntent(["notes", "/x", "--concurrency", "12"])).toMatchObject({ concurrency: 12 });
  });

  test("--concurrency rejects out-of-range and non-integer values", () => {
    expect(() => parseIntent(["all", "/x", "--concurrency", "0"])).toThrow();
    expect(() => parseIntent(["all", "/x", "--concurrency", "-1"])).toThrow();
    expect(() => parseIntent(["all", "/x", "--concurrency", "65"])).toThrow();
    expect(() => parseIntent(["all", "/x", "--concurrency", "abc"])).toThrow();
    expect(() => parseIntent(["all", "/x", "--concurrency", "1.5"])).toThrow();
  });

  test("doctor with no dest → empty lanes", () => {
    expect(parseIntent(["doctor"])).toEqual({ kind: "doctor", lanes: [] });
  });

  test("doctor <dest> → lanes for all services pointing at dest", () => {
    const i = parseIntent(["doctor", "/d"]);
    expect(i.kind).toBe("doctor");
    if (i.kind !== "doctor") throw new Error("unreachable");
    expect(i.lanes.map((l) => l.service)).toEqual(["photos", "drive", "notes", "contacts"]);
    expect(i.lanes.every((l) => l.dest === "/d")).toBe(true);
  });

  test("rebuild <dest> → lanes for all services", () => {
    const i = parseIntent(["rebuild", "/d"]);
    expect(i.kind).toBe("rebuild");
    if (i.kind !== "rebuild") throw new Error("unreachable");
    expect(i.lanes.map((l) => l.service)).toEqual(["photos", "drive", "notes", "contacts"]);
  });

  test("rebuild --service <name> filters to one lane", () => {
    const i = parseIntent(["rebuild", "/d", "--service", "notes"]);
    expect(i.kind).toBe("rebuild");
    if (i.kind !== "rebuild") throw new Error("unreachable");
    expect(i.lanes).toEqual([{ service: "notes", dest: "/d" }]);
  });

  test("upgrade and check-update produce their own intents", () => {
    expect(parseIntent(["upgrade"])).toEqual({ kind: "upgrade" });
    expect(parseIntent(["check-update"])).toEqual({ kind: "checkUpdate" });
  });
});
