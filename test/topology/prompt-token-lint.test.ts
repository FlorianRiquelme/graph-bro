import { describe, expect, it } from "vitest";
import { compile } from "../../src/topology/compile.js";
import { checkPromptTokens, collectStateRootKeys } from "../../src/topology/lint.js";

/** Compiles a topology, asserting success, so the checks below run on a real `CompiledTopology`. */
function compiled(topology: unknown) {
  const result = compile(topology);
  if (!result.ok) throw new Error(`fixture failed to compile: ${JSON.stringify(result.errors)}`);
  return result.compiled;
}

function agent(id: string, prompt: string, outputKey = `${id}_out`) {
  return { id, kind: "agent", read_only: true, model: "claude-haiku-4-5", prompt, output_key: outputKey };
}

describe("topology: prompt-token root-key check (graph-bro#7)", () => {
  describe("collectStateRootKeys", () => {
    it("collects an agent node's output_key", () => {
      const topology = {
        nodes: [agent("reader", "ping", "greeting")],
        edges: [
          { from: "START", to: "reader" },
          { from: "reader", to: "END" },
        ],
        max_steps: 10,
      };
      expect(collectStateRootKeys(compiled(topology), [])).toContain("greeting");
    });

    it("collects a set node's update keys", () => {
      const topology = {
        nodes: [{ id: "seed", kind: "set", update: { alpha: 1, beta: 2 } }],
        edges: [
          { from: "START", to: "seed" },
          { from: "seed", to: "END" },
        ],
        max_steps: 10,
      };
      const roots = collectStateRootKeys(compiled(topology), []);
      expect(roots).toContain("alpha");
      expect(roots).toContain("beta");
    });

    it("collects a fan-out edge's `as` binding", () => {
      const topology = {
        nodes: [
          { id: "dispatch", kind: "set", update: { batch: { items: ["a"] } } },
          agent("reader", "read {{ item }}", "results"),
          { id: "collector", kind: "set", update: { collected: true } },
        ],
        edges: [
          { from: "START", to: "dispatch" },
          { from: "dispatch", for_each: "batch.items", as: "item", to: "reader" },
          { from: ["reader"], mode: "all", reducer: "dedup", into: "joined", to: "collector" },
          { from: "collector", to: "END" },
        ],
        max_steps: 10,
      };
      const roots = collectStateRootKeys(compiled(topology), []);
      expect(roots).toContain("item");
      // A join's `into` is a reducer-lookup key, not a state write — no node
      // here writes "joined", so it must not be counted as a producible root.
      expect(roots).not.toContain("joined");
    });

    it("collects the run's initial input root keys", () => {
      const topology = {
        nodes: [agent("reader", "ping")],
        edges: [
          { from: "START", to: "reader" },
          { from: "reader", to: "END" },
        ],
        max_steps: 10,
      };
      expect(collectStateRootKeys(compiled(topology), ["seeded"])).toContain("seeded");
    });

    it("treats a dotted set-update key as one literal root — mergeWrites writes flat keys", () => {
      // `update: {"batch.items": [...]}` creates a top-level key *named*
      // "batch.items"; it does NOT create a nested {batch: {items}}. So the
      // root it contributes is the whole literal string.
      const topology = {
        nodes: [{ id: "seed", kind: "set", update: { "batch.items": ["a"] } }],
        edges: [
          { from: "START", to: "seed" },
          { from: "seed", to: "END" },
        ],
        max_steps: 10,
      };
      const roots = collectStateRootKeys(compiled(topology), []);
      expect(roots).toContain("batch.items");
      expect(roots).not.toContain("batch");
    });
  });

  describe("checkPromptTokens", () => {
    function checkOne(prompt: string, extra: { inputRootKeys?: string[] } = {}) {
      const topology = {
        nodes: [
          { id: "seed", kind: "set", update: { known: { nested: 1 } } },
          agent("reader", prompt),
        ],
        edges: [
          { from: "START", to: "seed" },
          { from: "seed", to: "reader" },
          { from: "reader", to: "END" },
        ],
        max_steps: 10,
      };
      return checkPromptTokens(compiled(topology), extra.inputRootKeys ?? []);
    }

    it("accepts a token whose root key is produced somewhere in the topology", () => {
      expect(checkOne("use {{ known }}")).toEqual([]);
    });

    it("accepts a deep dotted path as long as its root is produced", () => {
      // Depth is a runtime fact (the issue's Why-deferred); only the root is checked.
      expect(checkOne("use {{ known.nested.deeper.still }}")).toEqual([]);
    });

    it("rejects a typo'd root key, naming the node, the token and the root", () => {
      const errors = checkOne("use {{ knwon.nested }}");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        code: "unknown-prompt-token-root",
        nodeId: "reader",
        path: "knwon.nested",
        root: "knwon",
      });
      expect(errors[0].message).toContain("reader");
      expect(errors[0].message).toContain("knwon");
    });

    it("scopes the message's claim to this topology, since that is all it checked (graph-bro#13)", () => {
      // The check is whole-topology, never "when does the writer run" — so it
      // must not assert the absolute "no node writes this key".
      const errors = checkOne("use {{ knwon }}");
      expect(errors[0].message).toContain("no node in this topology writes");
    });

    it("accepts a token whose root only a strictly LATER node writes — whole-topology by design", () => {
      // Pins the documented scope limit: this clears the gate and then fails at
      // activation time with UnresolvedPromptTokenError (R5). Deliberate — the
      // per-node reachability analysis it would take is out of graph-bro#7's scope.
      const topology = {
        nodes: [
          agent("reader", "use {{ written_later }}"),
          { id: "late", kind: "set", update: { written_later: "too late" } },
        ],
        edges: [
          { from: "START", to: "reader" },
          { from: "reader", to: "late" },
          { from: "late", to: "END" },
        ],
        max_steps: 10,
      };
      expect(checkPromptTokens(compiled(topology), [])).toEqual([]);
    });

    it("accepts a root key supplied only via the run's --input", () => {
      expect(checkOne("use {{ seeded }}", { inputRootKeys: ["seeded"] })).toEqual([]);
    });

    it("does not flag an escaped literal token (needs graph-bro#8's grammar)", () => {
      expect(checkOne("emit \\{{ not_a_token }} verbatim")).toEqual([]);
    });

    it("reports every bad token in one pass, not just the first", () => {
      const errors = checkOne("{{ bad_one }} and {{ bad_two }}");
      expect(errors.map((error) => error.root)).toEqual(["bad_one", "bad_two"]);
    });

    it("accepts a token bound by a fan-out `as`, which exists only per-branch", () => {
      const topology = {
        nodes: [
          { id: "dispatch", kind: "set", update: { batch: { items: ["a"] } } },
          agent("reader", "read {{ item.note }}", "results"),
        ],
        edges: [
          { from: "START", to: "dispatch" },
          { from: "dispatch", for_each: "batch.items", as: "item", to: "reader" },
          { from: "reader", to: "END" },
        ],
        max_steps: 10,
      };
      expect(checkPromptTokens(compiled(topology), [])).toEqual([]);
    });

    it("rejects a token rooted at a join `into` that no node writes (graph-bro#7)", () => {
      const topology = {
        nodes: [
          { id: "dispatch", kind: "set", update: { batch: { items: ["a"] } } },
          agent("reader", "read {{ item }}", "reader_out"),
          agent("collector", "collected: {{ collected }}"),
        ],
        edges: [
          { from: "START", to: "dispatch" },
          { from: "dispatch", for_each: "batch.items", as: "item", to: "reader" },
          { from: ["reader"], mode: "all", reducer: "dedup", into: "collected", to: "collector" },
          { from: "collector", to: "END" },
        ],
        max_steps: 10,
      };
      const errors = checkPromptTokens(compiled(topology), []);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ root: "collected" });
    });

    it("ignores set nodes — only agent prompts are templated", () => {
      const topology = {
        nodes: [{ id: "seed", kind: "set", update: { text: "{{ not_templated }}" } }],
        edges: [
          { from: "START", to: "seed" },
          { from: "seed", to: "END" },
        ],
        max_steps: 10,
      };
      expect(checkPromptTokens(compiled(topology), [])).toEqual([]);
    });
  });
});
