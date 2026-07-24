import type { Edge, JoinEdge, Topology } from "./schema.js";
import { isJoinEdge, isPlainEdge } from "./schema.js";

export interface JoinDesyncWarning {
  code: "join-desync";
  join: string;
  source: string;
  router: string;
  message: string;
}

export type LintWarning = JoinDesyncWarning;

/**
 * §14.9 compile-time join-desync lint: warn when a join's declared source is
 * only *conditionally* reached (a plain edge into it carries a `when` guard),
 * since a router that skips that path leaves the join stalled forever. Does
 * **not** hard-error an always-both-fire router — two unconditional edges out
 * of one source into a static join is the §14.1 non-counterexample: both
 * destinations are always reached, so there is no desync risk.
 */
export function lintJoinDesync(topology: Topology): JoinDesyncWarning[] {
  const warnings: JoinDesyncWarning[] = [];
  const joinEdges: JoinEdge[] = topology.edges.filter(isJoinEdge);

  for (const join of joinEdges) {
    for (const source of join.from) {
      const incoming = topology.edges.filter(
        (edge: Edge) => isPlainEdge(edge) && edge.to === source && edge.when !== undefined,
      );
      for (const edge of incoming) {
        if (!isPlainEdge(edge)) continue;
        warnings.push({
          code: "join-desync",
          join: join.to,
          source,
          router: edge.from,
          message: `join '${join.to}' requires '${source}', but '${source}' is only conditionally reached from '${edge.from}'; insert a funnel node`,
        });
      }
    }
  }

  return warnings;
}
