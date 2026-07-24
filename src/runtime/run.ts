#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { compile, type CompiledTopology } from "../topology/compile.js";
import {
  runLoop,
  makeAgentNodeFn,
  type EngineGraph,
  type NodeFn,
  type RunLoopOptions,
  type InitialBarrierState,
} from "../engine/loop.js";
import { buildFanOutBranches } from "../engine/fanout.js";
import type { EngineState, EngineUpdate } from "../engine/state.js";
import { openDb } from "../store/db.js";
import { resume as resumeRun, updateRunStatus } from "../store/pending-writes.js";
import { writeCheckpoint } from "../store/checkpoints.js";
import { appendEvent } from "../store/trace.js";
import { ClaudeCodeExecutor } from "../executor/claude-code.js";
import { InMemoryNodeRegistry } from "../executor/executor.js";
import { signalProcessGroup } from "../executor/subprocess.js";

/** Hard wall-clock timeout per agent node (also the heartbeat hard-kill threshold). */
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
/** Grace period between the SIGTERM and SIGKILL sweep of the kill cascade. */
const KILL_GRACE_MS = 3000;

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

/** Wraps a node fn with start/complete/error trace events (R12 legibility) so `graph-bro tail` can page per-node activity. */
function withTracing(db: ReturnType<typeof openDb>, runId: string, nodeId: string, fn: NodeFn): NodeFn {
  return async (state) => {
    appendEvent(db, { runId, node: nodeId, payload: { type: "node_start" } });
    try {
      const update = await fn(state);
      appendEvent(db, { runId, node: nodeId, payload: { type: "node_complete", update } });
      return update;
    } catch (err) {
      appendEvent(db, {
        runId,
        node: nodeId,
        payload: { type: "node_error", error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  };
}

/** Builds one `NodeFn` per compiled node: `agent` via `makeAgentNodeFn`, `set` as a deterministic closure (KTD-11's narrow seam). */
function buildNodeFns(
  compiled: CompiledTopology,
  executor: ClaudeCodeExecutor,
  db: ReturnType<typeof openDb>,
  runId: string,
): Record<string, NodeFn> {
  const nodeFns: Record<string, NodeFn> = {};
  for (const node of compiled.nodes) {
    const raw: NodeFn =
      node.kind === "agent"
        ? makeAgentNodeFn(executor, {
            nodeId: node.id,
            model: node.model,
            readOnly: node.read_only,
            cwd: process.cwd(),
            timeout: AGENT_TIMEOUT_MS,
            outputKey: node.output_key,
            prompt: node.prompt,
          })
        : (): EngineUpdate => ({ ...node.update });
    nodeFns[node.id] = withTracing(db, runId, node.id, raw);
  }
  return nodeFns;
}

/**
 * Reconstructs join-barrier per-instance arrival state on resume (KTD-12's
 * resume seam): handles the mining-shaped join — a single declared source fed
 * by exactly one dynamic fan-out edge — by rebuilding the full per-instance id
 * universe from the resumed state's runtime `for_each` list and splitting it
 * into arrived (already in `completedInstanceIds`) vs. not-yet-arrived (which
 * re-arrive naturally as the resumed frontier's remaining branches complete).
 * A join backed by 2+ distinct declared sources is NOT reconstructed here —
 * a genuine limitation left for a later slice; the mining driver only has the
 * single-dynamic-source shape.
 */
function reconstructBarrierState(
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
  const [mode, runId, topologyPath, inputArg] = process.argv.slice(2);
  if ((mode !== "start" && mode !== "resume") || !runId || !topologyPath) {
    console.error("usage: run.js <start|resume> <run_id> <topology_path> [input_json]");
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  const registry = new InMemoryNodeRegistry();
  installKillCascade(registry);
  // GRAPH_BRO_CLAUDE_BINARY: test-only override so integration tests can point at a
  // scripted fake CLI instead of a real `claude` binary; unset in production.
  const executor = new ClaudeCodeExecutor({
    registry,
    binary: process.env.GRAPH_BRO_CLAUDE_BINARY || undefined,
  });

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

  const graph: EngineGraph = {
    plainEdges: compiled.plainEdges,
    fanOutEdges: compiled.fanOutEdges,
    joinBarriers: compiled.joinBarriers,
    maxSteps: compiled.maxSteps,
    maxConcurrency: compiled.maxConcurrency,
  };
  const nodeFns = buildNodeFns(compiled, executor, db, runId);

  let runLoopOptions: RunLoopOptions;
  if (mode === "start") {
    const input = (inputArg ? JSON.parse(inputArg) : {}) as EngineState;
    runLoopOptions = { graph, nodeFns, initialState: input, persistence: { db, runId } };
  } else {
    const reducerForKey = (key: string) => graph.joinBarriers.find((barrier) => barrier.into === key)?.reducer;
    const resumed = resumeRun(db, runId, { reducerForKey });
    const initialBarrierState = reconstructBarrierState(compiled, resumed.state, resumed.completedInstanceIds);
    runLoopOptions = {
      graph,
      nodeFns,
      initialState: resumed.state,
      initialFrontier: resumed.frontier,
      initialStep: resumed.step,
      initialBarrierState,
      persistence: { db, runId },
    };
  }

  try {
    const result = await runLoop(runLoopOptions);
    // `runLoop` only checkpoints a step's INCOMING frontier before dispatch, so a
    // "completed" run's very last step (the one that reaches END) is never itself
    // checkpointed. Persist that true final state here so `graph-bro result` reads it
    // (only on `completed`: a `failed`/`dead_end` run must keep its real resumable
    // checkpoint — the still-pending frontier from before the failing step — as the
    // latest row, so `resume` doesn't lose it).
    if (result.status === "completed") {
      writeCheckpoint(db, runId, { state: result.state, frontier: [], barrier: {}, step: result.steps });
    }
    updateRunStatus(db, runId, result.status);
    process.exitCode = result.status === "completed" ? 0 : 1;
  } catch (err) {
    appendEvent(db, { runId, payload: { type: "run_error", error: err instanceof Error ? err.message : String(err) } });
    updateRunStatus(db, runId, "failed");
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
