import { describe, expect, test } from "bun:test";
import { EventQueue, runPool } from "../src/concurrency.ts";

describe("runPool", () => {
  test("runs every item exactly once", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const seen: number[] = [];
    await runPool(items, 5, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  test("respects the concurrency cap", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    let inflight = 0;
    let peak = 0;
    await runPool(items, 5, async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 1));
      inflight--;
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  test("drains when items < concurrency", async () => {
    const seen: number[] = [];
    await runPool([1, 2], 10, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2]);
  });

  test("empty iterable returns immediately", async () => {
    await runPool<number>([], 5, async () => {
      throw new Error("should not be called");
    });
  });

  test("propagates worker errors", async () => {
    const promise = runPool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
    });
    await expect(promise).rejects.toThrow("boom");
  });

  test("clamps concurrency below 1 to 1", async () => {
    let inflight = 0;
    let peak = 0;
    await runPool([1, 2, 3], 0, async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 1));
      inflight--;
    });
    expect(peak).toBe(1);
  });
});

describe("EventQueue", () => {
  test("delivers events in push order to a single consumer", async () => {
    const q = new EventQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  test("blocks consumer until push, then releases", async () => {
    const q = new EventQueue<string>();
    const consumed: string[] = [];
    const consumer = (async () => {
      for await (const v of q) consumed.push(v);
    })();
    await new Promise((r) => setTimeout(r, 10));
    expect(consumed).toEqual([]);
    q.push("a");
    await new Promise((r) => setTimeout(r, 10));
    expect(consumed).toEqual(["a"]);
    q.close();
    await consumer;
  });

  test("drains buffered events before signalling done", async () => {
    const q = new EventQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    q.push(3); // ignored after close
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1, 2]);
  });

  test("close releases pending waiters", async () => {
    const q = new EventQueue<number>();
    const consumer = (async () => {
      const out: number[] = [];
      for await (const v of q) out.push(v);
      return out;
    })();
    await new Promise((r) => setTimeout(r, 10));
    q.close();
    expect(await consumer).toEqual([]);
  });
});
