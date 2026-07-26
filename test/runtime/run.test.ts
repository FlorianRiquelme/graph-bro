import { describe, expect, it } from "vitest";
import { compile } from "../../src/topology/compile.js";
import { readNodeTraceMeta } from "../../src/engine/loop.js";
import { buildNodeFns, mapStatusToExitCode } from "../../src/runtime/run.js";
import { StubExecutor } from "../fixtures/stub-executor.js";

function singleAgentTopology(prompt: string) {
  return {
    nodes: [{ id: "reader", kind: "agent", read_only: true, model: "stub-model", prompt, output_key: "results" }],
    edges: [
      { from: "START", to: "reader" },
      { from: "reader", to: "END" },
    ],
    max_steps: 10,
  };
}

function compileSingleAgent(prompt: string) {
  const compileResult = compile(singleAgentTopology(prompt));
  expect(compileResult.ok).toBe(true);
  if (!compileResult.ok) throw new Error("compile failed");
  return compileResult.compiled;
}

describe("runtime/run: buildNodeFns wires prompt templating into the agent node (U2)", () => {
  it("Covers AE1 (wiring): resolves the fan-out branch's as-item into the prompt handed to the executor", async () => {
    const compiled = compileSingleAgent("read {{ item }}");
    const stub = new StubExecutor(() => ({ text: "ok", isError: false }));
    const nodeFns = buildNodeFns(compiled, stub);

    await nodeFns.reader({ item: "one" });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].prompt).toBe("read one");
  });

  it("Covers AE2: a non-fan-out agent node resolves an upstream output key into its prompt", async () => {
    const compiled = compileSingleAgent("summarize {{ upstream.output }}");
    const stub = new StubExecutor(() => ({ text: "ok", isError: false }));
    const nodeFns = buildNodeFns(compiled, stub);

    await nodeFns.reader({ upstream: { output: "the report" } });

    expect(stub.calls[0].prompt).toBe("summarize the report");
  });

  it("Covers AE3 / R5: an unresolvable token throws naming node + token and the executor is never called", async () => {
    const compiled = compileSingleAgent("read {{ missing }}");
    const stub = new StubExecutor(() => ({ text: "ok", isError: false }));
    const nodeFns = buildNodeFns(compiled, stub);

    await expect(nodeFns.reader({})).rejects.toThrow(/reader.*missing/s);
    expect(stub.calls).toHaveLength(0);
  });

  it("Covers AE5: an untemplated prompt is passed to the executor byte-identical", async () => {
    const compiled = compileSingleAgent("read the batch and report back");
    const stub = new StubExecutor(() => ({ text: "ok", isError: false }));
    const nodeFns = buildNodeFns(compiled, stub);

    await nodeFns.reader({ item: "one" });

    expect(stub.calls[0].prompt).toBe("read the batch and report back");
  });

  it("Covers R6: the returned EngineUpdate carries the resolved prompt on NODE_TRACE_META", async () => {
    const compiled = compileSingleAgent("read {{ item }}");
    const stub = new StubExecutor(() => ({ text: "ok", isError: false }));
    const nodeFns = buildNodeFns(compiled, stub);

    const update = await nodeFns.reader({ item: "one" });

    expect(readNodeTraceMeta(update)?.resolvedPrompt).toBe("read one");
  });
});

describe("runtime/run: mapStatusToExitCode (U4, R7)", () => {
  it("Covers R7: not_converged is distinct from both completed and a generic failure", () => {
    expect(mapStatusToExitCode("completed")).toBe(0);
    expect(mapStatusToExitCode("not_converged")).toBe(2);
    expect(mapStatusToExitCode("failed")).toBe(1);
    expect(mapStatusToExitCode("dead_end")).toBe(1);
  });
});
