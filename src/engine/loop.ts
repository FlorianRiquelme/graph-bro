import type Database from "better-sqlite3";
import { END, START, type FanOutEdge, type PlainEdge, type ReducerName } from "../topology/schema.js";
import { type JoinBarrier } from "../topology/compile.js";
import { snapshotState, type Activation, type EngineState, type EngineUpdate } from "./state.js";
import { mergeWrites, StateConflictError, type Write } from "./reducers.js";
import { ResettableJoinBarrier } from "./barrier.js";
import { detectStalledJoin, UnreachableJoinError } from "./watchdog.js";
import { buildFanOutBranches } from "./fanout.js";
import { DEFAULT_MAX_CONCURRENCY, runBoundedPool, type PoolTask } from "./concurrency.js";
import { commitPendingWrite } from "../store/pending-writes.js";
import { writeCheckpoint } from "../store/checkpoints.js";
import { appendEvent } from "../store/trace.js";
import type { Executor } from "../executor/executor.js";

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
  /** Per-topology override of the bounded pool's width (ADR-0011); defaults to `DEFAULT_MAX_CONCURRENCY`. */
  maxConcurrency?: number;
}

/** Durable wiring (U3): when provided, branches commit pending writes as they drain and the loop checkpoints each step's incoming frontier before dispatch, so a crash mid-drain resumes cleanly. */
export interface RunLoopPersistence {
  db: Database.Database;
  runId: string;
}

/**
 * Resume seam for a join barrier's per-instance state (KTD-12): a barrier is
 * normally armed by re-running its fan-out node's transition, which a
 * resumed run skips (the fan-out already ran pre-crash and its effect is
 * baked into `initialState`). The resume caller primes the barrier directly
 * from the same facts `store/pending-writes.ts`'s `resume()` already
 * reconstructed — the full per-instance id universe and which instances
 * already arrived — so the join still fires only after all N arrive.
 */
export interface InitialBarrierState {
  source: string;
  expectedInstanceIds: string[];
  arrivedInstanceIds: string[];
}

export interface RunLoopOptions {
  graph: EngineGraph;
  nodeFns: Record<string, NodeFn>;
  initialState?: EngineState;
  /** Resume seam: a frontier recomputed by `store/pending-writes.ts`'s `resume()`, skipping the START seed. */
  initialFrontier?: Activation[];
  /** The step number to resume counting from; ignored unless `initialFrontier` is set. */
  initialStep?: number;
  /** Primes join barriers a resumed run's skipped fan-out node would otherwise have armed. */
  initialBarrierState?: InitialBarrierState[];
  /** Overrides `graph.maxConcurrency`/the default K=5 (ADR-0011) for this run. */
  maxConcurrency?: number;
  persistence?: RunLoopPersistence;
}

/**
 * Wraps an `Executor.run` call as a plain `NodeFn` (R4) so an `agent`-kind
 * node dispatches through the exact same bounded pool as a deterministic
 * `set` node — the pool only ever sees `NodeFn`s, never the executor
 * directly (KTD-11's narrow seam). An `isError` result is thrown so it joins
 * the loop's ordinary fail-fast path (ADR-0006).
 */
export interface AgentNodeConfig {
  nodeId: string;
  model: string;
  readOnly: boolean;
  cwd: string;
  timeout: number;
  outputKey: string;
  prompt: string | ((state: EngineState) => string);
}

export function makeAgentNodeFn(executor: Executor, config: AgentNodeConfig): NodeFn {
  return async (state) => {
    const prompt = typeof config.prompt === "function" ? config.prompt(state) : config.prompt;
    const result = await executor.run(prompt, {
      cwd: config.cwd,
      nodeId: config.nodeId,
      readOnly: config.readOnly,
      model: config.model,
      timeout: config.timeout,
    });
    if (result.isError) {
      throw new Error(`agent node '${config.nodeId}' failed: ${result.text}`);
    }
    return { [config.outputKey]: result.text };
  };
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

  // Precomputed once (mirrors barriersBySource above) so `transition` looks up
  // a node's out-edges in O(out-degree) instead of scanning every edge in the
  // graph per activation, per super-step.
  const plainEdgesBySource = new Map<string, PlainEdge[]>();
  for (const edge of graph.plainEdges) {
    const list = plainEdgesBySource.get(edge.from) ?? [];
    list.push(edge);
    plainEdgesBySource.set(edge.from, list);
  }
  const fanOutEdgesBySource = new Map<string, FanOutEdge[]>();
  for (const edge of graph.fanOutEdges) {
    const list = fanOutEdgesBySource.get(edge.from) ?? [];
    list.push(edge);
    fanOutEdgesBySource.set(edge.from, list);
  }

  for (const entry of options.initialBarrierState ?? []) {
    for (const barrier of barriersBySource.get(entry.source) ?? []) {
      barrier.armSource(entry.source, entry.expectedInstanceIds);
      for (const instanceId of entry.arrivedInstanceIds) barrier.arrive(entry.source, instanceId);
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
      for (const edge of plainEdgesBySource.get(nodeId) ?? []) {
        if (edge.to === END) {
          reachedEnd = true;
          continue;
        }
        pushUnique({ nodeId: edge.to, instanceId: edge.to });
      }

      for (const edge of fanOutEdgesBySource.get(nodeId) ?? []) {
        const branches = buildFanOutBranches(edge, currentState);
        for (const branch of branches) pushUnique(branch.activation);
        for (const barrier of barriersBySource.get(edge.to) ?? []) {
          barrier.armSource(
            edge.to,
            branches.map((branch) => branch.instanceId),
          );
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

  let frontier: Activation[];
  let steps: number;
  if (options.initialFrontier) {
    frontier = options.initialFrontier;
    steps = options.initialStep ?? 0;
  } else {
    const seed = transition([{ nodeId: START, instanceId: START }], state);
    if (seed.reachedEnd) return { status: "completed", state, steps: 0 };
    frontier = seed.next;
    steps = 0;
  }

  const maxConcurrency = options.maxConcurrency ?? graph.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const persistence = options.persistence;

  while (frontier.length > 0) {
    steps += 1;
    if (steps > graph.maxSteps) {
      return { status: "failed", state, steps, error: new MaxStepsExceededError(graph.maxSteps) };
    }

    // Checkpoint this step's incoming frontier BEFORE dispatch (ADR-0008):
    // the durable resume point is "this many steps completed, about to run
    // this frontier next" — so a crash mid-drain resumes from here with
    // completed branches skipped via their pending writes (U3's `resume`).
    if (persistence) {
      writeCheckpoint(persistence.db, persistence.runId, {
        state,
        frontier,
        barrier: {},
        step: steps - 1,
      });
    }

    const snapshot = snapshotState(state);
    const stepFrontier = frontier;
    const tasks: PoolTask<{ activation: Activation; update: EngineUpdate }>[] = stepFrontier.map((activation) => ({
      id: activation.instanceId,
      run: async () => {
        const fn = nodeFns[activation.nodeId];
        if (!fn) {
          throw new Error(`runLoop: no node function registered for node '${activation.nodeId}'`);
        }
        const input = activation.binding
          ? { ...snapshot, [activation.binding.key]: activation.binding.value }
          : snapshot;
        const update = await fn(input);
        // Only a fan-out branch instance carries `itemKey` (KTD-12) — a plain
        // node's durability is left to the next step's checkpoint, per U5's scope.
        if (persistence && activation.itemKey !== undefined) {
          commitPendingWrite(persistence.db, {
            runId: persistence.runId,
            node: activation.nodeId,
            step: steps,
            itemKey: activation.itemKey,
            triggers: [],
            writes: update,
          });
        }
        return { activation, update };
      },
    }));

    const poolResult = await runBoundedPool(tasks, maxConcurrency);

    const writes: Write[] = [];
    for (const result of poolResult.results) {
      if (result.status === "fulfilled" && result.value) {
        for (const [key, value] of Object.entries(result.value.update)) writes.push({ key, value });
      }
    }

    try {
      state = mergeWrites(state, writes, (key) => reducerForKey.get(key));
    } catch (err) {
      if (err instanceof StateConflictError) return { status: "failed", state, steps, error: err };
      throw err;
    }

    if (poolResult.failed) {
      // Fail-fast (ADR-0006): no new branches were dispatched once the first
      // failure was seen; in-flight siblings already drained above and their
      // writes are folded into `state` and durable via pending writes. Mark
      // the failed instance(s) so `resume` forces a re-run and the failure
      // is visible in the trace.
      for (const result of poolResult.results) {
        if (result.status !== "rejected") continue;
        const activation = stepFrontier.find((candidate) => candidate.instanceId === result.id);
        if (!activation) continue;
        if (persistence) {
          if (activation.itemKey !== undefined) {
            commitPendingWrite(persistence.db, {
              runId: persistence.runId,
              node: activation.nodeId,
              step: steps,
              itemKey: activation.itemKey,
              triggers: [],
              writes: {},
              isError: true,
            });
          }
          appendEvent(persistence.db, {
            runId: persistence.runId,
            node: activation.nodeId,
            step: steps,
            payload: { error: result.error instanceof Error ? result.error.message : String(result.error) },
          });
        }
      }
      const error =
        poolResult.firstError instanceof Error ? poolResult.firstError : new Error(String(poolResult.firstError));
      return { status: "failed", state, steps, error };
    }

    const { next, reachedEnd } = transition(stepFrontier, state);
    if (reachedEnd) return { status: "completed", state, steps };

    if (next.length === 0) {
      const stalled = detectStalledJoin(barriers);
      if (stalled) throw new UnreachableJoinError(stalled.joinId, stalled.missingSources);
      return { status: "dead_end", state, steps };
    }

    frontier = next;
  }

  // Reached only when the loop starts with an already-empty frontier (e.g. a
  // resumed run whose every pending activation had already completed in an
  // earlier super-step) — the mid-drain path above already ran this same
  // check when `next.length === 0`. Without it here, a join stalled before
  // the crash (one static source arrived, the other never will) would
  // silently report dead_end instead of the diagnosable UnreachableJoinError.
  const stalled = detectStalledJoin(barriers);
  if (stalled) throw new UnreachableJoinError(stalled.joinId, stalled.missingSources);
  return { status: "dead_end", state, steps };
}
