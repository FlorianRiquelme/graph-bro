#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { compile, type CompiledTopology } from "../topology/compile.js";
import { checkPromptTokens } from "../topology/lint.js";
import {
  runLoop,
  makeAgentNodeFn,
  readNodeTraceMeta,
  type EngineGraph,
  type LoopStatus,
  type NodeFn,
  type RunLoopOptions,
  type InitialBarrierState,
} from "../engine/loop.js";
import { buildFanOutBranches } from "../engine/fanout.js";
import { renderPromptTemplate } from "../engine/prompt-template.js";
import type { EngineState, EngineUpdate } from "../engine/state.js";
import { openDb } from "../store/db.js";
import { resume as resumeRun, updateRunStatus } from "../store/pending-writes.js";
import { writeCheckpoint } from "../store/checkpoints.js";
import { appendEvent } from "../store/trace.js";
import { ClaudeCodeExecutor } from "../executor/claude-code.js";
import { InMemoryNodeRegistry, type Executor } from "../executor/executor.js";
import { signalProcessGroup } from "../executor/subprocess.js";
import { createWorkspace, finalizeWorkspace, reattachToRunBranch, reuseWorkspace } from "../workspace/lifecycle.js";
import { assertConsumerBaseline, captureConsumerBaseline, type ConsumerBaseline } from "../workspace/baseline.js";
import { commitAttempt, preserveInterruptedAttempt, readHead } from "../workspace/commit.js";
import { checkOsBoundary } from "../executor/write-policy.js";

/** Hard wall-clock timeout per agent node (also the heartbeat hard-kill threshold). */
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
/** Grace period between the SIGTERM and SIGKILL sweep of the kill cascade. */
const KILL_GRACE_MS = 3000;

/** R7: `not_converged` is a distinct exit code — it reads as "did the work, reviewer still objects", never conflated with the generic failure code a crash or `dead_end` maps to. */
export function mapStatusToExitCode(status: LoopStatus): number {
  if (status === "completed") return 0;
  if (status === "not_converged") return 2;
  return 1;
}

/**
 * KTD-13: cascades a SIGTERM/SIGINT sent to this (detached) engine process to
 * every node PGID currently in the registry before this process exits — a
 * plain group-kill of the engine does NOT reach an already-detached node
 * subprocess (it's in its own process group), so without this a killed run
 * orphans a still-billing `claude` subprocess.
 */
function installKillCascade(registry: InMemoryNodeRegistry): void {
  let handling = false;
  const handle = (): void => {
    if (handling) return;
    handling = true;
    for (const entry of registry.list()) signalProcessGroup(entry.pgid, "SIGTERM");
    const timer = setTimeout(() => {
      for (const entry of registry.list()) signalProcessGroup(entry.pgid, "SIGKILL");
      process.exit(1);
    }, KILL_GRACE_MS);
    timer.unref();
  };
  process.on("SIGTERM", handle);
  process.on("SIGINT", handle);
}

/** Shared across every node's trace wrapper — `withAttemptCommit` advances it, `withTracing` stamps it. */
interface AttemptState {
  current: number;
}

/**
 * Wraps a node fn with start/complete/error trace events (R12 legibility) so
 * `graph-bro tail` can page per-node activity. U9/R26: every event is
 * stamped with `attemptState.current` on the shared `step` column, the
 * grouping key `graph-bro result`'s per-attempt aggregation keys off — the
 * same counter `withAttemptCommit` advances, so a node's trace attribution
 * and its work's actual attempt commit always agree. For the bounded node's
 * own activation, its `node_start` reads the value from *before*
 * `withAttemptCommit`'s hook (nested inside this `fn`) advances it, while
 * `node_complete` reads the value *after* — the hook increments-then-commits
 * before invoking the node it wraps, so by the time this function's own
 * `await fn(state)` resolves, the counter already reflects the attempt that
 * node's own commit just closed. A topology with no bounded node never
 * advances this counter at all, so every event stays stamped `0` — the
 * pre-U9 slice-1 shape, since `graph-bro result` treats an all-zero trace as
 * "no attempt aggregation" (below).
 */
function withTracing(db: ReturnType<typeof openDb>, runId: string, nodeId: string, attemptState: AttemptState, fn: NodeFn): NodeFn {
  return async (state) => {
    appendEvent(db, { runId, node: nodeId, step: attemptState.current, payload: { type: "node_start" } });
    try {
      const update = await fn(state);
      // ADR-0009: fold the executor's per-node cost/token/model/duration
      // (carried out-of-band on the update) into the node_complete event.
      const meta = readNodeTraceMeta(update);
      appendEvent(db, {
        runId,
        node: nodeId,
        step: attemptState.current,
        model: meta?.model,
        inputTokens: meta?.inputTokens,
        outputTokens: meta?.outputTokens,
        cacheCreationTokens: meta?.cacheCreationTokens,
        cacheReadTokens: meta?.cacheReadTokens,
        durationMs: meta?.durationMs,
        costUsd: meta?.costUsd,
        payload: { type: "node_complete", update, prompt: meta?.resolvedPrompt },
      });
      return update;
    } catch (err) {
      appendEvent(db, {
        runId,
        node: nodeId,
        step: attemptState.current,
        payload: { type: "node_error", error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  };
}

/** Wraps a node fn with the R12/R16/R17 consumer-checkout backstop (KTD-11): compares against the run-start baseline after every node, naming the offending node on divergence. */
function withConsumerBaseline(consumerRepoPath: string, baseline: ConsumerBaseline, nodeId: string, fn: NodeFn): NodeFn {
  return async (state) => {
    const update = await fn(state);
    assertConsumerBaseline(consumerRepoPath, baseline, nodeId);
    return update;
  };
}

/** Tracks the workspace's HEAD across `commitAttempt` calls — updated by both the before-invocation hook and the terminal-path teardown commit. */
interface WorkspaceHeadState {
  current: string;
}

/**
 * KTD-7: the attempt commit boundary, expressed as a before-invocation hook
 * on the bounded node — "commit whatever the workspace holds, then invoke"
 * is the boundary's own definition. `attemptCounts` mirrors the loop's own
 * per-node counter (KTD-5) exactly: both increment once per activation, in
 * the same order (the loop increments then calls this fn), so the numbers
 * always agree without the runtime reading the loop's internal state —
 * KTD-10 forbids `src/engine` from importing the workspace module, so this
 * lives entirely on the runtime side of that seam.
 */
function withAttemptCommit(
  workspacePath: string,
  nodeId: string,
  attemptCounts: Map<string, number>,
  headState: WorkspaceHeadState,
  attemptState: AttemptState,
  db: ReturnType<typeof openDb>,
  runId: string,
  fn: NodeFn,
): NodeFn {
  return async (state) => {
    const attemptNumber = (attemptCounts.get(nodeId) ?? 0) + 1;
    attemptCounts.set(nodeId, attemptNumber);
    attemptState.current = attemptNumber; // U9: the shared counter withTracing stamps onto every event
    const result = commitAttempt({ workspacePath, priorHead: headState.current, attemptNumber, nodeId });
    headState.current = result.head;
    if (result.quiescenceWarning) {
      appendEvent(db, { runId, node: nodeId, step: attemptNumber, payload: { type: "workspace_not_quiescent", warning: result.quiescenceWarning } });
    }
    return fn(state);
  };
}

/**
 * R21: the boundary hook above only fires on the bounded node's re-entry, so
 * a run that converges, fails, or hits `not_converged` without ever
 * re-activating it would otherwise leave its last attempt uncommitted — and
 * a topology with no bounded node at all never fires the hook in the first
 * place. Called on every terminal path, right before `finalizeWorkspace`;
 * `commitAttempt`'s own no-op check makes this a no-op when the workspace is
 * already clean (a read-only-only run, or a hook that already just fired).
 */
function commitFinalAttempt(
  workspacePath: string,
  attemptCounts: Map<string, number>,
  headState: WorkspaceHeadState,
  db: ReturnType<typeof openDb>,
  runId: string,
): void {
  const attemptNumber = attemptCounts.size > 0 ? Math.max(...attemptCounts.values()) : 1;
  const result = commitAttempt({ workspacePath, priorHead: headState.current, attemptNumber, nodeId: "run-teardown" });
  headState.current = result.head;
  if (result.quiescenceWarning) {
    appendEvent(db, { runId, step: attemptNumber, payload: { type: "workspace_not_quiescent", warning: result.quiescenceWarning } });
  }
}

/**
 * Builds one untraced `NodeFn` per compiled node: `agent` via
 * `makeAgentNodeFn` (against the narrow `Executor` seam — a stub in tests,
 * `ClaudeCodeExecutor` in production), `set` as a deterministic closure
 * (KTD-11's narrow seam). Exported so integration tests build node fns the
 * same way `main()` does, rather than hand-copying this wiring.
 */
export function buildNodeFns(compiled: CompiledTopology, executor: Executor, cwd: string = process.cwd()): Record<string, NodeFn> {
  const nodeFns: Record<string, NodeFn> = {};
  for (const node of compiled.nodes) {
    nodeFns[node.id] =
      node.kind === "agent"
        ? makeAgentNodeFn(executor, {
            nodeId: node.id,
            model: node.model,
            capability: node.read_only ? "read_only" : "write",
            cwd,
            timeout: AGENT_TIMEOUT_MS,
            outputKey: node.output_key,
            prompt: (state) => renderPromptTemplate(node.prompt, state, node.id),
            outputSchema: node.output_schema,
            networkDomains: node.network_domains,
          })
        : (): EngineUpdate => ({ ...node.update });
  }
  return nodeFns;
}

/**
 * Reconstructs join-barrier per-instance arrival state on resume (KTD-12's
 * resume seam): handles the dynamic-fan-out-shaped join — a single declared
 * source fed by exactly one dynamic fan-out edge — by rebuilding the full
 * per-instance id universe from the resumed state's runtime `for_each` list
 * and splitting it into arrived (already in `completedInstanceIds`) vs.
 * not-yet-arrived (which re-arrive naturally as the resumed frontier's
 * remaining branches complete). A join backed by 2+ distinct declared
 * sources is NOT reconstructed here — a genuine limitation left for a later
 * slice; this slice's driving workload only has the single-dynamic-source
 * shape.
 */
export function reconstructBarrierState(
  compiled: CompiledTopology,
  state: EngineState,
  completedInstanceIds: Set<string>,
): InitialBarrierState[] {
  const result: InitialBarrierState[] = [];
  for (const barrier of compiled.joinBarriers) {
    if (barrier.sources.length !== 1) continue;
    const source = barrier.sources[0];
    const fanOutEdge = compiled.fanOutEdges.find((edge) => edge.to === source);
    if (!fanOutEdge) continue; // a static (non-fan-out) single source needs no restoration
    const branches = buildFanOutBranches(fanOutEdge, state);
    const expectedInstanceIds = branches.map((branch) => branch.instanceId);
    const arrivedInstanceIds = expectedInstanceIds.filter((id) => completedInstanceIds.has(id));
    result.push({ source, expectedInstanceIds, arrivedInstanceIds });
  }
  return result;
}

async function main(): Promise<void> {
  const [mode, runId, topologyPath, inputArg, baseRefSha, workspacePath, runBranch] = process.argv.slice(2);
  if ((mode !== "start" && mode !== "resume") || !runId || !topologyPath || !workspacePath) {
    console.error("usage: run.js <start|resume> <run_id> <topology_path> <input_json> <base_ref_sha> <workspace_path> <run_branch>");
    process.exitCode = 1;
    return;
  }

  const db = openDb();

  let compiled: CompiledTopology;
  try {
    const topologyJson = JSON.parse(readFileSync(topologyPath, "utf-8"));
    const compileResult = compile(topologyJson);
    if (!compileResult.ok) {
      throw new Error(compileResult.errors.map((e) => `${e.path}: ${e.message}`).join("; "));
    }
    compiled = compileResult.compiled;
  } catch (err) {
    // The CLI validates the topology synchronously before spawning this process;
    // reaching here means the file changed on disk between then and now.
    appendEvent(db, { runId, payload: { type: "run_error", error: err instanceof Error ? err.message : String(err) } });
    updateRunStatus(db, runId, "failed");
    db.close();
    process.exitCode = 1;
    return;
  }

  // U6/KTD-3: refuse to start a write run where the OS boundary is
  // unavailable rather than running unconfined — checked before a workspace
  // ever gets created. A read-only-only topology needs no sandbox.
  const hasWriteNode = compiled.nodes.some((node) => node.kind === "agent" && !node.read_only);
  if (hasWriteNode) {
    const boundary = checkOsBoundary(process.env.GRAPH_BRO_TEST_PLATFORM as NodeJS.Platform | undefined);
    if (!boundary.available) {
      appendEvent(db, { runId, payload: { type: "run_error", error: boundary.reason } });
      updateRunStatus(db, runId, "failed");
      db.close();
      process.exitCode = 1;
      return;
    }
  }

  // R13/KTD-1: every node in the run executes inside this one isolated
  // worktree — never the consumer's own checkout, which `process.cwd()`
  // would otherwise be (the engine inherits the CLI's cwd on spawn).
  const consumerRepoPath = process.cwd();
  try {
    if (mode === "start") {
      createWorkspace({ consumerRepoPath, baseRefSha, workspacePath, runBranch });
    } else {
      reuseWorkspace(workspacePath);
      // U8/KTD-9: a retained workspace's HEAD is left detached so its branch
      // can be checked out elsewhere while it exists — resume must re-attach
      // before committing anything, or every post-resume attempt commits
      // onto the detached HEAD instead of the run branch. Then preserve
      // whatever a kill left dirty mid-attempt (F3/AE9) and hard-reset to
      // the last actually committed attempt before re-entering.
      reattachToRunBranch(workspacePath, runBranch);
      preserveInterruptedAttempt(workspacePath, runId, baseRefSha);
    }
  } catch (err) {
    appendEvent(db, { runId, payload: { type: "run_error", error: err instanceof Error ? err.message : String(err) } });
    updateRunStatus(db, runId, "failed");
    db.close();
    process.exitCode = 1;
    return;
  }

  // U6/KTD-11: the R12/R16/R17 backstop's baseline, captured once at run
  // start — a fresh `reuseWorkspace` on `resume` re-baselines too, which is
  // correct: only divergence introduced *this process's* nodes should trip it.
  const consumerBaseline = captureConsumerBaseline(consumerRepoPath);

  /**
   * KTD-12: the one place `main()` ever disposes of the workspace — isolated
   * so a disposal failure (the worktree locked, checked out elsewhere, or
   * gone) can only add a `workspace_finalize_error` trace event, never
   * revisit a status this process already wrote. Every path that fails after
   * workspace creation calls this exactly once, matching the terminal path's
   * own disposal below.
   */
  function disposeWorkspace(converged: boolean): void {
    try {
      finalizeWorkspace({ consumerRepoPath, workspacePath, converged });
    } catch (err) {
      appendEvent(db, { runId, payload: { type: "workspace_finalize_error", error: err instanceof Error ? err.message : String(err) } });
    }
  }

  const registry = new InMemoryNodeRegistry();
  installKillCascade(registry);
  // GRAPH_BRO_CLAUDE_BINARY: test-only override so integration tests can point at a
  // scripted fake CLI instead of a real `claude` binary; unset in production.
  const executor = new ClaudeCodeExecutor({
    registry,
    binary: process.env.GRAPH_BRO_CLAUDE_BINARY || undefined,
  });

  // R6: nodeId -> declared max_attempts, for every agent node bounding a loop it's re-entered by.
  const attemptBounds: Record<string, number> = {};
  // R19/KTD-10: nodeId -> capability, for every agent node — the key the
  // loop's single-track frontier assertion reads. Without it that assertion
  // is inert, and the compile-time guard alone cannot see a diamond that
  // converges a write node and a read-only node from independent sources.
  const agentNodeCapability: Record<string, "read_only" | "write"> = {};
  for (const node of compiled.nodes) {
    if (node.kind !== "agent") continue;
    if (node.max_attempts !== undefined) attemptBounds[node.id] = node.max_attempts;
    agentNodeCapability[node.id] = node.read_only ? "read_only" : "write";
  }

  const graph: EngineGraph = {
    plainEdges: compiled.plainEdges,
    fanOutEdges: compiled.fanOutEdges,
    joinBarriers: compiled.joinBarriers,
    maxSteps: compiled.maxSteps,
    maxConcurrency: compiled.maxConcurrency,
    attemptBounds,
    agentNodeCapability,
  };

  // Resolved before node fns are built: U7's attempt-commit hook seeds its
  // own per-node counter from the same continued count KTD-5 restores for
  // the loop, so the two stay numerically identical across a resume.
  const reducerForKey = (key: string) => graph.joinBarriers.find((barrier) => barrier.into === key)?.reducer;
  const resumed = mode === "resume" ? resumeRun(db, runId, { reducerForKey }) : undefined;

  // U7/KTD-7: `headState` tracks the workspace's HEAD across attempt
  // commits — starting at wherever the workspace already is, whether that's
  // the creation commit (`start`) or wherever a crashed prior process left
  // it (`resume`, no special-casing needed since git already reflects it).
  const headState = { current: readHead(workspacePath) };
  const commitAttemptCounts = new Map<string, number>(Object.entries(resumed?.attempts ?? {}));
  // U9: seeded from the same continued counts on resume, so the trace's
  // attempt attribution picks up where a crashed run's left off rather than
  // restarting at 0 and re-using attempt numbers a prior process already spent.
  const attemptState: AttemptState = { current: Math.max(0, ...Object.values(resumed?.attempts ?? {})) };

  const rawNodeFns = buildNodeFns(compiled, executor, workspacePath);
  const nodeFns: Record<string, NodeFn> = {};
  for (const [nodeId, fn] of Object.entries(rawNodeFns)) {
    let wrapped = withConsumerBaseline(consumerRepoPath, consumerBaseline, nodeId, fn);
    if (attemptBounds[nodeId] !== undefined) {
      wrapped = withAttemptCommit(workspacePath, nodeId, commitAttemptCounts, headState, attemptState, db, runId, wrapped);
    }
    nodeFns[nodeId] = withTracing(db, runId, nodeId, attemptState, wrapped);
  }

  let runLoopOptions: RunLoopOptions;
  if (mode === "start") {
    const input = (inputArg ? JSON.parse(inputArg) : {}) as EngineState;
    runLoopOptions = { graph, nodeFns, initialState: input, persistence: { db, runId } };
  } else {
    const initialBarrierState = reconstructBarrierState(compiled, resumed!.state, resumed!.completedInstanceIds);
    runLoopOptions = {
      graph,
      nodeFns,
      initialState: resumed!.state,
      initialFrontier: resumed!.frontier,
      initialStep: resumed!.step,
      initialBarrierState,
      initialAttempts: resumed!.attempts,
      persistence: { db, runId },
    };
  }

  // graph-bro#12: the `start`-time gate binds the topology *as the CLI read it*,
  // and this process re-reads the file itself — so a topology edited in that
  // window would otherwise execute ungated. Re-checking here also gives `resume`
  // its only prompt-token gate, since `resume` respawns straight from the
  // recorded topology path without reading it. Known roots come from the state
  // the run actually boots with (the `--input` snapshot on `start`, the resumed
  // checkpoint on `resume`), which is never narrower than what `start` checked
  // against, so an unedited topology that cleared `start` cannot fail here.
  const tokenErrors = checkPromptTokens(compiled, Object.keys(runLoopOptions.initialState ?? {}));
  if (tokenErrors.length > 0) {
    appendEvent(db, { runId, payload: { type: "run_error", error: tokenErrors.map((error) => error.message).join("; ") } });
    updateRunStatus(db, runId, "failed");
    process.exitCode = 1;
    // R12: the workspace was already created (or reattached-to, on resume)
    // above — nothing in this session ever dispatched a node against it, and
    // `resume`'s own reuse path already preserved/reset any prior interrupted
    // attempt before this gate ran, so there is nothing left in the
    // directory this process can lose. Discarded like a converged run's,
    // rather than retained: this failure is a fixed, re-editable authoring
    // error (KTD-12), not partial in-session work worth inspecting, and a
    // retained-but-pinned worktree would otherwise block the very branch a
    // resume needs to re-approach after the topology is fixed.
    disposeWorkspace(true);
    db.close();
    return;
  }

  try {
    // R11/KTD-12: `status` is decided exactly once, here — by the loop's own
    // `LoopResult` on the ordinary path, or by "failed" on the rare path
    // where `runLoop` itself throws (a genuine bug, not a routed outcome —
    // `dead_end`/`not_converged`/an agent's own failure all come back as a
    // `LoopResult`, never a throw). Nothing below this point is allowed to
    // revisit it.
    let status: LoopStatus;
    try {
      const result = await runLoop(runLoopOptions);
      status = result.status;
      // R25: the three stop reasons (converged, bound hit, failed — dead_end
      // folds into "failed" here since both are unrecoverable) are otherwise
      // only distinguishable by separately reading the `runs` row's `status`
      // column — this puts the same distinction directly in the trace, next
      // to the node events it explains.
      appendEvent(db, {
        runId,
        step: attemptState.current,
        payload: { type: "run_stopped", status: result.status, error: result.status === "failed" ? result.error?.message : undefined },
      });
      // `runLoop` only checkpoints a step's INCOMING frontier before dispatch, so a
      // "completed" run's very last step (the one that reaches END) is never itself
      // checkpointed. Persist that true final state here so `graph-bro result` reads it
      // (only on `completed`: a `failed`/`dead_end` run must keep its real resumable
      // checkpoint — the still-pending frontier from before the failing step — as the
      // latest row, so `resume` doesn't lose it).
      if (result.status === "completed") {
        writeCheckpoint(db, runId, { state: result.state, frontier: [], barrier: {}, step: result.steps });
      }
    } catch (err) {
      appendEvent(db, { runId, payload: { type: "run_error", error: err instanceof Error ? err.message : String(err) } });
      status = "failed";
    }

    // R21/U7: every terminal path commits whatever attempt is left, even one
    // that never re-activated the bounded node — a no-op via commitAttempt's
    // own check if the boundary hook already committed it. Isolated (KTD-12):
    // a failure here (e.g. the workspace can't sign) traces a `run_error`
    // rather than pre-empting the status write below, and is never retried —
    // the historical bug re-ran this same call from a second, now-removed
    // catch branch, and a second throw there left the run's status unwritten
    // forever.
    try {
      commitFinalAttempt(workspacePath, commitAttemptCounts, headState, db, runId);
    } catch (err) {
      appendEvent(db, { runId, payload: { type: "run_error", error: err instanceof Error ? err.message : String(err) } });
    }

    // R11: the status write is unconditional from here — decided above by
    // the loop's own result, and observable (to the CLI's `status`/`result`,
    // or to a resuming process) only after the attempt commit above has
    // actually landed.
    updateRunStatus(db, runId, status);
    process.exitCode = mapStatusToExitCode(status);

    // KTD-9: a converged run needs no directory (the branch is the
    // handback); a halted run (failed/dead_end/not_converged) keeps its
    // workspace for `resume` and for inspection. Isolated the same way as
    // the commit above: a disposal failure (the worktree locked, or checked
    // out elsewhere) only adds a `workspace_finalize_error` trace event —
    // never downgrades the status this process just wrote.
    disposeWorkspace(status === "completed");
  } finally {
    db.close();
  }
}

// Only run as the CLI entrypoint (spawned directly), never when imported as a
// module (integration tests import `buildNodeFns`/`reconstructBarrierState`
// above without wanting `main()`'s process.argv-driven side effects to fire).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
