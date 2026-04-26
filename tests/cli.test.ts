import { describe, expect, test } from "bun:test";
import { buildProgram, flagsFromOpts } from "../src/cli.ts";

function parseFlags(argv: string[]) {
  const program = buildProgram();
  program.exitOverride();
  program.parse(argv, { from: "user" });
  return flagsFromOpts(program.opts());
}

describe("CLI flag parsing", () => {
  test("--all expands to four lanes", () => {
    const f = parseFlags(["--all", "/Volumes/x"]);
    expect(f.lanes.map((l) => l.service)).toEqual(["photos", "drive", "notes", "contacts"]);
    expect(f.lanes.every((l) => l.dest === "/Volumes/x")).toBe(true);
  });

  test("per-service flag overrides --all", () => {
    const f = parseFlags(["--all", "/Volumes/main", "--photos", "/Volumes/photos"]);
    const byService = Object.fromEntries(f.lanes.map((l) => [l.service, l.dest]));
    expect(byService.photos).toBe("/Volumes/photos");
    expect(byService.drive).toBe("/Volumes/main");
    expect(byService.notes).toBe("/Volumes/main");
    expect(byService.contacts).toBe("/Volumes/main");
  });

  test("only specified services produce lanes", () => {
    const f = parseFlags(["--notes", "/n", "--contacts", "/c"]);
    expect(f.lanes.map((l) => l.service)).toEqual(["notes", "contacts"]);
  });

  test("doctor / rebuild / upgrade flags surface", () => {
    expect(parseFlags(["--doctor"]).doctor).toBe(true);
    expect(parseFlags(["--rebuild", "--all", "/x"]).rebuild).toBe(true);
    expect(parseFlags(["--upgrade"]).upgrade).toBe(true);
    expect(parseFlags(["--check-update"]).checkUpdate).toBe(true);
  });

  test("no flags → no lanes, no actions", () => {
    const f = parseFlags([]);
    expect(f.lanes).toEqual([]);
    expect(f.doctor).toBe(false);
    expect(f.rebuild).toBe(false);
  });
});
