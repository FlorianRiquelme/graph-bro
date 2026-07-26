import { extractTokenPaths } from "./prompt-tokens.js";
import type { CompiledTopology } from "./compile.js";
import type { Edge, JoinEdge, PlainEdge, Topology } from "./schema.js";
import { isFanOutEdge, isJoinEdge, isPlainEdge } from "./schema.js";

export interface JoinDesyncWarning {
  code: "join-desync";
  join: string;
  source: string;
  router: string;
  message: string;
}

export interface NonExhaustiveRouterWarning {
  code: "non-exhaustive-router";
  node: string;
  message: string;
}

export type LintWarning = JoinDesyncWarning | NonExhaustiveRouterWarning;

/**
 * A prompt token whose *root* state key is produced by nothing in the run —
 * a typo, caught before a run id is minted rather than mid-run (graph-bro#7).
 * Fatal, not advisory: the same fail-loud stance as `UnresolvedPromptTokenError`
 * (ADR-0006), just moved earlier.
 */
export interface UnknownPromptTokenRootError {
  code: "unknown-prompt-token-root";
  nodeId: string;
  /** The full dotted path as written in the prompt. */
  path: string;
  /** Its first segment — the only part statically checkable. */
  root: string;
  message: string;
}

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

/**
 * U3/KTD-6: the demoted form of compile-time exhaustiveness (Product
 * Contract decision) — a warning, never an error, because forcing filler
 * edges into END is worse than failing at run time with the value named
 * (R3). Structural only: it does not evaluate rules, only whether a node's
 * *declared* out-edges leave no unconditional path. Mirrors the runtime
 * check's two exclusions so the same graphs that never trip R3's loud
 * failure at run time don't get warned about it at compile time either: a
 * node with an (unguarded, by grammar) fan-out edge, or one that is itself a
 * join source, always has an unconditional contribution.
 */
export function lintNonExhaustiveRouter(topology: Topology): NonExhaustiveRouterWarning[] {
  const warnings: NonExhaustiveRouterWarning[] = [];

  const plainEdgesBySource = new Map<string, PlainEdge[]>();
  for (const edge of topology.edges.filter(isPlainEdge)) {
    const list = plainEdgesBySource.get(edge.from) ?? [];
    list.push(edge);
    plainEdgesBySource.set(edge.from, list);
  }
  const fanOutSources = new Set(topology.edges.filter(isFanOutEdge).map((edge) => edge.from));
  const joinSourceIds = new Set(topology.edges.filter(isJoinEdge).flatMap((edge) => edge.from));

  for (const [source, edges] of plainEdgesBySource) {
    if (fanOutSources.has(source) || joinSourceIds.has(source)) continue;
    if (edges.every((edge) => edge.when !== undefined)) {
      warnings.push({
        code: "non-exhaustive-router",
        node: source,
        message: `node '${source}' has only guarded out-edges; if none match at run time the run fails loudly (R3) — add an unguarded fallback edge if that isn't intended`,
      });
    }
  }

  return warnings;
}

/**
 * Every root state key the run can produce: `set` update keys, `agent`
 * `output_key`s, fan-out `as` bindings, plus the top-level keys of the run's
 * `--input` snapshot. A join's `into` is deliberately not counted here — it
 * is only ever used as a reducer-lookup key, never itself written into state
 * (`reducerForKey.set(jb.into, jb.reducer)`), so in intended usage it
 * coincides with some node's `output_key`, which already contributes that
 * root on its own.
 *
 * Root keys only, and deliberately flat: `mergeWrites` assigns each write key
 * verbatim, so an update key written as `"batch.items"` produces one top-level
 * key *named* `batch.items` — not a nested `{batch: {items}}`. Read paths, by
 * contrast, are dotted and traverse nesting. Enumerating roots is therefore
 * exact, while anything deeper is a runtime fact (graph-bro#7's Why-deferred:
 * per-branch item shape varies branch to branch).
 *
 * Whole-topology, not per-node reachability — a key produced anywhere counts
 * everywhere. That is the cheap half of the check: it catches typos without
 * the "what keys exist at node X" analysis the issue rules out as oversized.
 */
export function collectStateRootKeys(compiled: CompiledTopology, inputRootKeys: string[]): string[] {
  const roots = new Set<string>(inputRootKeys);

  for (const node of compiled.nodes) {
    if (node.kind === "set") {
      for (const key of Object.keys(node.update)) roots.add(key);
    } else {
      roots.add(node.output_key);
    }
  }
  for (const edge of compiled.fanOutEdges) roots.add(edge.as);

  return [...roots];
}

/**
 * Checks every `agent` prompt's template tokens against the keys the run can
 * actually produce (graph-bro#7). Escaped tokens are skipped — they are text,
 * not tokens (graph-bro#8), which is why the escape grammar has to exist for
 * this check to be safe to make fatal.
 *
 * Takes `inputRootKeys` separately rather than reading them off the topology
 * because a root key can arrive purely via `--input`, which `compile` never
 * sees; the CLI supplies both at `start`.
 *
 * Passing means every root is produced *somewhere* in the run — not that it is
 * in scope at the node reading it. A key written only by a strictly later node,
 * by the reading node itself, or on a branch that never fires all clear this
 * gate and still fail at activation time with `UnresolvedPromptTokenError`
 * (R5). Hence the message's scoped wording — "no node in this topology writes"
 * is the claim the check can actually make (graph-bro#13).
 */
export function checkPromptTokens(
  compiled: CompiledTopology,
  inputRootKeys: string[],
): UnknownPromptTokenRootError[] {
  const known = new Set(collectStateRootKeys(compiled, inputRootKeys));
  const errors: UnknownPromptTokenRootError[] = [];

  for (const node of compiled.nodes) {
    if (node.kind !== "agent") continue;
    for (const path of extractTokenPaths(node.prompt)) {
      const root = path.split(".")[0];
      if (known.has(root)) continue;
      errors.push({
        code: "unknown-prompt-token-root",
        nodeId: node.id,
        path,
        root,
        message: `agent node '${node.id}': prompt token '{{ ${path} }}' reads state key '${root}', which no node in this topology writes and no run input supplies`,
      });
    }
  }

  return errors;
}
