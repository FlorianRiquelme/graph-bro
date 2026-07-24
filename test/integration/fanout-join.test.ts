import { describe, expect, it } from "vitest";
import { compile } from "../../src/topology/compile.js";
import { runLoop, type EngineGraph } from "../../src/engine/loop.js";
import { StubExecutor } from "../fixtures/stub-executor.js";
import { buildNodeFns } from "../../src/runtime/run.js";

/** The mining-shaped fan-out -> join topology (KTD-12), same shape `cli.test.ts` uses. */
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
      // `append` (not `dedup`): the real runtime's `node.prompt` is a static
      // string (schema.ts's `AgentNodeSchema.prompt: z.string()`), so every
      // branch's stub response is identical — `append` lets us still prove
      // "all 17 arrived" by length rather than by distinct values.
      { from: ["reader"], mode: "all", reducer: "append", into: "results", to: "collector" },
      { from: "collector", to: "END" },
    ],
    max_steps: 10,
  };
}

describe("integration/fanout-join: compiled-from-topology-JSON fan-out + join (U8)", () => {
  it(
    "Covers AE1: a fan-out of 17 items, compiled from topology JSON and wired through buildNodeFns-equivalent " +
      "stub-executor plumbing, runs 17 branch instances through the real bounded pool; the join fires only after all 17",
    async () => {
      const compileResult = compile(fanOutJoinTopology(17));
      expect(compileResult.ok).toBe(true);
      if (!compileResult.ok) return;
      const compiled = compileResult.compiled;

      const stub = new StubExecutor(() => ({ text: "read-ok", isError: false }));
      let collectorRuns = 0;
      const nodeFns = buildNodeFns(compiled, stub);
      nodeFns.collector = () => {
        collectorRuns += 1;
        return { collected: true };
      };

      const graph: EngineGraph = {
        plainEdges: compiled.plainEdges,
        fanOutEdges: compiled.fanOutEdges,
        joinBarriers: compiled.joinBarriers,
        maxSteps: compiled.maxSteps,
        maxConcurrency: compiled.maxConcurrency,
      };

      const result = await runLoop({ graph, nodeFns });

      expect(result.status).toBe("completed");
      expect(stub.calls).toHaveLength(17); // every branch dispatched through the pool
      expect(result.state.results).toHaveLength(17); // the join's barrier universe was sized 17, not 1 (KTD-12)
      expect(collectorRuns).toBe(1); // join fired exactly once, only after all 17 arrived
    },
  );
});
