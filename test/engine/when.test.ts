import { describe, expect, it } from "vitest";
import { evaluateWhen } from "../../src/engine/when.js";
import { WhenRuleSchema, type WhenRule } from "../../src/topology/schema.js";

/** Round-trips through the compiled grammar (U2) before evaluating — a hand-built literal skips the parse step where four of the nine variants used to lose their operator. */
function parse(rule: unknown): WhenRule {
  return WhenRuleSchema.parse(rule);
}

describe("engine/when: evaluateWhen — every grammar variant", () => {
  const state = { v: { ok: true, n: 0, tags: ["urgent", "bug"], nested: { verdict: "pass" } } };

  it("exists: true when the path is present, false when absent", () => {
    expect(evaluateWhen(parse({ key: "v.ok", exists: true }), state).result).toBe(true);
    expect(evaluateWhen(parse({ key: "v.missing", exists: true }), state).result).toBe(false);
    expect(evaluateWhen(parse({ key: "v.missing", exists: false }), state).result).toBe(true);
  });

  it("equals: strict/structural match", () => {
    expect(evaluateWhen(parse({ key: "v.n", equals: 0 }), state).result).toBe(true);
    expect(evaluateWhen(parse({ key: "v.n", equals: 1 }), state).result).toBe(false);
    expect(evaluateWhen(parse({ key: "v.nested", equals: { verdict: "pass" } }), state).result).toBe(true);
  });

  it("not_equals: the inverse of equals", () => {
    expect(evaluateWhen(parse({ key: "v.n", not_equals: 1 }), state).result).toBe(true);
    expect(evaluateWhen(parse({ key: "v.n", not_equals: 0 }), state).result).toBe(false);
  });

  it("truthy / falsy", () => {
    expect(evaluateWhen(parse({ key: "v.ok", truthy: true }), state).result).toBe(true);
    expect(evaluateWhen(parse({ key: "v.n", truthy: true }), state).result).toBe(false); // 0 is falsy
    expect(evaluateWhen(parse({ key: "v.n", falsy: true }), state).result).toBe(true);
    expect(evaluateWhen(parse({ key: "v.ok", falsy: true }), state).result).toBe(false);
  });

  it("contains: array membership and substring", () => {
    expect(evaluateWhen(parse({ key: "v.tags", contains: "urgent" }), state).result).toBe(true);
    expect(evaluateWhen(parse({ key: "v.tags", contains: "nope" }), state).result).toBe(false);
    expect(evaluateWhen(parse({ key: "v.nested.verdict", contains: "as" }), state).result).toBe(true); // substring of "pass"
  });

  it("a path that does not exist evaluates false rather than throwing", () => {
    expect(() => evaluateWhen(parse({ key: "does.not.exist", truthy: true }), state)).not.toThrow();
    expect(evaluateWhen(parse({ key: "does.not.exist", truthy: true }), state).result).toBe(false);
  });

  it("all/any/not compose correctly, including negation", () => {
    const all = parse({ all: [{ key: "v.ok", truthy: true }, { key: "v.n", exists: true }] });
    expect(evaluateWhen(all, state).result).toBe(true);

    const anyFail = parse({ any: [{ key: "v.ok", falsy: true }, { key: "v.n", equals: 5 }] });
    expect(evaluateWhen(anyFail, state).result).toBe(false);

    const not = parse({ not: { key: "v.ok", truthy: true } });
    expect(evaluateWhen(not, state).result).toBe(false);

    const doubleNested = parse({
      all: [{ any: [{ key: "v.ok", falsy: true }, { key: "v.n", equals: 0 }] }, { not: { key: "v.missing", exists: true } }],
    });
    expect(evaluateWhen(doubleNested, state).result).toBe(true);
  });

  it("a guard reading a dotted path into a parsed structured-output object resolves", () => {
    const reviewState = { review: { verdict: "pass", findings: [] } };
    expect(evaluateWhen(parse({ key: "review.verdict", equals: "pass" }), reviewState).result).toBe(true);
  });

  it("collects every path read, for the routing-decision trace (R24)", () => {
    const rule = parse({ all: [{ key: "v.ok", truthy: true }, { key: "v.n", equals: 0 }] });
    const evaluation = evaluateWhen(rule, state);
    expect(evaluation.reads).toEqual({ "v.ok": true, "v.n": 0 });
  });
});
