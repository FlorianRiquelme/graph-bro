/**
 * Bounded worker pool (ADR-0011): drains a list of tasks K-at-a-time (default
 * K=5, per-topology override) instead of the unbounded `Promise.all` a naive
 * fan-out would use — branches are not cheap threads, each may be a Claude
 * Code subprocess + API call.
 *
 * Fail-fast (ADR-0006, §14.8): the moment any task rejects, no *new* task is
 * dispatched, but tasks already in flight (up to K-1 dispatched-but-not-yet-
 * complete) are never aborted — they run to completion so their (paid,
 * possibly durable) work isn't silently discarded.
 */

export const DEFAULT_MAX_CONCURRENCY = 5;

export interface PoolTask<T> {
  id: string;
  run: () => Promise<T>;
}

export interface PoolTaskResult<T> {
  id: string;
  status: "fulfilled" | "rejected";
  value?: T;
  error?: unknown;
}

export interface PoolResult<T> {
  /** Only tasks actually dispatched — a task never started (halted before its turn) has no entry. */
  results: PoolTaskResult<T>[];
  /** `true` once any dispatched task rejected. */
  failed: boolean;
  /** The first rejection observed (fail-fast halts on the first, not the last). */
  firstError?: unknown;
}

/**
 * Runs `tasks` through `concurrency` (default `DEFAULT_MAX_CONCURRENCY`)
 * concurrent workers, each pulling the next undispatched task in order. Exits
 * as soon as every dispatched task has settled — successful siblings drain
 * even after a failure is observed, matching ADR-0006's drain-in-flight
 * semantics.
 */
export async function runBoundedPool<T>(
  tasks: PoolTask<T>[],
  concurrency: number = DEFAULT_MAX_CONCURRENCY,
): Promise<PoolResult<T>> {
  const results: PoolTaskResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;
  let halted = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    for (;;) {
      if (halted) return;
      const index = nextIndex;
      if (index >= tasks.length) return;
      nextIndex += 1;
      const task = tasks[index];
      try {
        const value = await task.run();
        results[index] = { id: task.id, status: "fulfilled", value };
      } catch (error) {
        results[index] = { id: task.id, status: "rejected", error };
        if (!halted) {
          halted = true;
          firstError = error;
        }
      }
    }
  }

  const workerCount = tasks.length === 0 ? 0 : Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    results: results.filter((result): result is PoolTaskResult<T> => result !== undefined),
    failed: halted,
    firstError,
  };
}
