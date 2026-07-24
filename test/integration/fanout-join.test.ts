import { describe, expect, it } from "vitest";
import { compile } from "../../src/topology/compile.js";
import { runLoop, type EngineGraph } from "../../src/engine/loop.js";
import { StubExecutor } from "../fixtures/stub-executor.js";
import { buildNodeFns } from "../../src/runtime/run.js";

/** The mining-shaped fan-out -> join topology (KTD-12), same shape `cli.test.ts` uses. */
function fanOutJoinTopology(itemCount: number, prompt: string) {
  return {
    nodes: [
      { id: "dispatch", kind: "set", update: { batch: { items: Array.from({ length: itemCount }, (_, i) => `item-${i}`) } } },
      { id: "reader", kind: "agent", read_only: true, model: "stub-model", prompt, output_key: "results" },
      { id: "collector", kind: "set", update: { collected: true } },
    ],
    edges: [
      { from: "START", to: "dispatch" },
      { from: "dispatch", for_each: "batch.items", as: "item", to: "reader" },
      { from: ["reader"], mode: "all", reducer: "dedup", into: "results", to: "collector" },
      { from: "collector", to: "END" },
    ],
    max_steps: 10,
  };
}

function runTopology(topologyJson: unknown, executor: StubExecutor) {
  const compileResult = compile(topologyJson);
  expect(compileResult.ok).toBe(true);
  if (!compileResult.ok) throw new Error("compile failed");
  const compiled = compileResult.compiled;
  const nodeFns = buildNodeFns(compiled, executor);
  const graph: EngineGraph = {
    plainEdges: compiled.plainEdges,
    fanOutEdges: compiled.fanOutEdges,
    joinBarriers: compiled.joinBarriers,
    maxSteps: compiled.maxSteps,
    maxConcurrency: compiled.maxConcurrency,
  };
  return { runLoop: () => runLoop({ graph, nodeFns }), nodeFns };
}

describe("integration/fanout-join: compiled-from-topology-JSON fan-out + join (U8, R8)", () => {
  it(
    "Covers AE1: a fan-out of 17 items, each with a prompt templated over its as-item, produces 17 " +
      "distinct resolved prompts through a prompt-echoing stub, and the dedup join collapses to 17 distinct " +
      "outputs (not 1) — proving distinctness is airtight, not agent nondeterminism",
    async () => {
      const itemCount = 17;
      const stub = new StubExecutor((prompt) => ({ text: prompt, isError: false }));
      let collectorRuns = 0;
      const { runLoop: run, nodeFns } = runTopology(fanOutJoinTopology(itemCount, "Read item {{ item }} and report."), stub);
      nodeFns.collector = () => {
        collectorRuns += 1;
        return { collected: true };
      };

      const result = await run();

      expect(result.status).toBe("completed");
      expect(stub.calls).toHaveLength(itemCount);
      const prompts = stub.calls.map((c) => c.prompt);
      expect(new Set(prompts).size).toBe(itemCount); // every branch's resolved prompt is distinct
      expect(result.state.results).toHaveLength(itemCount); // dedup preserved all N distinct values (KTD-12)
      for (let i = 0; i < itemCount; i++) {
        expect(result.state.results).toContain(`Read item item-${i} and report.`);
      }
      expect(collectorRuns).toBe(1); // join fired exactly once, only after all 17 arrived
    },
  );

  it("Covers AE2: a non-fan-out agent node's prompt resolves an upstream node's output key", async () => {
    const topology = {
      nodes: [
        { id: "producer", kind: "set", update: { upstream: { output: "the report" } } },
        { id: "reader", kind: "agent", read_only: true, model: "stub-model", prompt: "summarize {{ upstream.output }}", output_key: "summary" },
      ],
      edges: [
        { from: "START", to: "producer" },
        { from: "producer", to: "reader" },
        { from: "reader", to: "END" },
      ],
      max_steps: 10,
    };
    const stub = new StubExecutor((prompt) => ({ text: prompt, isError: false }));
    const { runLoop: run } = runTopology(topology, stub);

    const result = await run();

    expect(result.status).toBe("completed");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].prompt).toBe("summarize the report");
  });

  it("Covers AE3: one branch's template references a missing path -> fail-fast halts the run (ADR-0006) and the executor records no call for that branch", async () => {
    const topology = {
      nodes: [
        {
          id: "dispatch",
          kind: "set",
          update: { batch: { items: [{ id: "a", note: "x" }, { id: "b" }, { id: "c", note: "z" }] } },
        },
        { id: "reader", kind: "agent", read_only: true, model: "stub-model", prompt: "Read {{ item.id }}: {{ item.note }}", output_key: "results" },
        { id: "collector", kind: "set", update: { collected: true } },
      ],
      edges: [
        { from: "START", to: "dispatch" },
        { from: "dispatch", for_each: "batch.items", as: "item", to: "reader" },
        { from: ["reader"], mode: "all", reducer: "dedup", into: "results", to: "collector" },
        { from: "collector", to: "END" },
      ],
      max_steps: 10,
    };
    const stub = new StubExecutor((prompt) => ({ text: prompt, isError: false }));
    const { runLoop: run } = runTopology(topology, stub);

    const result = await run();

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("reader");
    expect(result.error?.message).toContain("item.note");
    // item "b" lacks `note`, so its resolution throws before `executor.run` — the
    // echoing stub never records a call whose prompt would have named it.
    expect(stub.calls.some((c) => c.prompt.startsWith("Read b:"))).toBe(false);
    expect(stub.calls).toHaveLength(2); // only the two well-formed items ("a", "c") reached the executor
  });

  it("Covers AE5: an untemplated reader prompt runs byte-identical for every branch (today's behavior, unchanged)", async () => {
    const itemCount = 5;
    const stub = new StubExecutor((prompt) => ({ text: prompt, isError: false }));
    const { runLoop: run } = runTopology(fanOutJoinTopology(itemCount, "read the batch and report back"), stub);

    const result = await run();

    expect(result.status).toBe("completed");
    expect(stub.calls).toHaveLength(itemCount);
    expect(stub.calls.every((c) => c.prompt === "read the batch and report back")).toBe(true);
    expect(result.state.results).toEqual(["read the batch and report back"]); // dedup collapses the identical outputs to 1
  });
});
