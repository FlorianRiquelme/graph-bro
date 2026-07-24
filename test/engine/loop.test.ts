import { describe, expect, it } from "vitest";
import { END, START } from "../../src/topology/schema.js";
import { runLoop, MaxStepsExceededError, type EngineGraph, type NodeFn } from "../../src/engine/loop.js";
import { UnreachableJoinError } from "../../src/engine/watchdog.js";

function emptyGraph(overrides: Partial<EngineGraph>): EngineGraph {
  return {
    plainEdges: [],
    fanOutEdges: [],
    joinBarriers: [],
    maxSteps: 100,
    ...overrides,
  };
}

describe("runLoop", () => {
  it("happy path: a linear topology runs to completion", async () => {
    const graph = emptyGraph({
      plainEdges: [
        { from: START, to: "A" },
        { from: "A", to: "B" },
        { from: "B", to: END },
      ],
    });
    const nodeFns: Record<string, NodeFn> = {
      A: () => ({ a: 1 }),
      B: (state) => ({ b: (state.a as number) + 1 }),
    };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("completed");
    expect(result.state).toEqual({ a: 1, b: 2 });
    expect(result.steps).toBe(2);
  });

  it("happy path: a two-branch-into-join topology runs to completion, join fires exactly once", async () => {
    let collectorRuns = 0;
    const graph = emptyGraph({
      plainEdges: [
        { from: START, to: "A" },
        { from: START, to: "B" },
        { from: "collector", to: END },
      ],
      joinBarriers: [
        { id: "join1", sources: ["A", "B"], mode: "all", reducer: "append", into: "results", to: "collector" },
      ],
    });
    const nodeFns: Record<string, NodeFn> = {
      A: () => ({ results: "a" }),
      B: () => ({ results: "b" }),
      collector: () => {
        collectorRuns += 1;
        return {};
      },
    };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual(["a", "b"]);
    expect(collectorRuns).toBe(1);
  });

  it("a join whose `to` targets END directly (no intermediate node) completes the run", async () => {
    const graph = emptyGraph({
      plainEdges: [
        { from: START, to: "A" },
        { from: START, to: "B" },
      ],
      joinBarriers: [
        { id: "join-to-end", sources: ["A", "B"], mode: "all", reducer: "append", into: "results", to: END },
      ],
    });
    const nodeFns: Record<string, NodeFn> = {
      A: () => ({ results: "a" }),
      B: () => ({ results: "b" }),
    };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual(["a", "b"]);
  });

  it("snapshot isolation: two nodes in one super-step don't observe each other's writes", async () => {
    const graph = emptyGraph({
      plainEdges: [
        { from: START, to: "A" },
        { from: START, to: "B" },
        { from: "A", to: END },
        { from: "B", to: END },
      ],
    });
    const nodeFns: Record<string, NodeFn> = {
      A: (state) => ({ shared: 10, aSaw: state.shared }),
      B: (state) => ({ bSaw: state.shared }),
    };

    const result = await runLoop({ graph, nodeFns, initialState: { shared: 5 } });

    expect(result.status).toBe("completed");
    expect(result.state.aSaw).toBe(5);
    expect(result.state.bSaw).toBe(5); // not 10 — B never observed A's mid-step write
  });

  it("Covers AE1: a fan-out of 17 executes 17 branch instances and the join fires only after all 17 arrive", async () => {
    const items = Array.from({ length: 17 }, (_, i) => `item-${i}`);
    const graph = emptyGraph({
      plainEdges: [
        { from: START, to: "dispatch" },
        { from: "collector", to: END },
      ],
      fanOutEdges: [{ from: "dispatch", for_each: "batch.items", as: "item", to: "reader" }],
      joinBarriers: [
        { id: "join-reader", sources: ["reader"], mode: "all", reducer: "dedup", into: "results", to: "collector" },
      ],
    });
    let collectorRuns = 0;
    const nodeFns: Record<string, NodeFn> = {
      dispatch: () => ({ batch: { items } }),
      reader: (state) => ({ results: state.item }),
      collector: () => {
        collectorRuns += 1;
        return {};
      },
    };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("completed");
    expect(result.state.results).toHaveLength(17);
    expect(new Set(result.state.results as string[])).toEqual(new Set(items));
    expect(collectorRuns).toBe(1);
  });

  it("Covers AE4: a run exceeding max_steps halts with a visible failure status, not a hang", async () => {
    const graph = emptyGraph({
      plainEdges: [
        { from: START, to: "A" },
        { from: "A", to: "A" },
      ],
      maxSteps: 5,
    });
    const nodeFns: Record<string, NodeFn> = { A: () => ({}) };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(MaxStepsExceededError);
  });

  it("dead_end is reported distinctly from failed when the frontier empties without END", async () => {
    const graph = emptyGraph({
      plainEdges: [{ from: START, to: "A" }],
    });
    const nodeFns: Record<string, NodeFn> = { A: () => ({}) };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("dead_end");
    expect(result.error).toBeUndefined();
  });

  it("loud-fail: two nodes writing differing values to an unreduced key raise StateConflictError", async () => {
    const graph = emptyGraph({
      plainEdges: [
        { from: START, to: "A" },
        { from: START, to: "B" },
        { from: "A", to: END },
        { from: "B", to: END },
      ],
    });
    const nodeFns: Record<string, NodeFn> = {
      A: () => ({ answer: 1 }),
      B: () => ({ answer: 2 }),
    };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("failed");
    expect(result.error?.name).toBe("StateConflictError");
  });

  it("watchdog raises UnreachableJoinError naming the stalled join when a declared source never reports", async () => {
    const graph = emptyGraph({
      plainEdges: [{ from: START, to: "A" }],
      joinBarriers: [
        { id: "join-stalled", sources: ["A", "B"], mode: "all", reducer: "append", into: "results", to: "collector" },
      ],
    });
    const nodeFns: Record<string, NodeFn> = { A: () => ({}) };

    await expect(runLoop({ graph, nodeFns })).rejects.toThrow(UnreachableJoinError);
  });

  it(
    "resuming a 2-static-source join whose sources completed in different pre-crash super-steps raises " +
      "UnreachableJoinError rather than silently reporting dead_end (documented KTD-12 scope limitation, pinned)",
    async () => {
      // Mirrors runtime/run.ts's reconstructBarrierState: it only reconstructs
      // arrival state for a join fed by a fan-out edge (KTD-12's shape); a
      // join with 2+ distinct static (non-fan-out) declared sources gets NO
      // initialBarrierState at all, exactly as if source A's pre-crash
      // arrival was never durably recorded (it isn't — the checkpoint's
      // `barrier` field is unpopulated). This is a genuine slice-1 gap the
      // driving workload never exercises (its only join has one dynamic
      // fan-out source); this test exists to prove the failure mode is loud,
      // not silent data loss.
      const graph = emptyGraph({
        joinBarriers: [
          { id: "join-static", sources: ["A", "B"], mode: "all", reducer: "append", into: "results", to: "collector" },
        ],
      });
      const nodeFns: Record<string, NodeFn> = { B: () => ({ results: "b" }) };

      // Simulates: A already completed and its write ("a") is already folded
      // into state from an earlier super-step; only B is still outstanding
      // in the resumed frontier. No initialBarrierState is supplied for this
      // join — a static source gets none, by design (see comment above).
      await expect(
        runLoop({
          graph,
          nodeFns,
          initialState: { results: ["a"] },
          initialFrontier: [{ nodeId: "B", instanceId: "B" }],
          initialStep: 1,
        }),
      ).rejects.toThrow(UnreachableJoinError);
    },
  );
});
