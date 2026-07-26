import { z } from "zod";

/**
 * Sentinel node ids, following athena-graphs' START/END convention (§13.2).
 * Not declared as `Node` objects — only referenced from `from`/`to`.
 */
export const START = "START";
export const END = "END";

/** Built-in reducer names (ADR-0005 / CONTEXT.md). */
export const REDUCER_NAMES = ["append", "merge", "sum", "dedup"] as const;
export const ReducerNameSchema = z.enum(REDUCER_NAMES);
export type ReducerName = z.infer<typeof ReducerNameSchema>;

/**
 * The `when` DSL grammar (§13.2) — a small recursive, serializable condition
 * language over dotted state paths. Used only for compile-time lint analysis
 * in slice 1 (conditional routing execution is deferred, KTD-7).
 */
export type WhenRule =
  | { all: WhenRule[] }
  | { any: WhenRule[] }
  | { not: WhenRule }
  | { key: string; exists: boolean }
  | { key: string; equals?: unknown }
  | { key: string; not_equals?: unknown }
  | { key: string; truthy: true }
  | { key: string; falsy: true }
  | { key: string; contains?: unknown };

/**
 * A JSON value, used for `equals`/`not_equals`/`contains` operands so the
 * key is genuinely *required* rather than merely typed. `z.unknown()` alone
 * accepts a *missing* property too (`unknown` includes `undefined`), which
 * is exactly the U2 grammar defect: it let the wrong leaf variant match a
 * legitimately-authored leaf missing that variant's operator.
 */
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * U2 grammar repair: each leaf variant is `.strict()` so an authored leaf can
 * match at most one variant. Two defects this fixes together — probe-verified
 * against the repo's zod, both silently reachable before this change:
 * (1) an extra, wrong-operator key used to be silently stripped rather than
 * rejected (`.strict()` alone fixes this); (2) a bare `{key}` with no
 * operator at all used to match the `equals` variant, since `z.unknown()`
 * accepts a missing property (the `JsonValueSchema` operand type above fixes
 * this — the operator key becomes genuinely required, not just typed).
 */
export const WhenRuleSchema: z.ZodType<WhenRule> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(WhenRuleSchema) }).strict(),
    z.object({ any: z.array(WhenRuleSchema) }).strict(),
    z.object({ not: WhenRuleSchema }).strict(),
    z.object({ key: z.string().min(1), exists: z.boolean() }).strict(),
    z.object({ key: z.string().min(1), equals: JsonValueSchema }).strict(),
    z.object({ key: z.string().min(1), not_equals: JsonValueSchema }).strict(),
    z.object({ key: z.string().min(1), truthy: z.literal(true) }).strict(),
    z.object({ key: z.string().min(1), falsy: z.literal(true) }).strict(),
    z.object({ key: z.string().min(1), contains: JsonValueSchema }).strict(),
  ]),
);

/**
 * `agent` node: runs a CLI coding agent. `read_only` was `z.literal(true)` in
 * slice 1 (a write-capable node had no shipped policy yet); slice 2 gives
 * write nodes their own enforcement (U6), so it is a plain boolean now (R8).
 * `.strict()` so a field meaningful only for a write-capable node —
 * `network_domains` — or one meaningful only for an agent node —
 * `output_schema`, `max_attempts` — placed on the wrong node kind is a
 * compile error rather than silently stripped (matches `SetNodeSchema`).
 */
export const AgentNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("agent"),
    read_only: z.boolean(),
    model: z.string().min(1),
    prompt: z.string().min(1),
    output_key: z.string().min(1),
    /** R2: a JSON Schema this node's response is validated against (KTD-8); well-formedness is checked in `compile()`, which owns the ajv dependency. */
    output_schema: z.record(z.string(), z.unknown()).optional(),
    /** R6: the attempt bound — how many times a loop's re-entered node may activate before `not_converged` (CONTEXT.md "attempt bound"). */
    max_attempts: z.number().int().positive().optional(),
    /** R11: domains this write-capable node's sandboxed shell may reach; absent means none. */
    network_domains: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type AgentNode = z.infer<typeof AgentNodeSchema>;

/** `set` node: deterministic state write, no model call. `.strict()`: see `AgentNodeSchema`. */
export const SetNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("set"),
    update: z.record(z.string(), z.unknown()),
  })
  .strict();
export type SetNode = z.infer<typeof SetNodeSchema>;

export const NodeSchema = z.discriminatedUnion("kind", [
  AgentNodeSchema,
  SetNodeSchema,
]);
export type TopologyNode = z.infer<typeof NodeSchema>;

/** Plain edge: single source, single target, optional `when` guard. */
export const PlainEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  when: WhenRuleSchema.optional(),
});
export type PlainEdge = z.infer<typeof PlainEdgeSchema>;

/**
 * Fan-out edge modifier (ADR-0005): spawns one instance of `to` per item in
 * the runtime list at `for_each` (a dotted state path). `as` names the
 * per-branch item binding, and its key/index is the per-instance identity
 * threaded into the join barrier and pending-write key (KTD-12).
 */
export const FanOutEdgeSchema = z.object({
  from: z.string().min(1),
  for_each: z.string().min(1),
  as: z.string().min(1),
  to: z.string().min(1),
});
export type FanOutEdge = z.infer<typeof FanOutEdgeSchema>;

/**
 * Join edge: multi-source barrier, `mode` split from `reducer` (ADR-0005).
 * `from` is an array of *declared* source names — a single-element array is
 * valid: a dynamic fan-out reuses one node id for all N branches, so the
 * join's static source list has size 1 while the runtime barrier still
 * discriminates the N branch instances by their per-instance id (KTD-12).
 */
export const JoinEdgeSchema = z.object({
  from: z.array(z.string().min(1)).min(1),
  mode: z.enum(["all", "any"]),
  reducer: ReducerNameSchema,
  into: z.string().min(1),
  to: z.string().min(1),
});
export type JoinEdge = z.infer<typeof JoinEdgeSchema>;

/**
 * An edge is one of the three composable shapes. Zod tries join (array
 * `from`) first, then fan-out (`for_each` present), then plain — the shapes
 * are mutually exclusive by field set, so this is unambiguous.
 */
export const EdgeSchema = z.union([
  JoinEdgeSchema,
  FanOutEdgeSchema,
  PlainEdgeSchema,
]);
export type Edge = z.infer<typeof EdgeSchema>;

export function isJoinEdge(edge: Edge): edge is JoinEdge {
  return Array.isArray(edge.from);
}

export function isFanOutEdge(edge: Edge): edge is FanOutEdge {
  return !Array.isArray(edge.from) && "for_each" in edge;
}

export function isPlainEdge(edge: Edge): edge is PlainEdge {
  return !Array.isArray(edge.from) && !("for_each" in edge);
}

/** The serializable topology envelope (nodes + edges + max_steps, ADR-0005). */
export const TopologySchema = z.object({
  nodes: z.array(NodeSchema).min(1),
  edges: z.array(EdgeSchema),
  max_steps: z.number().int().positive(),
  /** Per-topology override of the bounded fan-out pool's width (ADR-0011); defaults to the engine's K=5 if omitted. */
  max_concurrency: z.number().int().positive().optional(),
  /** R14: the committed ref the run's workspace is created from; defaults to the current branch's tip (resolved at `start`, not here). */
  base_ref: z.string().min(1).optional(),
});
export type Topology = z.infer<typeof TopologySchema>;
