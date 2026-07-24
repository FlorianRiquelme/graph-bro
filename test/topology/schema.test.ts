import { describe, expect, it } from "vitest";
import {
  AgentNodeSchema,
  EdgeSchema,
  FanOutEdgeSchema,
  JoinEdgeSchema,
  TopologySchema,
} from "../../src/topology/schema.js";

describe("schema", () => {
  it("round-trips a fan-out edge (for_each/as) through serialize -> deserialize", () => {
    const edge = { from: "dispatch", for_each: "batch.items", as: "item", to: "read" };
    const parsed = FanOutEdgeSchema.parse(edge);
    const roundTripped = JSON.parse(JSON.stringify(parsed));
    expect(EdgeSchema.parse(roundTripped)).toEqual(edge);
  });

  it("round-trips a join edge (mode/reducer/into) through serialize -> deserialize", () => {
    const edge = {
      from: ["read_1", "read_2"],
      mode: "all",
      reducer: "dedup",
      into: "results",
      to: "join",
    };
    const parsed = JoinEdgeSchema.parse(edge);
    const roundTripped = JSON.parse(JSON.stringify(parsed));
    expect(EdgeSchema.parse(roundTripped)).toEqual(edge);
  });

  it("an agent node with read_only:true and model survives serialize -> deserialize", () => {
    const node = {
      id: "reader",
      kind: "agent" as const,
      read_only: true as const,
      model: "claude-cheap",
      prompt: "read ${item}",
      output_key: "finding",
    };
    const parsed = AgentNodeSchema.parse(node);
    const roundTripped = JSON.parse(JSON.stringify(parsed));
    expect(AgentNodeSchema.parse(roundTripped)).toEqual(node);
  });

  it("rejects an agent node with read_only:false", () => {
    const node = {
      id: "writer",
      kind: "agent",
      read_only: false,
      model: "claude-cheap",
      prompt: "edit ${item}",
      output_key: "finding",
    };
    expect(AgentNodeSchema.safeParse(node).success).toBe(false);
  });

  it("rejects an agent node with read_only omitted", () => {
    const node = {
      id: "writer",
      kind: "agent",
      model: "claude-cheap",
      prompt: "edit ${item}",
      output_key: "finding",
    };
    expect(AgentNodeSchema.safeParse(node).success).toBe(false);
  });

  it("rejects a topology missing max_steps", () => {
    const topology = {
      nodes: [
        {
          id: "reader",
          kind: "agent",
          read_only: true,
          model: "claude-cheap",
          prompt: "read",
          output_key: "finding",
        },
      ],
      edges: [],
    };
    expect(TopologySchema.safeParse(topology).success).toBe(false);
  });

  it("rejects an unknown node kind", () => {
    const topology = {
      nodes: [{ id: "n1", kind: "human", question: "?" }],
      edges: [],
      max_steps: 10,
    };
    expect(TopologySchema.safeParse(topology).success).toBe(false);
  });

  it("rejects an unknown reducer name", () => {
    const edge = {
      from: ["a", "b"],
      mode: "all",
      reducer: "concat",
      into: "results",
      to: "join",
    };
    expect(JoinEdgeSchema.safeParse(edge).success).toBe(false);
  });
});
