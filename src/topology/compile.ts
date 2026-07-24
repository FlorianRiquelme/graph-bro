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
import { lintJoinDesync, type LintWarning } from "./lint.js";

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
  for (const node of topology.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push({ message: `duplicate node id '${node.id}'`, path: "nodes" });
    }
    nodeIds.add(node.id);
  }
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
    } else if (isFanOutEdge(edge)) {
      if (edge.from === END) {
        errors.push({
          message: `edge source cannot be END`,
          path: `edges[${index}].from`,
        });
      }
      checkRef(edge.from, `edges[${index}].from`);
      checkRef(edge.to, `edges[${index}].to`);
    } else if (isPlainEdge(edge)) {
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
    nodes: topology.nodes,
    plainEdges,
    fanOutEdges,
    joinBarriers,
  };

  return { ok: true, compiled, warnings: lintJoinDesync(topology) };
}

/**
 * Per-instance identity (KTD-12): a fan-out reuses one node id for all N
 * branches, so the join barrier and pending-write key must discriminate
 * branches by a key derived from the `for_each` item — the item's own `id`
 * field if present, else its index.
 */
export function deriveItemKey(item: unknown, index: number): string {
  if (
    item !== null &&
    typeof item === "object" &&
    "id" in item &&
    (typeof (item as { id: unknown }).id === "string" ||
      typeof (item as { id: unknown }).id === "number")
  ) {
    return String((item as { id: string | number }).id);
  }
  return String(index);
}

/** `${node}:${itemKey}` — the per-instance id threaded into the barrier and pending-write key. */
export function deriveInstanceId(nodeId: string, itemKey: string): string {
  return `${nodeId}:${itemKey}`;
}
