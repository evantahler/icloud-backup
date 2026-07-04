import { describe, expect, test } from "bun:test";
import { STATE_DIR } from "../src/constants.ts";
import { updater } from "../src/updater.ts";

// These lock our `upgradr` wiring (src/updater.ts), not the package internals.
describe("updater config", () => {
  test("cache lives under STATE_DIR", () => {
    expect(updater.config.cacheDir).toBe(STATE_DIR);
  });

  test("localDevEntry points at our entry, not upgradr's default", () => {
    // Our entry is src/index.ts, not upgradr's default src/cli.ts. Without this
    // override `bun run dev` would be misdetected as an npm/binary install.
    expect(updater.config.localDevEntry).toBe("src/index.ts");
  });
});
