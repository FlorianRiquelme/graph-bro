// Named import, not default: see src/engine/output-schema.ts for why ajv's
// default import breaks under this project's NodeNext module resolution.
import { Ajv } from "ajv";
import {
  END,
  START,
  TopologySchema,
  isFanOutEdge,
  isJoinEdge,
  isPlainEdge,
  type Edge,
  type FanOutEdge,
  type JoinEdge,
  type PlainEdge,
  type ReducerName,
  type Topology,
  type TopologyNode,
} from "./schema.js";
import { lintJoinDesync, lintNonExhaustiveRouter, type LintWarning } from "./lint.js";

const ajv = new Ajv({ allErrors: true, strict: false });

export interface CompileError {
  message: string;
  path: string;
}

/** A join barrier compiled down to the runtime channel model (§16). */
export interface JoinBarrier {
  id: string;
  sources: string[];
  mode: "all" | "any";
  reducer: ReducerName;
  into: string;
  to: string;
}

export interface CompiledTopology {
  maxSteps: number;
  /** Per-topology override of the bounded fan-out pool's width (ADR-0011), threaded into `EngineGraph.maxConcurrency`. */
  maxConcurrency?: number;
  /** R14: the declared base ref, carried through for `start` to resolve; undefined means "current branch's tip". */
  baseRef?: string;
  nodes: TopologyNode[];
  plainEdges: PlainEdge[];
  fanOutEdges: FanOutEdge[];
  joinBarriers: JoinBarrier[];
}

export type CompileResult =
  | { ok: true; compiled: CompiledTopology; warnings: LintWarning[] }
  | { ok: false; errors: CompileError[] };

/**
 * Validates then wires a topology down to the runtime channel model
 * (compile-during-validation, athena `build_topology`) so a malformed
 * topology never gets a run id.
 */
export function compile(input: unknown): CompileResult {
  const parsed = TopologySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.join("."),
      })),
    };
  }

  const topology: Topology = parsed.data;
  const errors: CompileError[] = [];

  const nodeIds = new Set<string>();
  topology.nodes.forEach((node, nodeIndex) => {
    if (nodeIds.has(node.id)) {
      errors.push({ message: `duplicate node id '${node.id}'`, path: "nodes" });
    }
    nodeIds.add(node.id);

    if (node.kind === "agent" && node.output_schema !== undefined) {
      if (!ajv.validateSchema(node.output_schema)) {
        errors.push({
          message: `agent node '${node.id}' declares an output_schema that is not a well-formed JSON Schema: ${ajv.errorsText(ajv.errors)}`,
          path: `nodes[${nodeIndex}].output_schema`,
        });
      }
    }
  });
  const knownIds = new Set([...nodeIds, START, END]);

  const checkRef = (id: string, path: string) => {
    if (!knownIds.has(id)) {
      errors.push({ message: `edge references unknown node '${id}'`, path });
    }
  };

  topology.edges.forEach((edge: Edge, index: number) => {
    if (isJoinEdge(edge)) {
      edge.from.forEach((source, sourceIndex) => {
        if (source === START) {
          errors.push({
            message: `join into '${edge.to}' cannot include START as a source`,
            path: `edges[${index}].from[${sourceIndex}]`,
          });
        }
        checkRef(source, `edges[${index}].from[${sourceIndex}]`);
      });
      checkRef(edge.to, `edges[${index}].to`);
    } else if (isFanOutEdge(edge) || isPlainEdge(edge)) {
      if (edge.from === END) {
        errors.push({
          message: `edge source cannot be END`,
          path: `edges[${index}].from`,
        });
      }
      checkRef(edge.from, `edges[${index}].from`);
      checkRef(edge.to, `edges[${index}].to`);
    }
  });

  // Single-track scope boundary (slice 2b defers fan-out write lanes): a
  // write-capable node running N-wide concurrent instances in one shared
  // workspace is exactly the silent-loss failure mode this milestone cites
  // as its reason to isolate at all. Only a fan-out edge's *direct* target
  // ever runs N-wide — `transition()` collapses any further downstream node
  // back to one instance per step via `pushUnique`'s instanceId dedup — so
  // checking direct targets is the complete check, not an approximation.
  const writeCapableIds = new Set(
    topology.nodes.filter((node) => node.kind === "agent" && node.read_only === false).map((node) => node.id),
  );
  topology.edges.forEach((edge: Edge, index: number) => {
    if (!isFanOutEdge(edge)) return;
    if (writeCapableIds.has(edge.to)) {
      errors.push({
        message: `write-capable node '${edge.to}' cannot be reached from a fan-out edge — fan-out write lanes are deferred to slice 2b`,
        path: `edges[${index}].to`,
      });
    }
  });

  // KTD-10 compile-time courtesy for the single-track guard: the real
  // enforcement is the runtime frontier assertion in `engine/loop.ts`, which
  // sees the actual dispatch frontier; this check only catches the shape
  // provably concurrent from the static graph, before a run id is minted.
  // Guards are evaluated independently per edge (not "one of N" routing), so
  // two out-edges out of one source both dispatch in the same super-step
  // *unless* they are guarded mutually exclusive — do NOT reject merely for
  // having more than one out-edge into a write-capable target (that rejects
  // `examples/review-fix-loop`'s pass/fail router, which is exactly the
  // mutually-exclusive shape this deliberately admits).
  const plainEdgesBySourceForGuard = new Map<string, PlainEdge[]>();
  for (const edge of topology.edges.filter(isPlainEdge)) {
    const list = plainEdgesBySourceForGuard.get(edge.from) ?? [];
    list.push(edge);
    plainEdgesBySourceForGuard.set(edge.from, list);
  }
  for (const [source, edges] of plainEdgesBySourceForGuard) {
    if (edges.length < 2) continue;
    const writeTargets = edges.filter((edge) => writeCapableIds.has(edge.to));
    if (writeTargets.length === 0) continue;
    if (!isMutuallyExclusiveGroup(edges)) {
      errors.push({
        message: `node '${source}' has out-edges into write-capable node(s) '${[...new Set(writeTargets.map((edge) => edge.to))].join("', '")}' that are not provably mutually exclusive — two could dispatch in the same super-step and interleave edits against one worktree (KTD-10 deferral); guard all of '${source}''s out-edges on one shared state key with distinct 'equals' literals`,
        path: "edges",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const plainEdges = topology.edges.filter(isPlainEdge);
  const fanOutEdges = topology.edges.filter(isFanOutEdge);
  const joinEdges: JoinEdge[] = topology.edges.filter(isJoinEdge);
  const joinBarriers: JoinBarrier[] = joinEdges.map((edge) => ({
    id: `${edge.from.join(",")}=>${edge.to}`,
    sources: edge.from,
    mode: edge.mode,
    reducer: edge.reducer,
    into: edge.into,
    to: edge.to,
  }));

  const compiled: CompiledTopology = {
    maxSteps: topology.max_steps,
    maxConcurrency: topology.max_concurrency,
    baseRef: topology.base_ref,
    nodes: topology.nodes,
    plainEdges,
    fanOutEdges,
    joinBarriers,
  };

  return { ok: true, compiled, warnings: [...lintJoinDesync(topology), ...lintNonExhaustiveRouter(topology)] };
}

/**
 * KTD-10: a group of out-edges from one source is provably mutually
 * exclusive only when every edge is guarded, all guards read the same state
 * key via the `equals` operator (the only leaf shape carrying a distinct
 * literal to compare — `truthy`/`falsy`/`exists`/`contains` don't partition
 * a domain into disjoint literals), and every edge's literal is distinct
 * from every other's. One unguarded edge in the group always fires
 * alongside whatever else fires, so it fails this check by construction.
 */
function isMutuallyExclusiveGroup(edges: PlainEdge[]): boolean {
  if (edges.some((edge) => edge.when === undefined)) return false;
  const keys = new Set<string>();
  const literals = new Set<string>();
  for (const edge of edges) {
    const when = edge.when as { key?: string; equals?: unknown };
    if (when.key === undefined || !("equals" in when) || when.equals === undefined) return false;
    keys.add(when.key);
    literals.add(JSON.stringify(when.equals));
  }
  return keys.size === 1 && literals.size === edges.length;
}

/**
 * Per-instance identity (KTD-12): a fan-out reuses one node id for all N
 * branches, so the join barrier and pending-write key must discriminate
 * branches by a key derived from the `for_each` item — the item's own `id`
 * field if present, else its index.
 */
export function deriveItemKey(item: unknown, index: number): string {
  // Namespaced so the id-keyed and index-keyed derivation paths can never
  // collide: a `for_each` list mixing `{id: "0"}` objects with plain items
  // (index 0) would otherwise both derive the bare key "0", silently
  // aliasing two distinct branches onto one instance id (KTD-12 violation —
  // one branch's output is dropped with no error).
  if (
    item !== null &&
    typeof item === "object" &&
    "id" in item &&
    (typeof (item as { id: unknown }).id === "string" ||
      typeof (item as { id: unknown }).id === "number")
  ) {
    return `id:${(item as { id: string | number }).id}`;
  }
  return `idx:${index}`;
}

/** `${node}:${itemKey}` — the per-instance id threaded into the barrier and pending-write key. */
export function deriveInstanceId(nodeId: string, itemKey: string): string {
  return `${nodeId}:${itemKey}`;
}
