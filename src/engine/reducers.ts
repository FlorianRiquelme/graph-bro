import type { ReducerName } from "../topology/schema.js";
import type { EngineState } from "./state.js";

/**
 * Loud-fail conflict (§13.2.4 `_merge`, ADR-0006): two nodes in the same
 * super-step wrote differing values to a key with no registered reducer.
 */
export class StateConflictError extends Error {
  constructor(
    public readonly key: string,
    public readonly values: unknown[],
  ) {
    super(
      `state conflict at key '${key}': parallel writes disagree (${JSON.stringify(values)}); register a reducer`,
    );
    this.name = "StateConflictError";
  }
}

export type ReducerFn = (current: unknown, next: unknown) => unknown;

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

/** Built-in reducer set, fixed canonically by ADR-0005 / CONTEXT.md. */
export const REDUCERS: Record<ReducerName, ReducerFn> = {
  append: (current, next) => [...toArray(current), ...toArray(next)],
  merge: (current, next) => ({
    ...(current as Record<string, unknown>),
    ...(next as Record<string, unknown>),
  }),
  sum: (current, next) => (current as number) + (next as number),
  dedup: (current, next) => {
    const combined = [...toArray(current), ...toArray(next)];
    const seen = new Set<string>();
    const result: unknown[] = [];
    for (const item of combined) {
      const key = fingerprint(item);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
    return result;
  },
};

export interface Write {
  key: string;
  value: unknown;
}

/**
 * Merges one super-step's writes into `state` (§13.2 `_merge`). A key with a
 * registered reducer folds all pending values (seeded from the existing state
 * value when present); a key with no reducer and disagreeing values raises
 * `StateConflictError` rather than silently picking one (ADR-0006).
 */
export function mergeWrites(
  state: EngineState,
  writes: Write[],
  reducerForKey: (key: string) => ReducerName | undefined,
): EngineState {
  const byKey = new Map<string, unknown[]>();
  for (const { key, value } of writes) {
    const values = byKey.get(key);
    if (values) values.push(value);
    else byKey.set(key, [value]);
  }

  const next: EngineState = { ...state };
  for (const [key, values] of byKey) {
    const reducerName = reducerForKey(key);
    if (reducerName) {
      const reducer = REDUCERS[reducerName];
      let current: unknown;
      let pending: unknown[];
      if (key in state) {
        current = state[key];
        pending = values;
      } else {
        current = values[0];
        pending = values.slice(1);
      }
      for (const value of pending) current = reducer(current, value);
      next[key] = current;
    } else if (values.length > 1 && values.some((v) => fingerprint(v) !== fingerprint(values[0]))) {
      throw new StateConflictError(key, values);
    } else {
      next[key] = values[values.length - 1];
    }
  }
  return next;
}
