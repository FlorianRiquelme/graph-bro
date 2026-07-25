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
import type { Executor, NodeCapability } from "../executor/executor.js";
import { MissingStructuredOutputError, validateOutput, type JsonSchema } from "./output-schema.js";
import { evaluateWhen, type WhenEvaluation } from "./when.js";

/** A plain function node (R4) — no executor/subprocess concept in this unit. */
export type NodeFn = (state: EngineState) => EngineUpdate | Promise<EngineUpdate>;

/** Per-node-run trace metadata (ADR-0009): what the executor reports for one node invocation. */
export interface NodeTraceMeta {
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  durationMs?: number;
  /** The agent node's prompt after template resolution (R6) — what the executor actually ran with. */
  resolvedPrompt?: string;
}

/**
 * Out-of-band channel for a node fn to hand per-invocation trace metadata
 * (cost/tokens/model/duration) to the trace writer (`withTracing`). A `Symbol`
 * key deliberately, so the metadata rides the *specific* returned update object
 * — invocation-safe under fan-out (N concurrent instances of one node fn) — yet
 * stays invisible to `Object.entries` (the state-merge in `runLoop`) and to
 * `JSON.stringify` (the pending-writes persist), which both skip symbol keys.
 */
export const NODE_TRACE_META = Symbol("graph-bro.nodeTraceMeta");

/** Reads the trace metadata a node fn attached via {@link NODE_TRACE_META}, if any. */
export function readNodeTraceMeta(update: EngineUpdate): NodeTraceMeta | undefined {
  return (update as Record<symbol, NodeTraceMeta | undefined>)[NODE_TRACE_META];
}

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
  /** R6: nodeId -> declared `max_attempts`, for the nodes a loop re-enters. Absent entirely means no node in this topology declared a bound. */
  attemptBounds?: Record<string, number>;
  /**
   * KTD-10: nodeId -> capability, for every `agent`-kind node (a `set` node
   * is absent — it never runs a CLI subprocess, so it is never party to the
   * single-track hazard). Drives the frontier assertion in `runLoop`: a
   * frontier holding a `"write"` activation must hold no other agent
   * activation. Optional so a caller that hasn't wired it (or a test
   * exercising unrelated behavior) gets no enforcement rather than a crash —
   * the compile-time guard in `topology/compile.ts` is the courtesy for that
   * gap, not a substitute for wiring this in production.
   */
  agentNodeCapability?: Record<string, "read_only" | "write">;
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
  /** KTD-5: per-node attempt counts to continue from on resume — a resumed run does not restart the count, so it can hit `not_converged` immediately if it already spent its attempts. */
  initialAttempts?: Record<string, number>;
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
  capability: NodeCapability;
  cwd: string;
  timeout: number;
  outputKey: string;
  prompt: string | ((state: EngineState) => string);
  /** KTD-8: when declared, the response is validated against it and the *parsed* value — not raw text — lands at `outputKey` (R2). */
  outputSchema?: JsonSchema;
  /** KTD-3 layer 4: topology-declared domains this node's Bash-tool network egress may reach (R11). Ignored for a read-only node. */
  networkDomains?: string[];
}

export function makeAgentNodeFn(executor: Executor, config: AgentNodeConfig): NodeFn {
  return async (state) => {
    const prompt = typeof config.prompt === "function" ? config.prompt(state) : config.prompt;
    const result = await executor.run(prompt, {
      cwd: config.cwd,
      nodeId: config.nodeId,
      capability: config.capability,
      model: config.model,
      timeout: config.timeout,
      outputSchema: config.outputSchema,
      networkDomains: config.networkDomains,
    });
    if (result.isError) {
      throw new Error(`agent node '${config.nodeId}' failed: ${result.text}`);
    }
    // KTD-8: validation lives here, next to the output_key write, not behind
    // the executor seam — a future backend must not be able to skip it.
    let value: unknown = result.text;
    if (config.outputSchema) {
      if (result.structuredOutput === undefined) {
        throw new MissingStructuredOutputError(config.nodeId);
      }
      validateOutput(config.nodeId, config.outputSchema, result.structuredOutput);
      value = result.structuredOutput;
    }
    const update: EngineUpdate = { [config.outputKey]: value };
    // Attach the executor's cost/token report out-of-band (ADR-0009) so the
    // trace writer records it, without leaking into state or pending writes.
    const meta: NodeTraceMeta = {
      model: config.model,
      costUsd: result.cost,
      inputTokens: result.tokens?.inputTokens,
      outputTokens: result.tokens?.outputTokens,
      cacheCreationTokens: result.tokens?.cacheCreationTokens,
      cacheReadTokens: result.tokens?.cacheReadTokens,
      durationMs: result.durationMs,
      resolvedPrompt: prompt,
    };
    Object.defineProperty(update, NODE_TRACE_META, { value: meta, enumerable: false });
    return update;
  };
}

/** R6/R7: `not_converged` means the run did its work and the reviewer still objects — distinct from `failed`, and from `max_steps` exhaustion (also `failed`). */
export type LoopStatus = "completed" | "dead_end" | "failed" | "not_converged";

export interface LoopResult {
  status: LoopStatus;
  state: EngineState;
  steps: number;
  error?: Error;
  /** KTD-5: nodeId -> attempts taken so far, for every node declaring `max_attempts`. Mirrors `steps`' always-present shape. */
  attempts: Record<string, number>;
}

/** Raised when a run exceeds `max_steps` — a visible failure, never a hang (R8). */
export class MaxStepsExceededError extends Error {
  constructor(public readonly maxSteps: number) {
    super(`run exceeded max_steps (${maxSteps}) without reaching END`);
    this.name = "MaxStepsExceededError";
  }
}

/**
 * KTD-10: the runtime backstop for the single-track guard — the frontier is
 * known exactly here, unlike at compile time, where only shapes provably
 * concurrent from the static graph (one source's unguarded-or-not-mutually-
 * exclusive out-edges) can be caught. This also catches what the compiler
 * structurally cannot: a diamond where a write-capable node and a read-only
 * node converge into the same frontier from independent sources. Left
 * unchecked, the write node's edits land mid-step and the read-only node's
 * *own* cleanliness assertion fails and names itself — the innocent party —
 * so this fires first, naming every agent node sharing the frontier.
 */
export class ConcurrentWriteViolationError extends Error {
  constructor(public readonly nodeIds: string[]) {
    super(
      `single-track violation (KTD-10): '${nodeIds.join("', '")}' would dispatch in the same super-step and at least one is write-capable — two agent processes cannot run concurrently against one worktree`,
    );
    this.name = "ConcurrentWriteViolationError";
  }
}

/**
 * R3/KTD-6: raised when an activation's out-edge set is non-empty, entirely
 * guarded, and no guard evaluated true — the silent-give-up R3 forbids.
 * Returned as a failed `LoopResult`, not thrown (KTD-6): this is a routing
 * outcome the engine reports the same way it reports `dead_end`, not an
 * invariant violation like a stalled join.
 */
export class UnmatchedRouterError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly evaluations: { edge: PlainEdge; evaluation: WhenEvaluation }[],
  ) {
    const detail = evaluations
      .map((g) => `-> '${g.edge.to}' ${JSON.stringify(g.edge.when)} read ${JSON.stringify(g.evaluation.reads)}`)
      .join("; ");
    super(`node '${nodeId}' has only guarded out-edges and none matched (R3): ${detail}`);
    this.name = "UnmatchedRouterError";
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
  // R6/KTD-5: nodeId -> attempts taken. Continues from `initialAttempts` on
  // resume rather than restarting, so a resumed run cannot launder itself
  // past its declared bound.
  const attemptCounts = new Map<string, number>(Object.entries(options.initialAttempts ?? {}));
  const attemptsSnapshot = (): Record<string, number> => Object.fromEntries(attemptCounts);

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

  // Declared before `transition` (which closes over it) rather than beside
  // `maxConcurrency` below: the seed transition call happens before that
  // point, and a `const` read through a closure before its own declaration
  // executes is a TDZ crash, not a stale-`undefined` read.
  const persistence = options.persistence;

  function transition(
    completed: Activation[],
    currentState: EngineState,
    step: number,
  ): { next: Activation[]; reachedEnd: boolean; unmatchedRouterError?: UnmatchedRouterError } {
    const next: Activation[] = [];
    const seen = new Set<string>();
    let reachedEnd = false;

    const pushUnique = (activation: Activation) => {
      if (seen.has(activation.instanceId)) return;
      seen.add(activation.instanceId);
      next.push(activation);
    };

    for (const { nodeId, instanceId } of completed) {
      const plain = plainEdgesBySource.get(nodeId) ?? [];
      const fanOuts = fanOutEdgesBySource.get(nodeId) ?? [];
      const joinTargets = barriersBySource.get(nodeId) ?? [];
      const guardEvaluations: { edge: PlainEdge; evaluation: WhenEvaluation }[] = [];

      for (const edge of plain) {
        let satisfied = true;
        if (edge.when !== undefined) {
          const evaluation = evaluateWhen(edge.when, currentState);
          satisfied = evaluation.result;
          guardEvaluations.push({ edge, evaluation });
          // R24: every routing decision is traced with the rule and the values read,
          // regardless of which way it went.
          if (persistence) {
            appendEvent(persistence.db, {
              runId: persistence.runId,
              node: nodeId,
              step,
              payload: {
                type: "routing_decision",
                to: edge.to,
                rule: edge.when,
                reads: evaluation.reads,
                result: evaluation.result,
              },
            });
          }
        }
        if (!satisfied) continue;
        if (edge.to === END) {
          reachedEnd = true;
          continue;
        }
        pushUnique({ nodeId: edge.to, instanceId: edge.to });
      }

      // KTD-6: the unmatched router is its own engine error, detected per
      // activation on guard evaluation — never in terms of the frontier
      // (aggregate emptiness hides one activation behind another;
      // `pushUnique`'s instanceId dedup makes per-activation *contribution*
      // false-fire on a diamond's second satisfied edge). Two exclusions
      // stay load-bearing: a join source's own arrival is a contribution
      // even when its plain routing produced nothing (`joinTargets.length
      // === 0` below), and an unguarded fan-out edge means the out-edge set
      // is never "entirely guarded" in the first place (fan-out carries no
      // `when` — `fanOuts.length === 0` below).
      const entirelyGuarded = plain.length > 0 && fanOuts.length === 0 && plain.every((edge) => edge.when !== undefined);
      if (entirelyGuarded && joinTargets.length === 0 && !guardEvaluations.some((g) => g.evaluation.result)) {
        return { next, reachedEnd, unmatchedRouterError: new UnmatchedRouterError(nodeId, guardEvaluations) };
      }

      for (const edge of fanOuts) {
        const branches = buildFanOutBranches(edge, currentState);
        for (const branch of branches) pushUnique(branch.activation);
        for (const barrier of barriersBySource.get(edge.to) ?? []) {
          barrier.armSource(
            edge.to,
            branches.map((branch) => branch.instanceId),
          );
        }
      }

      for (const barrier of joinTargets) {
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
    const seed = transition([{ nodeId: START, instanceId: START }], state, 0);
    if (seed.unmatchedRouterError)
      return { status: "failed", state, steps: 0, error: seed.unmatchedRouterError, attempts: attemptsSnapshot() };
    if (seed.reachedEnd) return { status: "completed", state, steps: 0, attempts: attemptsSnapshot() };
    frontier = seed.next;
    steps = 0;
  }

  const maxConcurrency = options.maxConcurrency ?? graph.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

  while (frontier.length > 0) {
    steps += 1;
    if (steps > graph.maxSteps) {
      return { status: "failed", state, steps, error: new MaxStepsExceededError(graph.maxSteps), attempts: attemptsSnapshot() };
    }

    // KTD-10: the single-track frontier assertion, checked on the actual
    // dispatch frontier before anything runs — the real enforcement, with
    // the compile-time guard as its authoring-time courtesy. Fails before
    // spending an attempt or writing a checkpoint for a frontier that must
    // never dispatch.
    if (graph.agentNodeCapability) {
      const agentActivations = frontier.filter((activation) => graph.agentNodeCapability![activation.nodeId] !== undefined);
      const hasWrite = agentActivations.some((activation) => graph.agentNodeCapability![activation.nodeId] === "write");
      if (hasWrite && agentActivations.length > 1) {
        const nodeIds = [...new Set(agentActivations.map((activation) => activation.nodeId))];
        return {
          status: "failed",
          state,
          steps,
          error: new ConcurrentWriteViolationError(nodeIds),
          attempts: attemptsSnapshot(),
        };
      }
    }

    // R6/R7: count this step's activations of any bounded node BEFORE
    // dispatch — independent of the step budget above, per the Product
    // Contract decision (whichever bound the actual run trips fires; this
    // check never overrides a max_steps failure that already returned).
    // Hitting the bound halts the run rather than spending one more attempt:
    // the prior step's checkpoint (the last one written) already reflects
    // "attempts spent, about to try again", so a resume recomputes this same
    // check and can hit not_converged immediately (KTD-5) — deliberately, per
    // its trade-off over laundering a run past its declared bound.
    for (const activation of frontier) {
      const bound = graph.attemptBounds?.[activation.nodeId];
      if (bound === undefined) continue;
      const nextCount = (attemptCounts.get(activation.nodeId) ?? 0) + 1;
      if (nextCount > bound) {
        return { status: "not_converged", state, steps, attempts: attemptsSnapshot() };
      }
    }
    for (const activation of frontier) {
      const bound = graph.attemptBounds?.[activation.nodeId];
      if (bound === undefined) continue;
      attemptCounts.set(activation.nodeId, (attemptCounts.get(activation.nodeId) ?? 0) + 1);
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
        attempts: attemptsSnapshot(),
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
      if (err instanceof StateConflictError) return { status: "failed", state, steps, error: err, attempts: attemptsSnapshot() };
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
      return { status: "failed", state, steps, error, attempts: attemptsSnapshot() };
    }

    const { next, reachedEnd, unmatchedRouterError } = transition(stepFrontier, state, steps);
    if (unmatchedRouterError)
      return { status: "failed", state, steps, error: unmatchedRouterError, attempts: attemptsSnapshot() };
    if (reachedEnd) return { status: "completed", state, steps, attempts: attemptsSnapshot() };

    if (next.length === 0) {
      const stalled = detectStalledJoin(barriers);
      if (stalled) throw new UnreachableJoinError(stalled.joinId, stalled.missingSources);
      return { status: "dead_end", state, steps, attempts: attemptsSnapshot() };
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
  return { status: "dead_end", state, steps, attempts: attemptsSnapshot() };
}
