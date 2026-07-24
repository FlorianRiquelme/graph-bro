import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile } from "../../src/topology/compile.js";
import { runLoop, type EngineGraph } from "../../src/engine/loop.js";
import { openDb } from "../../src/store/db.js";
import { writeCheckpoint } from "../../src/store/checkpoints.js";
import { commitPendingWrite, createRun, resume } from "../../src/store/pending-writes.js";
import { StubExecutor } from "../fixtures/stub-executor.js";
import { buildNodeFns, reconstructBarrierState } from "../../src/runtime/run.js";

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

describe("integration/crash-resume: compiled-from-topology-JSON crash mid-drain + resume (U8)", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "graph-bro-crash-resume-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it(
    "Covers AE2: kill after 12 of 17 readers, resume through the real store's resume() + a compiled-topology's " +
      "reconstructed barrier state, asserts zero re-execution of the 12 and a completed run",
    async () => {
      const items = Array.from({ length: 17 }, (_, i) => `item-${i}`);
      const compileResult = compile(fanOutJoinTopology(17));
      expect(compileResult.ok).toBe(true);
      if (!compileResult.ok) return;
      const compiled = compileResult.compiled;

      const db = openDb({ baseDir });
      const runId = "run-crash-integration";
      createRun(db, runId, process.pid);

      // Simulate the crash: dispatch already ran (step 0), 12 of the 17
      // fan-out branches committed their pending write before the "crash".
      // items are plain strings (no `id` field), so deriveItemKey derives
      // "idx:${i}" for each — must match here so resume()'s
      // deriveInstanceId(node, itemKey) lines up with the frontier below.
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
      for (let i = 0; i < 12; i += 1) {
        commitPendingWrite(db, {
          runId,
          node: "reader",
          step: 1,
          itemKey: `idx:${i}`,
          triggers: [],
          writes: { results: "read-ok" },
        });
      }

      const reducerForKey = (key: string) =>
        compiled.joinBarriers.find((barrier) => barrier.into === key)?.reducer;
      const resumed = resume(db, runId, { reducerForKey });
      expect(resumed.completedInstanceIds.size).toBe(12);
      expect(resumed.frontier).toHaveLength(5); // only the 5 uncompleted branches remain

      const stub = new StubExecutor(() => ({ text: "read-ok", isError: false }));
      const nodeFns = buildNodeFns(compiled, stub);

      const graph: EngineGraph = {
        // dispatch already ran pre-crash; the resumed run must not re-run it.
        plainEdges: compiled.plainEdges.filter((edge) => edge.from !== "START"),
        fanOutEdges: [],
        joinBarriers: compiled.joinBarriers,
        maxSteps: compiled.maxSteps,
        maxConcurrency: compiled.maxConcurrency,
      };

      const result = await runLoop({
        graph,
        nodeFns,
        initialState: resumed.state,
        initialFrontier: resumed.frontier,
        initialStep: resumed.step,
        initialBarrierState: reconstructBarrierState(compiled, resumed.state, resumed.completedInstanceIds),
        persistence: { db, runId },
      });

      expect(result.status).toBe("completed");
      expect(stub.calls).toHaveLength(5); // only the 5 uncompleted branches re-run; the 12 are not re-executed
      expect(result.state.results).toHaveLength(17); // 12 replayed + 5 freshly executed, no loss / no duplication

      db.close();
    },
  );
});
