/**
 * The engine's runtime state: a flat, JSON-serializable key-value bag written
 * to by node functions and read via dotted paths (fan-out's `for_each`,
 * R4/R5). No topology-specific shape is assumed here — U3's store layer owns
 * persistence, this module owns only the in-memory model.
 */
export type EngineState = Record<string, unknown>;

/** What a node function returns: the keys it wants to write this super-step. */
export type EngineUpdate = Record<string, unknown>;

/**
 * A single frontier entry — a node instance queued to run next super-step.
 * The canonical shape; `store/checkpoints.ts` imports this rather than
 * redeclaring it, since the frontier it persists is exactly what the loop
 * produces.
 */
export interface Activation {
  nodeId: string;
  instanceId: string;
  binding?: { key: string; value: unknown };
  /** Set only for a fan-out branch instance (KTD-12) — the per-instance discriminator U3's pending-write key requires. */
  itemKey?: string;
}

/**
 * A frozen shallow copy of `state`, taken once per super-step, so every node
 * in the step's frontier reads the same view regardless of what siblings in
 * the same step write (§13.2 runner loop: "nodes never see each other's
 * writes mid-step").
 */
export function snapshotState(state: EngineState): EngineState {
  return Object.freeze({ ...state });
}

/** Resolves a dotted path (e.g. `batch.items`) against `state`. */
export function getPath(state: EngineState, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((acc, segment) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[segment];
  }, state);
}
