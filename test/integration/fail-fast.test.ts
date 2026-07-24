import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile } from "../../src/topology/compile.js";
import { runLoop, type EngineGraph } from "../../src/engine/loop.js";
import { openDb } from "../../src/store/db.js";
import { createRun, getRun, updateRunStatus } from "../../src/store/pending-writes.js";
import { listEvents } from "../../src/store/trace.js";
import { StubExecutor } from "../fixtures/stub-executor.js";
import { buildNodeFns } from "../../src/runtime/run.js";

function fanOutJoinTopology(itemCount: number) {
  return {
    nodes: [
      { id: "dispatch", kind: "set", update: { batch: { items: Array.from({ length: itemCount }, (_, i) => `item-${i}`) } } },
      { id: "reader", kind: "agent", read_only: true, model: "stub-model", prompt: "read the item", output_key: "results" },
      { id: "collector", kind: "set", update: { collected: true } },
    ],
    edges: [
      { from: "START", to: "dispatch" },
      { from: "dispatch", for_each: "batch.items", as: "item", to: "reader" },
      { from: ["reader"], mode: "all", reducer: "append", into: "results", to: "collector" },
      { from: "collector", to: "END" },
    ],
    max_steps: 10,
  };
}

describe("integration/fail-fast: compiled-from-topology-JSON one-branch-fails halt (U8)", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "graph-bro-fail-fast-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it(
    "Covers AE3: one stub branch throws -> fail-fast halts, siblings' outputs are durable, and the failure is " +
      "visible in the real `runs.status` row AND the `events` trace (not just the LoopResult return value)",
    async () => {
      const compileResult = compile(fanOutJoinTopology(5));
      expect(compileResult.ok).toBe(true);
      if (!compileResult.ok) return;
      const compiled = compileResult.compiled;

      const db = openDb({ baseDir });
      const runId = "run-fail-fast-integration";
      createRun(db, runId, process.pid);

      // The real runtime's `node.prompt` is a static string per node (not a
      // per-branch closure — schema.ts's `AgentNodeSchema.prompt: z.string()`),
      // so the failing branch is picked by call order rather than by content.
      let callCount = 0;
      const stub = new StubExecutor(() => {
        callCount += 1;
        if (callCount === 3) return { text: "boom", isError: true };
        return { text: "read-ok", isError: false };
      });
      const nodeFns = buildNodeFns(compiled, stub);

      const graph: EngineGraph = {
        plainEdges: compiled.plainEdges,
        fanOutEdges: compiled.fanOutEdges,
        joinBarriers: compiled.joinBarriers,
        maxSteps: compiled.maxSteps,
        maxConcurrency: compiled.maxConcurrency,
      };

      const result = await runLoop({ graph, nodeFns, persistence: { db, runId } });
      // Mirrors what `runtime/run.ts`'s `main()` does after `runLoop` returns,
      // so the DB row genuinely reflects a real run's outcome, not just the
      // in-memory `LoopResult`.
      updateRunStatus(db, runId, result.status);

      expect(result.status).toBe("failed");
      expect(result.error?.message).toMatch(/boom/);
      // No silent loss: the 4 succeeding siblings' outputs are present.
      expect(result.state.results).toHaveLength(4);

      const runRow = getRun(db, runId);
      expect(runRow?.status).toBe("failed"); // the actual `runs` table row, not just the return value

      const events = listEvents(db, runId);
      const failureEvent = events.find(
        (e) => e.node === "reader" && JSON.stringify(e.payload).includes("boom"),
      );
      expect(failureEvent).toBeDefined(); // the actual `events` table row, not just the return value

      db.close();
    },
  );

  it("Covers AE4: a compiled topology that would loop past max_steps halts with a visible failure through the real store, no hang", async () => {
    const loopingTopology = {
      nodes: [{ id: "A", kind: "set", update: {} }],
      edges: [
        { from: "START", to: "A" },
        { from: "A", to: "A" },
      ],
      max_steps: 5,
    };
    const compileResult = compile(loopingTopology);
    expect(compileResult.ok).toBe(true);
    if (!compileResult.ok) return;
    const compiled = compileResult.compiled;

    const db = openDb({ baseDir });
    const runId = "run-max-steps-integration";
    createRun(db, runId, process.pid);

    const graph: EngineGraph = {
      plainEdges: compiled.plainEdges,
      fanOutEdges: compiled.fanOutEdges,
      joinBarriers: compiled.joinBarriers,
      maxSteps: compiled.maxSteps,
    };
    const result = await runLoop({ graph, nodeFns: buildNodeFns(compiled, new StubExecutor()), persistence: { db, runId } });
    updateRunStatus(db, runId, result.status);

    expect(result.status).toBe("failed");
    expect(getRun(db, runId)?.status).toBe("failed");

    db.close();
  });
});
