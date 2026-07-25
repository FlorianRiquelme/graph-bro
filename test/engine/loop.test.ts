import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { END, START } from "../../src/topology/schema.js";
import {
  runLoop,
  makeAgentNodeFn,
  ConcurrentWriteViolationError,
  MaxStepsExceededError,
  UnmatchedRouterError,
  type EngineGraph,
  type NodeFn,
} from "../../src/engine/loop.js";
import { UnreachableJoinError } from "../../src/engine/watchdog.js";
import { MissingStructuredOutputError, OutputSchemaViolationError } from "../../src/engine/output-schema.js";
import { StubExecutor } from "../fixtures/stub-executor.js";
import { openDb } from "../../src/store/db.js";
import { createRun } from "../../src/store/pending-writes.js";
import { listEvents } from "../../src/store/trace.js";
import { readLatestCheckpoint } from "../../src/store/checkpoints.js";

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

describe("engine/loop: makeAgentNodeFn — declared output schema (U1, R2/AE2)", () => {
  const SCHEMA = {
    type: "object",
    properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
    required: ["verdict"],
  };

  function graphThroughReviewer(): EngineGraph {
    return {
      plainEdges: [
        { from: START, to: "reviewer" },
        { from: "reviewer", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
    };
  }

  it("Covers AE2: a conforming structured response lands as the parsed object (not a string) at output_key", async () => {
    const stub = new StubExecutor(() => ({
      text: '{"verdict":"pass"}',
      isError: false,
      structuredOutput: { verdict: "pass" },
    }));
    const nodeFns: Record<string, NodeFn> = {
      reviewer: makeAgentNodeFn(stub, {
        nodeId: "reviewer",
        model: "stub-model",
        capability: "read_only",
        cwd: ".",
        timeout: 1_000,
        outputKey: "review",
        outputSchema: SCHEMA,
        prompt: "review it",
      }),
    };

    const result = await runLoop({ graph: graphThroughReviewer(), nodeFns });

    expect(result.status).toBe("completed");
    expect(result.state.review).toEqual({ verdict: "pass" });
    expect(typeof result.state.review).not.toBe("string");
  });

  it("Covers AE2: a non-conforming structured response fails the run, naming the node and the violation", async () => {
    const stub = new StubExecutor(() => ({
      text: '{"verdict":"maybe"}',
      isError: false,
      structuredOutput: { verdict: "maybe" },
    }));
    const nodeFns: Record<string, NodeFn> = {
      reviewer: makeAgentNodeFn(stub, {
        nodeId: "reviewer",
        model: "stub-model",
        capability: "read_only",
        cwd: ".",
        timeout: 1_000,
        outputKey: "review",
        outputSchema: SCHEMA,
        prompt: "review it",
      }),
    };

    const result = await runLoop({ graph: graphThroughReviewer(), nodeFns });

    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(OutputSchemaViolationError);
    expect(result.error?.message).toContain("reviewer");
  });

  it("an envelope missing structured_output while a schema was declared fails the run, not an empty success", async () => {
    const stub = new StubExecutor(() => ({ text: "", isError: false })); // no structuredOutput field at all
    const nodeFns: Record<string, NodeFn> = {
      reviewer: makeAgentNodeFn(stub, {
        nodeId: "reviewer",
        model: "stub-model",
        capability: "read_only",
        cwd: ".",
        timeout: 1_000,
        outputKey: "review",
        outputSchema: SCHEMA,
        prompt: "review it",
      }),
    };

    const result = await runLoop({ graph: graphThroughReviewer(), nodeFns });

    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(MissingStructuredOutputError);
  });

  it("with no schema declared, the text result lands at output_key unchanged (slice-1 behavior)", async () => {
    const stub = new StubExecutor(() => ({ text: "plain text result", isError: false }));
    const nodeFns: Record<string, NodeFn> = {
      reviewer: makeAgentNodeFn(stub, {
        nodeId: "reviewer",
        model: "stub-model",
        capability: "read_only",
        cwd: ".",
        timeout: 1_000,
        outputKey: "review",
        prompt: "review it",
      }),
    };

    const result = await runLoop({ graph: graphThroughReviewer(), nodeFns });

    expect(result.status).toBe("completed");
    expect(result.state.review).toBe("plain text result");
  });
});

describe("engine/loop: when evaluation, routing trace, loud unmatched router (U3, R1/R3/R24, KTD-6)", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "graph-bro-loop-when-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("Covers AE1: two guarded out-edges, state satisfying exactly one — only that target activates", async () => {
    const graph: EngineGraph = {
      plainEdges: [
        { from: START, to: "router" },
        { from: "router", to: "branch_a", when: { key: "choice", equals: "a" } },
        { from: "router", to: "branch_b", when: { key: "choice", equals: "b" } },
        { from: "branch_a", to: END },
        { from: "branch_b", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
    };
    const ran: string[] = [];
    const nodeFns: Record<string, NodeFn> = {
      router: () => ({ choice: "a" }),
      branch_a: () => {
        ran.push("branch_a");
        return {};
      },
      branch_b: () => {
        ran.push("branch_b");
        return {};
      },
    };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("completed");
    expect(ran).toEqual(["branch_a"]);
  });

  it("Covers AE3: every out-edge guarded, none satisfied — fails naming the node, each rule, and the values read; not dead_end", async () => {
    const graph: EngineGraph = {
      plainEdges: [
        { from: START, to: "router" },
        { from: "router", to: "branch_a", when: { key: "choice", equals: "a" } },
        { from: "router", to: "branch_b", when: { key: "choice", equals: "b" } },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
    };
    const nodeFns: Record<string, NodeFn> = { router: () => ({ choice: "c" }) };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("failed");
    expect(result.status).not.toBe("dead_end");
    expect(result.error).toBeInstanceOf(UnmatchedRouterError);
    const error = result.error as UnmatchedRouterError;
    expect(error.nodeId).toBe("router");
    expect(error.message).toContain("router");
    expect(error.message).toContain("branch_a");
    expect(error.message).toContain("branch_b");
    expect(error.message).toContain("choice");
  });

  it("an unguarded plain edge is still traversed unconditionally (slice-1 behavior unchanged)", async () => {
    const graph: EngineGraph = {
      plainEdges: [
        { from: START, to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
    };
    const nodeFns: Record<string, NodeFn> = { a: () => ({}), b: () => ({}) };

    const result = await runLoop({ graph, nodeFns });
    expect(result.status).toBe("completed");
  });

  it("a mix of guarded (unsatisfied) and unguarded out-edges: the unguarded edge always fires, no unmatched-router failure", async () => {
    const graph: EngineGraph = {
      plainEdges: [
        { from: START, to: "router" },
        { from: "router", to: "guarded_target", when: { key: "choice", equals: "never" } },
        { from: "router", to: "fallback" },
        { from: "guarded_target", to: END },
        { from: "fallback", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
    };
    const ran: string[] = [];
    const nodeFns: Record<string, NodeFn> = {
      router: () => ({ choice: "irrelevant" }),
      guarded_target: () => {
        ran.push("guarded_target");
        return {};
      },
      fallback: () => {
        ran.push("fallback");
        return {};
      },
    };

    const result = await runLoop({ graph, nodeFns });
    expect(result.status).toBe("completed");
    expect(ran).toEqual(["fallback"]);
  });

  it("a node with no out-edges still reports dead_end, not the unmatched-router error", async () => {
    const graph: EngineGraph = {
      plainEdges: [{ from: START, to: "sink" }],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
    };
    const nodeFns: Record<string, NodeFn> = { sink: () => ({}) };

    const result = await runLoop({ graph, nodeFns });
    expect(result.status).toBe("dead_end");
  });

  it("a stalled join still reports UnreachableJoinError, not the unmatched-router error, even with a guarded edge in play", async () => {
    const graph: EngineGraph = {
      plainEdges: [
        { from: START, to: "a" },
        { from: START, to: "b" },
        { from: "a", to: "join_feeder_a", when: { key: "flag", truthy: true } },
        // "b" never routes to "join_feeder_b" — the join can never complete.
        { from: "collector", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [
        { id: "j", sources: ["join_feeder_a", "join_feeder_b"], mode: "all", reducer: "append", into: "r", to: "collector" },
      ],
      maxSteps: 10,
    };
    const nodeFns: Record<string, NodeFn> = {
      a: () => ({ flag: true }),
      b: () => ({}),
      join_feeder_a: () => ({}),
      join_feeder_b: () => ({}),
      collector: () => ({}),
    };

    await expect(runLoop({ graph, nodeFns })).rejects.toThrow(UnreachableJoinError);
  });

  it("one activation routes successfully while a second matches none of its guards: the run fails, naming the second node (frontier is non-empty)", async () => {
    const graph: EngineGraph = {
      plainEdges: [
        { from: "good", to: "target", when: { key: "good_flag", truthy: true } },
        { from: "bad", to: "target", when: { key: "bad_flag", truthy: true } },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
    };
    const nodeFns: Record<string, NodeFn> = { good: () => ({}), bad: () => ({}), target: () => ({}) };

    // "good" and "bad" are simulated as already-completed activations from a
    // prior super-step, both reading the same shared state: "good_flag" is
    // set (its guard is satisfied), "bad_flag" is absent (its guard is not) —
    // so the aggregated frontier is non-empty (via "good"), and only "bad"
    // should be named in the failure.
    const result = await runLoop({
      graph,
      nodeFns,
      initialFrontier: [
        { nodeId: "good", instanceId: "good" },
        { nodeId: "bad", instanceId: "bad" },
      ],
      initialState: { good_flag: true },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(UnmatchedRouterError);
    expect((result.error as UnmatchedRouterError).nodeId).toBe("bad");
  });

  it("a node that is both a join source and has guarded (unsatisfied) plain out-edges contributes a barrier arrival — no spurious failure", async () => {
    const graph: EngineGraph = {
      plainEdges: [
        { from: START, to: "r" },
        { from: "r", to: "side_effect_only", when: { key: "never", truthy: true } },
        { from: "collector", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [{ id: "j", sources: ["r"], mode: "all", reducer: "append", into: "results", to: "collector" }],
      maxSteps: 10,
    };
    const nodeFns: Record<string, NodeFn> = {
      r: () => ({ results: "r-output" }),
      side_effect_only: () => ({}),
      collector: () => ({}),
    };

    const result = await runLoop({ graph, nodeFns });
    expect(result.status).toBe("completed");
  });

  it("a fan-out edge over an empty list contributes nothing and does not trigger the unmatched-router failure", async () => {
    const graph: EngineGraph = {
      plainEdges: [{ from: START, to: "dispatch" }],
      fanOutEdges: [{ from: "dispatch", for_each: "items", as: "item", to: "reader" }],
      joinBarriers: [],
      maxSteps: 10,
    };
    const nodeFns: Record<string, NodeFn> = { dispatch: () => ({ items: [] }), reader: () => ({}) };

    const result = await runLoop({ graph, nodeFns });
    // An empty fan-out list plus no other out-edges from "dispatch" is a
    // legitimate dead end (R3 does not apply — "dispatch" has no plain
    // out-edges at all, so it is never "entirely guarded").
    expect(result.status).toBe("dead_end");
  });

  it("a diamond (A→C, B→C, both satisfied) dedups C to one activation via pushUnique and still succeeds", async () => {
    const graph: EngineGraph = {
      plainEdges: [
        { from: "a", to: "c", when: { key: "ok", truthy: true } },
        { from: "b", to: "c", when: { key: "ok", truthy: true } },
        { from: "c", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
    };
    let cRuns = 0;
    const nodeFns: Record<string, NodeFn> = {
      a: () => ({}),
      b: () => ({}),
      c: () => {
        cRuns += 1;
        return {};
      },
    };

    const result = await runLoop({
      graph,
      nodeFns,
      initialFrontier: [
        { nodeId: "a", instanceId: "a" },
        { nodeId: "b", instanceId: "b" },
      ],
      initialState: { ok: true },
    });

    expect(result.status).toBe("completed");
    expect(cRuns).toBe(1);
  });

  it("Covers R24: each routing decision is traced with the rule and the values read", async () => {
    const db = openDb({ baseDir });
    const runId = "run-routing-trace";
    createRun(db, runId, process.pid);
    const graph: EngineGraph = {
      plainEdges: [
        { from: START, to: "router" },
        { from: "router", to: "branch_a", when: { key: "choice", equals: "a" } },
        { from: "router", to: "branch_b", when: { key: "choice", equals: "b" } },
        { from: "branch_a", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
    };
    const nodeFns: Record<string, NodeFn> = { router: () => ({ choice: "a" }), branch_a: () => ({}) };

    const result = await runLoop({ graph, nodeFns, persistence: { db, runId } });
    expect(result.status).toBe("completed");

    const events = listEvents(db, runId);
    const routingEvents = events
      .map((e) => e.payload as { type?: string; to?: string; rule?: unknown; reads?: unknown; result?: boolean })
      .filter((p) => p?.type === "routing_decision");

    expect(routingEvents).toHaveLength(2); // one per guarded edge out of "router"
    const toA = routingEvents.find((e) => e.to === "branch_a")!;
    expect(toA.rule).toEqual({ key: "choice", equals: "a" });
    expect(toA.reads).toEqual({ choice: "a" });
    expect(toA.result).toBe(true);
    const toB = routingEvents.find((e) => e.to === "branch_b")!;
    expect(toB.result).toBe(false);

    db.close();
  });
});

describe("engine/loop: attempt bound and not_converged (U4, R5/R6/R7, KTD-5)", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "graph-bro-loop-attempts-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function reviewLoopGraph(bound: number, maxSteps = 50): EngineGraph {
    return {
      plainEdges: [
        { from: START, to: "review" },
        { from: "review", to: "pass", when: { key: "ok", truthy: true } },
        { from: "review", to: "fix", when: { key: "ok", falsy: true } },
        { from: "fix", to: "review" },
        { from: "pass", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps,
      attemptBounds: { review: bound },
    };
  }

  it("Covers AE4: a loop whose review never passes halts at the bound as not_converged, distinct from failed", async () => {
    const nodeFns: Record<string, NodeFn> = { review: () => ({ ok: false }), fix: () => ({}) };

    const result = await runLoop({ graph: reviewLoopGraph(3), nodeFns });

    expect(result.status).toBe("not_converged");
    expect(result.status).not.toBe("failed");
    expect(result.attempts.review).toBe(3);
  });

  it("a loop that converges before its bound reports completed, with the attempt count reflecting attempts actually taken", async () => {
    let calls = 0;
    const nodeFns: Record<string, NodeFn> = {
      review: () => {
        calls += 1;
        return { ok: calls >= 2 };
      },
      fix: () => ({}),
      pass: () => ({}),
    };

    const result = await runLoop({ graph: reviewLoopGraph(5), nodeFns });

    expect(result.status).toBe("completed");
    expect(result.attempts.review).toBe(2);
  });

  it("the step budget and the attempt bound are independent: exhausting max_steps inside a bounded loop reports the step-budget outcome, not the bound", async () => {
    const nodeFns: Record<string, NodeFn> = { review: () => ({ ok: false }), fix: () => ({}) };

    const result = await runLoop({ graph: reviewLoopGraph(1000, 3), nodeFns });

    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(MaxStepsExceededError);
  });

  it("two back-edges into one bounded node share the one bound", async () => {
    const graph: EngineGraph = {
      plainEdges: [
        { from: START, to: "review" },
        { from: "review", to: "fix_a", when: { key: "path", equals: "a" } },
        { from: "review", to: "fix_b", when: { key: "path", equals: "b" } },
        { from: "fix_a", to: "review" },
        { from: "fix_b", to: "review" },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 50,
      attemptBounds: { review: 2 },
    };
    let calls = 0;
    const nodeFns: Record<string, NodeFn> = {
      review: () => {
        calls += 1;
        return { path: calls % 2 === 0 ? "b" : "a" };
      },
      fix_a: () => ({}),
      fix_b: () => ({}),
    };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("not_converged");
    expect(result.attempts.review).toBe(2);
  });

  it("the attempt count is present in the checkpoint after each attempt (KTD-5)", async () => {
    const db = openDb({ baseDir });
    const runId = "run-attempt-checkpoint";
    createRun(db, runId, process.pid);
    const nodeFns: Record<string, NodeFn> = { review: () => ({ ok: false }), fix: () => ({}) };

    await runLoop({ graph: reviewLoopGraph(5), nodeFns, persistence: { db, runId } });

    const latest = readLatestCheckpoint(db, runId);
    expect(latest?.attempts?.review).toBe(5);
    db.close();
  });

  it("a bounded node reached exactly once, with no loop, does not trip the bound", async () => {
    const nodeFns: Record<string, NodeFn> = { review: () => ({ ok: true }), pass: () => ({}) };

    const result = await runLoop({ graph: reviewLoopGraph(1), nodeFns });

    expect(result.status).toBe("completed");
    expect(result.attempts.review).toBe(1);
  });

  it("an unbounded node in a loop is governed only by max_steps — slice-1 behavior unchanged", async () => {
    const graph: EngineGraph = {
      plainEdges: [
        { from: START, to: "review" },
        { from: "review", to: "fix", when: { key: "ok", falsy: true } },
        { from: "fix", to: "review" },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 4,
      // no attemptBounds declared at all
    };
    const nodeFns: Record<string, NodeFn> = { review: () => ({ ok: false }), fix: () => ({}) };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(MaxStepsExceededError);
  });
});

describe("engine/loop: single-track frontier assertion (U11, R19, KTD-10)", () => {
  // Two independent chains off one unconditional fork — the compile-time
  // guard only groups out-edges by source and only rejects an unresolved
  // group with a write-capable target; this diamond has no such group (each
  // fork branch has exactly one out-edge), so it is exactly the shape the
  // compiler admits and only the frontier assertion can catch.
  function divergingChainsGraph(capability: Record<string, "read_only" | "write">): EngineGraph {
    return {
      plainEdges: [
        { from: START, to: "setup" },
        { from: "setup", to: "branch_a" },
        { from: "setup", to: "branch_b" },
        { from: "branch_a", to: "node_a" },
        { from: "branch_b", to: "node_b" },
        { from: "node_a", to: END },
        { from: "node_b", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
      agentNodeCapability: capability,
    };
  }

  function chainNodeFns(ran: string[]): Record<string, NodeFn> {
    return {
      setup: () => ({}),
      branch_a: () => ({}),
      branch_b: () => ({}),
      node_a: () => {
        ran.push("node_a");
        return {};
      },
      node_b: () => {
        ran.push("node_b");
        return {};
      },
    };
  }

  it("Covers R19: a write-capable node and a read-only node reaching the same frontier fails, naming both nodes — not the read-only node's own cleanliness check", async () => {
    const ran: string[] = [];
    const graph = divergingChainsGraph({ node_a: "write", node_b: "read_only" });

    const result = await runLoop({ graph, nodeFns: chainNodeFns(ran) });

    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(ConcurrentWriteViolationError);
    const error = result.error as ConcurrentWriteViolationError;
    expect(error.nodeIds).toContain("node_a");
    expect(error.nodeIds).toContain("node_b");
    // The violation is caught before dispatch — neither node actually ran.
    expect(ran).toEqual([]);
  });

  it("two write-capable nodes reaching the same frontier also fails — the original fan-out-write hazard restated as a diamond", async () => {
    const ran: string[] = [];
    const graph = divergingChainsGraph({ node_a: "write", node_b: "write" });

    const result = await runLoop({ graph, nodeFns: chainNodeFns(ran) });

    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(ConcurrentWriteViolationError);
  });

  it("two read-only nodes reaching the same frontier are unaffected — the slice-1 fan-out shape still runs", async () => {
    const ran: string[] = [];
    const graph = divergingChainsGraph({ node_a: "read_only", node_b: "read_only" });

    const result = await runLoop({ graph, nodeFns: chainNodeFns(ran) });

    expect(result.status).toBe("completed");
    expect(ran.sort()).toEqual(["node_a", "node_b"]);
  });

  it("a write-capable node running alone in its frontier is unaffected", async () => {
    const graph: EngineGraph = {
      plainEdges: [
        { from: START, to: "writer" },
        { from: "writer", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
      agentNodeCapability: { writer: "write" },
    };
    const nodeFns: Record<string, NodeFn> = { writer: () => ({}) };

    const result = await runLoop({ graph, nodeFns });

    expect(result.status).toBe("completed");
  });

  it("no agentNodeCapability declared at all leaves the assertion a no-op — a caller that hasn't wired it gets slice-1 behavior", async () => {
    const ran: string[] = [];
    const graph: EngineGraph = {
      plainEdges: [
        { from: START, to: "setup" },
        { from: "setup", to: "branch_a" },
        { from: "setup", to: "branch_b" },
        { from: "branch_a", to: "node_a" },
        { from: "branch_b", to: "node_b" },
        { from: "node_a", to: END },
        { from: "node_b", to: END },
      ],
      fanOutEdges: [],
      joinBarriers: [],
      maxSteps: 10,
      // no agentNodeCapability declared at all
    };

    const result = await runLoop({ graph, nodeFns: chainNodeFns(ran) });

    expect(result.status).toBe("completed");
    expect(ran.sort()).toEqual(["node_a", "node_b"]);
  });
});
