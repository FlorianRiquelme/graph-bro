import { describe, expect, it } from "vitest";
import {
  compile,
  deriveInstanceId,
  deriveItemKey,
} from "../../src/topology/compile.js";
import { END, START } from "../../src/topology/schema.js";

function validTopology() {
  return {
    nodes: [
      {
        id: "dispatch",
        kind: "set" as const,
        update: { "batch.items": ["a", "b", "c"] },
      },
      {
        id: "reader",
        kind: "agent" as const,
        read_only: true as const,
        model: "claude-haiku",
        prompt: "read ${item}",
        output_key: "finding",
      },
      {
        id: "collector",
        kind: "set" as const,
        update: { collected: true },
      },
    ],
    edges: [
      { from: START, to: "dispatch" },
      { from: "dispatch", for_each: "batch.items", as: "item", to: "reader" },
      {
        from: ["reader"],
        mode: "all" as const,
        reducer: "dedup" as const,
        into: "results",
        to: "collector",
      },
      { from: "collector", to: END },
    ],
    max_steps: 25,
  };
}

describe("compile: happy path", () => {
  it("compiles a valid fan-out -> read -> join topology to a channel wiring", () => {
    const result = compile(validTopology());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.nodes).toHaveLength(3);
    expect(result.compiled.fanOutEdges).toHaveLength(1);
    expect(result.compiled.joinBarriers).toHaveLength(1);
    expect(result.compiled.joinBarriers[0]).toEqual({
      id: "reader=>collector",
      sources: ["reader"],
      mode: "all",
      reducer: "dedup",
      into: "results",
      to: "collector",
    });
  });

  it("threads a topology-level max_concurrency override (ADR-0011) into CompiledTopology; omitted stays undefined", () => {
    const withOverride = compile({ ...validTopology(), max_concurrency: 2 });
    expect(withOverride.ok).toBe(true);
    if (withOverride.ok) expect(withOverride.compiled.maxConcurrency).toBe(2);

    const withoutOverride = compile(validTopology());
    expect(withoutOverride.ok).toBe(true);
    if (withoutOverride.ok) expect(withoutOverride.compiled.maxConcurrency).toBeUndefined();
  });

  it("golden-file snapshot of compiled output (nodes, edges, join barriers, reducer assignments)", () => {
    const result = compile(validTopology());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled).toMatchSnapshot();
  });
});

describe("compile: malformed topology rejection (Covers R2)", () => {
  it("rejects a topology missing max_steps, producing no run id", () => {
    const topology = validTopology() as Record<string, unknown>;
    delete topology.max_steps;
    const result = compile(topology);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect("compiled" in result).toBe(false);
  });

  it("rejects an unknown node kind, producing no run id", () => {
    const topology = validTopology();
    (topology.nodes[1] as unknown as { kind: string }).kind = "human";
    const result = compile(topology);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an unknown reducer name, producing no run id", () => {
    const topology = validTopology();
    (topology.edges[2] as { reducer: string }).reducer = "concat";
    const result = compile(topology);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects START as a join source, producing no run id", () => {
    const topology = validTopology();
    (topology.edges[2] as { from: string[] }).from = [START];
    const result = compile(topology);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((error) => error.message.includes("START")),
    ).toBe(true);
  });
});

describe("compile: read_only enforcement (KTD-8)", () => {
  it("rejects an agent node with read_only:false, producing no run id", () => {
    const topology = validTopology();
    (topology.nodes[1] as { read_only: boolean }).read_only = false;
    const result = compile(topology);
    expect(result.ok).toBe(false);
  });

  it("rejects an agent node with read_only omitted, producing no run id", () => {
    const topology = validTopology();
    const readerNode = topology.nodes[1] as Record<string, unknown>;
    delete readerNode.read_only;
    const result = compile(topology);
    expect(result.ok).toBe(false);
  });
});

describe("compile: per-instance identity (KTD-12)", () => {
  it("a 3-item for_each yields three distinct item keys and instance ids", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const itemKeys = items.map((item, index) => deriveItemKey(item, index));
    expect(new Set(itemKeys).size).toBe(3);

    const instanceIds = itemKeys.map((key) => deriveInstanceId("reader", key));
    expect(new Set(instanceIds).size).toBe(3);
    expect(instanceIds).toEqual(["reader:a", "reader:b", "reader:c"]);
  });

  it("falls back to index when items carry no id field", () => {
    const items = ["a", "b", "c"];
    const itemKeys = items.map((item, index) => deriveItemKey(item, index));
    expect(itemKeys).toEqual(["0", "1", "2"]);
    expect(new Set(itemKeys).size).toBe(3);
  });
});

describe("compile: join-desync lint (§14.9)", () => {
  it("emits a warning when a join source sits behind a non-exhaustive router", () => {
    const topology = {
      nodes: [
        { id: "router", kind: "set" as const, update: {} },
        { id: "branch_a", kind: "set" as const, update: {} },
        { id: "branch_b", kind: "set" as const, update: {} },
        { id: "collector", kind: "set" as const, update: {} },
      ],
      edges: [
        {
          from: "router",
          to: "branch_a",
          when: { key: "choice", equals: "a" },
        },
        {
          from: "router",
          to: "branch_b",
          when: { key: "choice", equals: "b" },
        },
        {
          from: ["branch_a", "branch_b"],
          mode: "all" as const,
          reducer: "merge" as const,
          into: "results",
          to: "collector",
        },
      ],
      max_steps: 10,
    };
    const result = compile(topology);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatchObject({
      code: "join-desync",
      join: "collector",
    });
  });

  it("does not hard-error an always-both-fire router into a static join (§14.1 non-counterexample)", () => {
    const topology = {
      nodes: [
        { id: "router", kind: "set" as const, update: {} },
        { id: "branch_a", kind: "set" as const, update: {} },
        { id: "branch_b", kind: "set" as const, update: {} },
        { id: "collector", kind: "set" as const, update: {} },
      ],
      edges: [
        { from: "router", to: "branch_a" },
        { from: "router", to: "branch_b" },
        {
          from: ["branch_a", "branch_b"],
          mode: "all" as const,
          reducer: "merge" as const,
          into: "results",
          to: "collector",
        },
      ],
      max_steps: 10,
    };
    const result = compile(topology);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(0);
  });
});
