import { describe, expect, it } from "vitest";
import { runBoundedPool, DEFAULT_MAX_CONCURRENCY, type PoolTask } from "../../src/engine/concurrency.js";

/** A deferred, resolved externally — lets a test control exactly when a task finishes. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTasks(n: number, behavior: (index: number) => Promise<number>): PoolTask<number>[] {
  return Array.from({ length: n }, (_, i) => ({ id: `task-${i}`, run: () => behavior(i) }));
}

describe("engine/concurrency: runBoundedPool", () => {
  it("default concurrency is 5", () => {
    expect(DEFAULT_MAX_CONCURRENCY).toBe(5);
  });

  it("drains all tasks and returns their fulfilled results in order", async () => {
    const tasks = makeTasks(17, async (i) => i * 2);
    const result = await runBoundedPool(tasks);

    expect(result.failed).toBe(false);
    expect(result.results).toHaveLength(17);
    expect(result.results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(result.results.map((r) => r.value)).toEqual(Array.from({ length: 17 }, (_, i) => i * 2));
  });

  it("concurrency bound: with K=5 and N=17, peak concurrent invocations never exceeds 5", async () => {
    let active = 0;
    let peak = 0;
    const tasks = makeTasks(17, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return active;
    });

    await runBoundedPool(tasks, 5);

    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBe(5); // real parallelism is actually exercised, not just bounded
  });

  it("per-topology max_concurrency override is honored (e.g. K=2)", async () => {
    let active = 0;
    let peak = 0;
    const tasks = makeTasks(6, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return active;
    });

    await runBoundedPool(tasks, 2);

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  });

  it("fail-fast: halts new dispatch on the first rejection but drains in-flight siblings to completion", async () => {
    const started: number[] = [];
    const completed: number[] = [];
    const gates = Array.from({ length: 5 }, () => deferred<void>());

    const tasks = makeTasks(5, async (i) => {
      started.push(i);
      if (i === 0) {
        // Fails immediately, before its siblings (1-4, dispatched alongside it at K=5) finish.
        throw new Error("branch 0 failed");
      }
      await gates[i].promise;
      completed.push(i);
      return i;
    });

    const poolPromise = runBoundedPool(tasks, 5);

    // Give the pool a tick to dispatch all 5 (K=5, N=5) and let task 0 reject.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toHaveLength(5); // all 5 dispatched — K=5 covers N=5

    // Release the in-flight siblings only now — proves they were allowed to
    // keep running after the failure, not aborted.
    for (let i = 1; i < 5; i += 1) gates[i].resolve();

    const result = await poolPromise;

    expect(result.failed).toBe(true);
    expect(completed.sort()).toEqual([1, 2, 3, 4]); // siblings drained, not discarded
    const rejected = result.results.find((r) => r.status === "rejected");
    expect(rejected?.id).toBe("task-0");
    const fulfilledIds = result.results.filter((r) => r.status === "fulfilled").map((r) => r.id);
    expect(fulfilledIds.sort()).toEqual(["task-1", "task-2", "task-3", "task-4"]);
  });

  it("fail-fast with K < N: no new branch dispatches once a failure is seen", async () => {
    const started: number[] = [];
    const tasks = makeTasks(6, async (i) => {
      started.push(i);
      if (i === 0) throw new Error("branch 0 failed");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return i;
    });

    const result = await runBoundedPool(tasks, 2);

    expect(result.failed).toBe(true);
    // K=2: task 0 and task 1 dispatch together; 0 fails immediately, halting
    // new dispatch — task 1 (already in flight) drains, tasks 2-5 never start.
    expect(started).toEqual([0, 1]);
    expect(result.results).toHaveLength(2);
  });
});
