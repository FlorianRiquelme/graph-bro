import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { END } from "../../src/topology/schema.js";
import { runLoop, makeAgentNodeFn, type EngineGraph, type NodeFn } from "../../src/engine/loop.js";
import { openDb } from "../../src/store/db.js";
import { writeCheckpoint } from "../../src/store/checkpoints.js";
import { commitPendingWrite, createRun, resume } from "../../src/store/pending-writes.js";
import { listEvents } from "../../src/store/trace.js";
import { StubExecutor } from "../fixtures/stub-executor.js";
import type { Executor, RunOptions, RunResult } from "../../src/executor/executor.js";

/** Wraps an `Executor` and tracks the peak number of concurrently in-flight `run()` calls. */
class TrackingExecutor implements Executor {
  active = 0;
  peak = 0;
  constructor(private readonly inner: Executor) {}

  async run(prompt: string, options: RunOptions): Promise<RunResult> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await this.inner.run(prompt, options);
    } finally {
      this.active -= 1;
    }
  }
}

function fanOutGraph(overrides: Partial<EngineGraph> = {}): EngineGraph {
  return {
    plainEdges: [{ from: "collector", to: END }],
    fanOutEdges: [{ from: "dispatch", for_each: "batch.items", as: "item", to: "reader" }],
    joinBarriers: [
      { id: "join-reader", sources: ["reader"], mode: "all", reducer: "dedup", into: "results", to: "collector" },
    ],
    maxSteps: 20,
    ...overrides,
  };
}

function withStart(graph: EngineGraph): EngineGraph {
  return { ...graph, plainEdges: [{ from: "START", to: "dispatch" }, ...graph.plainEdges] };
}

describe("engine/fanout: bounded fan-out concurrency + fail-fast (U5)", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "graph-bro-fanout-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("Covers AE1: a fan-out of 17 items (stub executor) runs 17 branch tasks end-to-end through the pool; the join fires only after all 17", async () => {
    const items = Array.from({ length: 17 }, (_, i) => `item-${i}`);
    let collectorRuns = 0;
    const stub = new StubExecutor((prompt) => ({ text: prompt, isError: false }));
    const nodeFns: Record<string, NodeFn> = {
      dispatch: () => ({ batch: { items } }),
      reader: makeAgentNodeFn(stub, {
        nodeId: "reader",
        model: "stub-model",
        readOnly: true,
        cwd: ".",
        timeout: 1_000,
        outputKey: "results",
        prompt: (state) => state.item as string,
      }),
      collector: () => {
        collectorRuns += 1;
        return {};
      },
    };

    const result = await runLoop({ graph: withStart(fanOutGraph()), nodeFns });

    expect(result.status).toBe("completed");
    expect(stub.calls).toHaveLength(17); // every branch actually dispatched through the pool
    expect(new Set(result.state.results as string[])).toEqual(new Set(items));
    expect(collectorRuns).toBe(1); // join fired exactly once, only after all 17 arrived
  });

  it("concurrency bound: with K=5 (default) and N=17, peak concurrent executor invocations never exceeds 5", async () => {
    const items = Array.from({ length: 17 }, (_, i) => `item-${i}`);
    const stub = new StubExecutor(async (prompt) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { text: prompt, isError: false };
    });
    const tracking = new TrackingExecutor(stub);
    const nodeFns: Record<string, NodeFn> = {
      dispatch: () => ({ batch: { items } }),
      reader: makeAgentNodeFn(tracking, {
        nodeId: "reader",
        model: "stub-model",
        readOnly: true,
        cwd: ".",
        timeout: 1_000,
        outputKey: "results",
        prompt: (state) => state.item as string,
      }),
      collector: () => ({}),
    };

    const result = await runLoop({ graph: withStart(fanOutGraph()), nodeFns });

    expect(result.status).toBe("completed");
    expect(tracking.peak).toBeLessThanOrEqual(5);
    expect(tracking.peak).toBe(5); // real overlap is exercised, not just bounded
  });

  it("per-topology max_concurrency override is honored (e.g. K=2)", async () => {
    const items = Array.from({ length: 6 }, (_, i) => `item-${i}`);
    const stub = new StubExecutor(async (prompt) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { text: prompt, isError: false };
    });
    const tracking = new TrackingExecutor(stub);
    const nodeFns: Record<string, NodeFn> = {
      dispatch: () => ({ batch: { items } }),
      reader: makeAgentNodeFn(tracking, {
        nodeId: "reader",
        model: "stub-model",
        readOnly: true,
        cwd: ".",
        timeout: 1_000,
        outputKey: "results",
        prompt: (state) => state.item as string,
      }),
      collector: () => ({}),
    };

    const result = await runLoop({ graph: withStart(fanOutGraph({ maxConcurrency: 2 })), nodeFns });

    expect(result.status).toBe("completed");
    expect(tracking.peak).toBeLessThanOrEqual(2);
    expect(tracking.peak).toBe(2);
  });

  it("Covers AE3: one branch fails -> the run halts, the other branches' outputs are present, and the failure is visible in status + trace", async () => {
    const items = ["item-0", "item-1", "boom", "item-3", "item-4"];
    const db = openDb({ baseDir });
    const runId = "run-ae3";
    createRun(db, runId, process.pid);

    const stub = new StubExecutor((prompt) => {
      if (prompt === "boom") return { text: "boom failed", isError: true };
      return { text: prompt, isError: false };
    });
    const nodeFns: Record<string, NodeFn> = {
      dispatch: () => ({ batch: { items } }),
      reader: makeAgentNodeFn(stub, {
        nodeId: "reader",
        model: "stub-model",
        readOnly: true,
        cwd: ".",
        timeout: 1_000,
        outputKey: "results",
        prompt: (state) => state.item as string,
      }),
      collector: () => ({}),
    };

    const result = await runLoop({
      graph: withStart(fanOutGraph()),
      nodeFns,
      persistence: { db, runId },
    });

    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/boom/);
    // No silent loss: the 4 succeeding siblings' outputs are present.
    expect(new Set(result.state.results as string[])).toEqual(
      new Set(["item-0", "item-1", "item-3", "item-4"]),
    );

    const events = listEvents(db, runId);
    const failureEvent = events.find((e) => e.node === "reader" && JSON.stringify(e.payload).includes("boom"));
    expect(failureEvent).toBeDefined();

    db.close();
  });

  it("in-flight drain (ADR-0006): siblings still executing when a branch fails drain and commit, no new branches dispatch, then the run halts", async () => {
    const items = ["boom", "item-1", "item-2", "item-3", "item-4"];
    const db = openDb({ baseDir });
    const runId = "run-drain";
    createRun(db, runId, process.pid);

    const gates = new Map<string, { resolve: () => void; promise: Promise<void> }>();
    for (const item of items) {
      if (item === "boom") continue;
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      gates.set(item, { resolve, promise });
    }

    const stub = new StubExecutor(async (prompt) => {
      if (prompt === "boom") throw new Error("branch failed: boom");
      await gates.get(prompt)!.promise;
      return { text: prompt, isError: false };
    });
    const nodeFns: Record<string, NodeFn> = {
      dispatch: () => ({ batch: { items } }),
      reader: makeAgentNodeFn(stub, {
        nodeId: "reader",
        model: "stub-model",
        readOnly: true,
        cwd: ".",
        timeout: 1_000,
        outputKey: "results",
        prompt: (state) => state.item as string,
      }),
      collector: () => ({}),
    };

    const resultPromise = runLoop({
      graph: withStart(fanOutGraph()), // K=5 default, N=5: all 5 dispatch together
      nodeFns,
      persistence: { db, runId },
    });

    // Give the pool a tick to dispatch all 5 and let "boom" reject.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stub.calls).toHaveLength(5); // all 5 dispatched — none held back before the failure surfaced

    // Only now release the in-flight siblings — proves they kept running
    // (and are allowed to commit) after the failure was observed.
    for (const gate of gates.values()) gate.resolve();

    const result = await resultPromise;

    expect(result.status).toBe("failed");
    expect(new Set(result.state.results as string[])).toEqual(
      new Set(["item-1", "item-2", "item-3", "item-4"]),
    );

    db.close();
  });

  it("Crash mid-drain (kill after 12 of 17): resume re-enters only the 5 uncompleted branches; the 12 are not re-run", async () => {
    const items = Array.from({ length: 17 }, (_, i) => `item-${i}`);
    const db = openDb({ baseDir });
    const runId = "run-crash";
    createRun(db, runId, process.pid);

    // The engine would have checkpointed the reader step's frontier before
    // dispatch (step 0 completed -> dispatch ran; step 1 is the 17 readers).
    writeCheckpoint(db, runId, {
      state: { batch: { items } },
      frontier: items.map((item, i) => ({
        nodeId: "reader",
        instanceId: `reader:idx:${i}`,
        binding: { key: "item", value: item },
      })),
      barrier: {},
      step: 0,
    });

    // 12 of the 17 branches complete and durably commit before the "crash".
    for (let i = 0; i < 12; i += 1) {
      commitPendingWrite(db, {
        runId,
        node: "reader",
        step: 1,
        itemKey: `idx:${i}`,
        triggers: [],
        writes: { results: items[i] },
      });
    }

    const resumed = resume(db, runId, { reducerForKey: (key) => (key === "results" ? "dedup" : undefined) });
    expect(resumed.completedInstanceIds.size).toBe(12);
    expect(resumed.frontier).toHaveLength(5);

    const stub = new StubExecutor((prompt) => ({ text: prompt, isError: false }));
    const nodeFns: Record<string, NodeFn> = {
      reader: makeAgentNodeFn(stub, {
        nodeId: "reader",
        model: "stub-model",
        readOnly: true,
        cwd: ".",
        timeout: 1_000,
        outputKey: "results",
        prompt: (state) => state.item as string,
      }),
      collector: () => ({}),
    };

    const result = await runLoop({
      graph: fanOutGraph({ fanOutEdges: [] }), // dispatch already ran pre-crash; not re-executed on resume
      nodeFns,
      initialState: resumed.state,
      initialFrontier: resumed.frontier,
      initialStep: resumed.step,
      // The barrier's per-instance universe (KTD-12) is only ever armed by
      // re-running the fan-out node's transition; a resumed run skips that,
      // so the resume caller primes it directly from the same runtime facts
      // `resume()` already reconstructed (the full item list + which
      // instances already arrived).
      initialBarrierState: [
        {
          source: "reader",
          expectedInstanceIds: items.map((_, i) => `reader:idx:${i}`),
          arrivedInstanceIds: [...resumed.completedInstanceIds],
        },
      ],
      persistence: { db, runId },
    });

    expect(result.status).toBe("completed");
    expect(stub.calls).toHaveLength(5); // only the 5 uncompleted branches re-run
    expect(new Set(result.state.results as string[])).toEqual(new Set(items));

    db.close();
  });

  it("resume after a transient branch failure retries only the failed branch", async () => {
    const items = ["item-0", "boom", "item-2"];
    const db = openDb({ baseDir });
    const runId = "run-retry";
    createRun(db, runId, process.pid);

    const stub = new StubExecutor((prompt) => {
      if (prompt === "boom") return { text: "transient failure", isError: true };
      return { text: prompt, isError: false };
    });
    const nodeFns: Record<string, NodeFn> = {
      dispatch: () => ({ batch: { items } }),
      reader: makeAgentNodeFn(stub, {
        nodeId: "reader",
        model: "stub-model",
        readOnly: true,
        cwd: ".",
        timeout: 1_000,
        outputKey: "results",
        prompt: (state) => state.item as string,
      }),
      collector: () => ({}),
    };

    const first = await runLoop({ graph: withStart(fanOutGraph()), nodeFns, persistence: { db, runId } });
    expect(first.status).toBe("failed");
    expect(stub.calls).toHaveLength(3); // dispatch's 3 branches all ran once (K=5 >= N=3)

    const resumed = resume(db, runId, { reducerForKey: (key) => (key === "results" ? "dedup" : undefined) });
    expect(resumed.frontier).toHaveLength(1); // only "boom"'s branch is outstanding
    expect(resumed.frontier[0].instanceId).toBe("reader:idx:1");

    // The retry now succeeds.
    const retryStub = new StubExecutor((prompt) => ({ text: prompt, isError: false }));
    const retryNodeFns: Record<string, NodeFn> = {
      reader: makeAgentNodeFn(retryStub, {
        nodeId: "reader",
        model: "stub-model",
        readOnly: true,
        cwd: ".",
        timeout: 1_000,
        outputKey: "results",
        prompt: (state) => state.item as string,
      }),
      collector: () => ({}),
    };

    const second = await runLoop({
      graph: fanOutGraph({ fanOutEdges: [] }),
      nodeFns: retryNodeFns,
      initialState: resumed.state,
      initialFrontier: resumed.frontier,
      initialStep: resumed.step,
      initialBarrierState: [
        {
          source: "reader",
          expectedInstanceIds: items.map((_, i) => `reader:idx:${i}`),
          arrivedInstanceIds: [...resumed.completedInstanceIds],
        },
      ],
      persistence: { db, runId },
    });

    expect(second.status).toBe("completed");
    expect(retryStub.calls).toHaveLength(1); // only the previously-failed branch retried, not the other 2
    expect(new Set(second.state.results as string[])).toEqual(new Set(items));

    db.close();
  });
});
