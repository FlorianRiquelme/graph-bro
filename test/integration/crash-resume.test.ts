import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile, type CompiledTopology } from "../../src/topology/compile.js";
import { buildFanOutBranches } from "../../src/engine/fanout.js";
import {
  runLoop,
  makeAgentNodeFn,
  type EngineGraph,
  type InitialBarrierState,
  type NodeFn,
} from "../../src/engine/loop.js";
import type { EngineState } from "../../src/engine/state.js";
import { openDb } from "../../src/store/db.js";
import { writeCheckpoint } from "../../src/store/checkpoints.js";
import { commitPendingWrite, createRun, resume } from "../../src/store/pending-writes.js";
import { StubExecutor } from "../fixtures/stub-executor.js";

/** Mirrors `runtime/run.ts`'s `buildNodeFns`, `StubExecutor` standing in for `ClaudeCodeExecutor`. */
function buildNodeFns(compiled: CompiledTopology, executor: StubExecutor): Record<string, NodeFn> {
  const nodeFns: Record<string, NodeFn> = {};
  for (const node of compiled.nodes) {
    nodeFns[node.id] =
      node.kind === "agent"
        ? makeAgentNodeFn(executor, {
            nodeId: node.id,
            model: node.model,
            readOnly: node.read_only,
            cwd: ".",
            timeout: 1_000,
            outputKey: node.output_key,
            prompt: node.prompt,
          })
        : (): Record<string, unknown> => ({ ...node.update });
  }
  return nodeFns;
}

/** Mirrors `runtime/run.ts`'s `reconstructBarrierState` (KTD-12's resume seam), the single-dynamic-source shape. */
function reconstructBarrierState(
  compiled: CompiledTopology,
  state: EngineState,
  completedInstanceIds: Set<string>,
): InitialBarrierState[] {
  const result: InitialBarrierState[] = [];
  for (const barrier of compiled.joinBarriers) {
    if (barrier.sources.length !== 1) continue;
    const source = barrier.sources[0];
    const fanOutEdge = compiled.fanOutEdges.find((edge) => edge.to === source);
    if (!fanOutEdge) continue;
    const branches = buildFanOutBranches(fanOutEdge, state);
    const expectedInstanceIds = branches.map((branch) => branch.instanceId);
    const arrivedInstanceIds = expectedInstanceIds.filter((id) => completedInstanceIds.has(id));
    result.push({ source, expectedInstanceIds, arrivedInstanceIds });
  }
  return result;
}

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
      writeCheckpoint(db, runId, {
        state: { batch: { items } },
        frontier: items.map((item, i) => ({
          nodeId: "reader",
          instanceId: `reader:${i}`,
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
          itemKey: String(i),
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
