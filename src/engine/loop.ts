import { END, START, type FanOutEdge, type PlainEdge, type ReducerName } from "../topology/schema.js";
import { deriveInstanceId, deriveItemKey, type JoinBarrier } from "../topology/compile.js";
import { getPath, snapshotState, type EngineState, type EngineUpdate } from "./state.js";
import { mergeWrites, StateConflictError, type Write } from "./reducers.js";
import { ResettableJoinBarrier } from "./barrier.js";
import { detectStalledJoin, UnreachableJoinError } from "./watchdog.js";

/** A plain function node (R4) — no executor/subprocess concept in this unit. */
export type NodeFn = (state: EngineState) => EngineUpdate | Promise<EngineUpdate>;

/**
 * The subset of a compiled topology the super-step loop needs. Deliberately
 * decoupled from `CompiledTopology`'s `nodes: TopologyNode[]` — U2's nodes
 * are plain functions supplied via `nodeFns`, not the `agent`/`set` grammar
 * (that wiring is the executor's job, U4).
 */
export interface EngineGraph {
  plainEdges: PlainEdge[];
  fanOutEdges: FanOutEdge[];
  joinBarriers: JoinBarrier[];
  maxSteps: number;
}

export interface RunLoopOptions {
  graph: EngineGraph;
  nodeFns: Record<string, NodeFn>;
  initialState?: EngineState;
}

export type LoopStatus = "completed" | "dead_end" | "failed";

export interface LoopResult {
  status: LoopStatus;
  state: EngineState;
  steps: number;
  error?: Error;
}

/** Raised when a run exceeds `max_steps` — a visible failure, never a hang (R8). */
export class MaxStepsExceededError extends Error {
  constructor(public readonly maxSteps: number) {
    super(`run exceeded max_steps (${maxSteps}) without reaching END`);
    this.name = "MaxStepsExceededError";
  }
}

interface Activation {
  nodeId: string;
  instanceId: string;
  binding?: { key: string; value: unknown };
}

/**
 * The super-step loop (§13.2 runner loop / §13.3 channel-driven activation):
 * frontier -> snapshot -> run -> merge (reducers) -> transitions -> next
 * frontier, until END, an empty frontier (`dead_end`), or `max_steps`.
 */
export async function runLoop(options: RunLoopOptions): Promise<LoopResult> {
  const { graph, nodeFns } = options;
  let state: EngineState = options.initialState ? { ...options.initialState } : {};

  const barriers = new Map<string, ResettableJoinBarrier>();
  const barriersBySource = new Map<string, ResettableJoinBarrier[]>();
  const joinBarrierMetaById = new Map<string, JoinBarrier>();
  const reducerForKey = new Map<string, ReducerName>();

  for (const jb of graph.joinBarriers) {
    const barrier = new ResettableJoinBarrier(jb.id, jb.sources, jb.mode);
    barriers.set(jb.id, barrier);
    joinBarrierMetaById.set(jb.id, jb);
    reducerForKey.set(jb.into, jb.reducer);
    for (const source of jb.sources) {
      const list = barriersBySource.get(source) ?? [];
      list.push(barrier);
      barriersBySource.set(source, list);
    }
  }

  function transition(
    completed: Activation[],
    currentState: EngineState,
  ): { next: Activation[]; reachedEnd: boolean } {
    const next: Activation[] = [];
    const seen = new Set<string>();
    let reachedEnd = false;

    const pushUnique = (activation: Activation) => {
      if (seen.has(activation.instanceId)) return;
      seen.add(activation.instanceId);
      next.push(activation);
    };

    for (const { nodeId, instanceId } of completed) {
      for (const edge of graph.plainEdges) {
        if (edge.from !== nodeId) continue;
        if (edge.to === END) {
          reachedEnd = true;
          continue;
        }
        pushUnique({ nodeId: edge.to, instanceId: edge.to });
      }

      for (const edge of graph.fanOutEdges) {
        if (edge.from !== nodeId) continue;
        const list = getPath(currentState, edge.for_each);
        const items = Array.isArray(list) ? list : [];
        const instanceIds: string[] = [];
        items.forEach((item, index) => {
          const itemKey = deriveItemKey(item, index);
          const branchInstanceId = deriveInstanceId(edge.to, itemKey);
          instanceIds.push(branchInstanceId);
          pushUnique({
            nodeId: edge.to,
            instanceId: branchInstanceId,
            binding: { key: edge.as, value: item },
          });
        });
        for (const barrier of barriersBySource.get(edge.to) ?? []) {
          barrier.armSource(edge.to, instanceIds);
        }
      }

      for (const barrier of barriersBySource.get(nodeId) ?? []) {
        barrier.arrive(nodeId, instanceId);
        if (barrier.isComplete()) {
          const meta = joinBarrierMetaById.get(barrier.id)!;
          if (meta.to === END) reachedEnd = true;
          else pushUnique({ nodeId: meta.to, instanceId: meta.to });
          barrier.reset();
        }
      }
    }

    return { next, reachedEnd };
  }

  const seed = transition([{ nodeId: START, instanceId: START }], state);
  if (seed.reachedEnd) return { status: "completed", state, steps: 0 };
  let frontier = seed.next;
  let steps = 0;

  while (frontier.length > 0) {
    steps += 1;
    if (steps > graph.maxSteps) {
      return { status: "failed", state, steps, error: new MaxStepsExceededError(graph.maxSteps) };
    }

    const snapshot = snapshotState(state);
    const updates = await Promise.all(
      frontier.map((activation) => {
        const fn = nodeFns[activation.nodeId];
        if (!fn) {
          throw new Error(`runLoop: no node function registered for node '${activation.nodeId}'`);
        }
        const input = activation.binding
          ? { ...snapshot, [activation.binding.key]: activation.binding.value }
          : snapshot;
        return fn(input);
      }),
    );

    const writes: Write[] = [];
    for (const update of updates) {
      for (const [key, value] of Object.entries(update)) writes.push({ key, value });
    }

    try {
      state = mergeWrites(state, writes, (key) => reducerForKey.get(key));
    } catch (err) {
      if (err instanceof StateConflictError) return { status: "failed", state, steps, error: err };
      throw err;
    }

    const { next, reachedEnd } = transition(frontier, state);
    if (reachedEnd) return { status: "completed", state, steps };

    if (next.length === 0) {
      const stalled = detectStalledJoin(barriers);
      if (stalled) throw new UnreachableJoinError(stalled.joinId, stalled.missingSources);
      return { status: "dead_end", state, steps };
    }

    frontier = next;
  }

  return { status: "dead_end", state, steps };
}
