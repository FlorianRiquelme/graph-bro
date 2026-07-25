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

describe("compile: read_only (U2)", () => {
  it("Covers U2: a write-capable agent node (read_only:false) compiles when it isn't reached via a fan-out edge", () => {
    const topology = {
      nodes: [{ id: "writer", kind: "agent" as const, read_only: false, model: "claude-cheap", prompt: "edit", output_key: "diff" }],
      edges: [
        { from: START, to: "writer" },
        { from: "writer", to: END },
      ],
      max_steps: 10,
    };
    const result = compile(topology);
    expect(result.ok).toBe(true);
  });

  it("rejects an agent node with read_only omitted, producing no run id", () => {
    const topology = validTopology();
    const readerNode = topology.nodes[1] as Record<string, unknown>;
    delete readerNode.read_only;
    const result = compile(topology);
    expect(result.ok).toBe(false);
  });
});

describe("compile: U2 authoring surface (output_schema, max_attempts, network_domains, base_ref)", () => {
  function writerTopology(overrides: Record<string, unknown> = {}) {
    return {
      nodes: [
        {
          id: "writer",
          kind: "agent" as const,
          read_only: false,
          model: "claude-cheap",
          prompt: "edit",
          output_key: "diff",
          ...overrides,
        },
      ],
      edges: [
        { from: START, to: "writer" },
        { from: "writer", to: END },
      ],
      max_steps: 10,
    };
  }

  it("Covers AE2: a well-formed output_schema compiles", () => {
    const result = compile(writerTopology({ output_schema: { type: "object", properties: { ok: { type: "boolean" } } } }));
    expect(result.ok).toBe(true);
  });

  it("rejects an output_schema that is not a well-formed JSON Schema, naming the node", () => {
    const result = compile(writerTopology({ output_schema: { type: "not-a-real-type" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.message.includes("writer"))).toBe(true);
  });

  it("accepts a positive max_attempts", () => {
    const result = compile(writerTopology({ max_attempts: 3 }));
    expect(result.ok).toBe(true);
  });

  it.each([0, -1])("rejects an attempt bound of %i", (max_attempts) => {
    const result = compile(writerTopology({ max_attempts }));
    expect(result.ok).toBe(false);
  });

  it("accepts network_domains on an agent node", () => {
    const result = compile(writerTopology({ network_domains: ["registry.npmjs.org"] }));
    expect(result.ok).toBe(true);
  });

  it("rejects network_domains declared on a non-agent (set) node", () => {
    const topology = {
      nodes: [{ id: "s", kind: "set" as const, update: {}, network_domains: ["example.com"] }],
      edges: [
        { from: START, to: "s" },
        { from: "s", to: END },
      ],
      max_steps: 10,
    };
    const result = compile(topology);
    expect(result.ok).toBe(false);
  });

  it("rejects a write-capable node reachable from a fan-out edge, naming slice 2b", () => {
    const topology = {
      nodes: [
        { id: "dispatch", kind: "set" as const, update: { "batch.items": ["a", "b"] } },
        { id: "writer", kind: "agent" as const, read_only: false, model: "claude-cheap", prompt: "edit ${item}", output_key: "diff" },
      ],
      edges: [
        { from: START, to: "dispatch" },
        { from: "dispatch", for_each: "batch.items", as: "item", to: "writer" },
        { from: "writer", to: END },
      ],
      max_steps: 10,
    };
    const result = compile(topology);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.message.includes("slice 2b"))).toBe(true);
  });

  it("a read-only node reachable from a fan-out edge still compiles — the restriction is on write capability, not fan-out", () => {
    const result = compile(validTopology()); // "reader" is read_only:true and IS the fan-out target
    expect(result.ok).toBe(true);
  });

  it("a graph with no declared base_ref compiles, leaving the default to be resolved at start", () => {
    const result = compile(validTopology());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.compiled.baseRef).toBeUndefined();
  });

  it("Covers R14: a declared base_ref is carried through to the compiled topology", () => {
    const result = compile({ ...validTopology(), base_ref: "origin/main" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.compiled.baseRef).toBe("origin/main");
  });
});

describe("compile: U2 when-grammar repair — all nine variants round-trip with their operator intact", () => {
  const VARIANTS: Array<{ name: string; rule: Record<string, unknown> }> = [
    { name: "exists", rule: { key: "v.ok", exists: true } },
    { name: "equals", rule: { key: "v.ok", equals: "pass" } },
    { name: "not_equals", rule: { key: "v.ok", not_equals: "pass" } },
    { name: "truthy", rule: { key: "v.ok", truthy: true } },
    { name: "falsy", rule: { key: "v.ok", falsy: true } },
    { name: "contains", rule: { key: "v.tags", contains: "urgent" } },
    { name: "all", rule: { all: [{ key: "v.ok", truthy: true }, { key: "v.n", exists: true }] } },
    { name: "any", rule: { any: [{ key: "v.ok", falsy: true }, { key: "v.n", not_equals: 0 }] } },
    { name: "not", rule: { not: { key: "v.ok", truthy: true } } },
  ];

  function guardedTopology(rule: Record<string, unknown>) {
    return {
      nodes: [
        { id: "router", kind: "set" as const, update: {} },
        { id: "branch", kind: "set" as const, update: {} },
      ],
      edges: [
        { from: START, to: "router" },
        { from: "router", to: "branch", when: rule },
        { from: "branch", to: END },
      ],
      max_steps: 10,
    };
  }

  for (const { name, rule } of VARIANTS) {
    it(`the '${name}' leaf round-trips through compile() with its operator key intact`, () => {
      const result = compile(guardedTopology(rule));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const guardedEdge = result.compiled.plainEdges.find((edge) => edge.to === "branch");
      expect(guardedEdge?.when).toEqual(rule);
    });
  }

  it("all nine variants round-trip intact when nested inside all/any/not (double nesting)", () => {
    const nested = {
      all: [
        { any: [{ key: "a", truthy: true }, { key: "b", falsy: true }] },
        { not: { key: "c", equals: "x" } },
        { key: "d", not_equals: "y" },
        { key: "e", exists: true },
        { key: "f", contains: "z" },
      ],
    };
    const result = compile(guardedTopology(nested));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const guardedEdge = result.compiled.plainEdges.find((edge) => edge.to === "branch");
    expect(guardedEdge?.when).toEqual(nested);
  });

  it("a when leaf with no operator is rejected at compile time, naming the edge", () => {
    const result = compile(guardedTopology({ key: "v.ok" }));
    expect(result.ok).toBe(false);
  });

  it("a when leaf with two operators is rejected at compile time, naming the edge", () => {
    const result = compile(guardedTopology({ key: "v.ok", equals: "pass", truthy: true }));
    expect(result.ok).toBe(false);
  });

  it("Covers slice-1 regression: the truthy form already in the CLI test suite still compiles", () => {
    const result = compile(guardedTopology({ key: "flag", truthy: true }));
    expect(result.ok).toBe(true);
  });
});

describe("compile: per-instance identity (KTD-12)", () => {
  it("a 3-item for_each yields three distinct item keys and instance ids", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const itemKeys = items.map((item, index) => deriveItemKey(item, index));
    expect(new Set(itemKeys).size).toBe(3);

    const instanceIds = itemKeys.map((key) => deriveInstanceId("reader", key));
    expect(new Set(instanceIds).size).toBe(3);
    expect(instanceIds).toEqual(["reader:id:a", "reader:id:b", "reader:id:c"]);
  });

  it("falls back to index when items carry no id field", () => {
    const items = ["a", "b", "c"];
    const itemKeys = items.map((item, index) => deriveItemKey(item, index));
    expect(itemKeys).toEqual(["idx:0", "idx:1", "idx:2"]);
    expect(new Set(itemKeys).size).toBe(3);
  });

  it("does not alias an id-keyed item onto an index-keyed item at the same position", () => {
    // A for_each list mixing {id: "0"} with a plain item at index 0 used to
    // both derive the bare key "0" before namespacing, silently collapsing
    // two distinct branches into one instance id.
    const items = [{ id: "0" }, "plain-item"];
    const itemKeys = items.map((item, index) => deriveItemKey(item, index));
    expect(new Set(itemKeys).size).toBe(2);
    const instanceIds = itemKeys.map((key) => deriveInstanceId("reader", key));
    expect(new Set(instanceIds).size).toBe(2);
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

describe("compile: non-exhaustive-router lint (U3, demoted form of R3's compile-time exhaustiveness)", () => {
  it("warns on a node whose every out-edge is guarded", () => {
    const topology = {
      nodes: [
        { id: "router", kind: "set" as const, update: {} },
        { id: "branch_a", kind: "set" as const, update: {} },
      ],
      edges: [{ from: "router", to: "branch_a", when: { key: "choice", equals: "a" } }],
      max_steps: 10,
    };
    const result = compile(topology);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "non-exhaustive-router", node: "router" }));
  });

  it("stays silent when an unguarded edge is present alongside a guarded one", () => {
    const topology = {
      nodes: [
        { id: "router", kind: "set" as const, update: {} },
        { id: "branch_a", kind: "set" as const, update: {} },
        { id: "fallback", kind: "set" as const, update: {} },
      ],
      edges: [
        { from: "router", to: "branch_a", when: { key: "choice", equals: "a" } },
        { from: "router", to: "fallback" },
      ],
      max_steps: 10,
    };
    const result = compile(topology);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.code === "non-exhaustive-router")).toBe(false);
  });

  it("stays silent on a fully-guarded node that is also a fan-out source", () => {
    const topology = {
      nodes: [
        { id: "dispatch", kind: "set" as const, update: { "batch.items": ["a"] } },
        { id: "reader", kind: "agent" as const, read_only: true as const, model: "m", prompt: "p", output_key: "o" },
      ],
      edges: [
        { from: "dispatch", to: "reader", when: { key: "go", truthy: true } },
        { from: "dispatch", for_each: "batch.items", as: "item", to: "reader" },
      ],
      max_steps: 10,
    };
    const result = compile(topology);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.code === "non-exhaustive-router")).toBe(false);
  });

  it("stays silent on a fully-guarded node that is also a join source", () => {
    const topology = {
      nodes: [
        { id: "r", kind: "set" as const, update: {} },
        { id: "side", kind: "set" as const, update: {} },
        { id: "collector", kind: "set" as const, update: {} },
      ],
      edges: [
        { from: "r", to: "side", when: { key: "never", truthy: true } },
        { from: ["r"], mode: "all" as const, reducer: "append" as const, into: "results", to: "collector" },
      ],
      max_steps: 10,
    };
    const result = compile(topology);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.code === "non-exhaustive-router")).toBe(false);
  });
});
