/**
 * Run `worker(item)` over `items` with at most `concurrency` calls in flight.
 * Workers share a single iterator, so each item runs exactly once. Per-item
 * errors are the worker's responsibility — uncaught throws will reject the
 * returned promise and abort the pool.
 */
export async function runPool<T>(
  items: Iterable<T>,
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const it = items[Symbol.iterator]();
  const n = Math.max(1, Math.floor(concurrency));
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      const next = it.next();
      if (next.done) return;
      await worker(next.value);
    }
  });
  await Promise.all(workers);
}

/**
 * Single-consumer async queue. Producers call `push`; one consumer iterates
 * with `for await`. `close()` ends the iteration after buffered events drain.
 */
export class EventQueue<E> implements AsyncIterable<E> {
  private buf: E[] = [];
  private waiters: ((v: IteratorResult<E>) => void)[] = [];
  private closed = false;

  push(e: E): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: e, done: false });
    else this.buf.push(e);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      const w = this.waiters.shift();
      if (w) w({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<E> {
    return {
      next: () =>
        new Promise<IteratorResult<E>>((resolve) => {
          if (this.buf.length) {
            resolve({ value: this.buf.shift() as E, done: false });
          } else if (this.closed) {
            resolve({ value: undefined as never, done: true });
          } else {
            this.waiters.push(resolve);
          }
        }),
    };
  }
}
