import type { WhenRule } from "../topology/schema.js";
import { getPath, type EngineState } from "./state.js";

/** The result of evaluating one `when` rule against state, plus every dotted path it read (R24's routing-decision trace). */
export interface WhenEvaluation {
  result: boolean;
  reads: Record<string, unknown>;
}

/** Structural equality over plain JSON values (no cycles, no functions) — what `equals`/`not_equals`/`contains` compare with. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) => key in (b as Record<string, unknown>) && jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/**
 * Evaluates every leaf variant in the `when` grammar (U2 repaired all nine to
 * survive parsing intact) against `state`, reading through the existing
 * dotted-path traversal so a parsed object at a flat output key is
 * addressable with no new machinery. Collects every path read along the way
 * for the routing-decision trace (R24) — a path that does not exist in state
 * reads as `undefined` and evaluates false, never throws (R1's guard is not
 * a place for `UnresolvedPromptTokenError`'s fail-loud stance).
 */
export function evaluateWhen(rule: WhenRule, state: EngineState): WhenEvaluation {
  const reads: Record<string, unknown> = {};

  function evalRule(r: WhenRule): boolean {
    if ("all" in r) return r.all.every(evalRule);
    if ("any" in r) return r.any.some(evalRule);
    if ("not" in r) return !evalRule(r.not);

    const value = getPath(state, r.key);
    reads[r.key] = value;

    if ("exists" in r) return (value !== undefined) === r.exists;
    if ("equals" in r) return jsonEqual(value, r.equals);
    if ("not_equals" in r) return !jsonEqual(value, r.not_equals);
    if ("truthy" in r) return Boolean(value);
    if ("falsy" in r) return !value;
    if ("contains" in r) {
      if (Array.isArray(value)) return value.some((item) => jsonEqual(item, r.contains));
      if (typeof value === "string" && typeof r.contains === "string") return value.includes(r.contains);
      return false;
    }
    // Unreachable given WhenRuleSchema's exhaustive, `.strict()` leaf union (U2) — kept as a loud
    // signal rather than a silent `false` in case a future grammar variant is added here first.
    throw new Error(`evaluateWhen: unrecognized when-rule leaf: ${JSON.stringify(r)}`);
  }

  return { result: evalRule(rule), reads };
}
