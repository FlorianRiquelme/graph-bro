import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "../topology/compile.js";
import { checkPromptTokens } from "../topology/lint.js";
import { openDb } from "../store/db.js";
import { createRun } from "../store/pending-writes.js";
import { spawnDetachedEngine } from "./spawn-engine.js";
import { resolveBaseRef, runBranchForRun, workspacePathForRun } from "../workspace/lifecycle.js";

/**
 * `graph-bro start <topology-path> [--input <path>]` (ADR-0004/ADR-0002):
 * validates the topology synchronously — a malformed topology fails loudly
 * with NO run id printed (AE5) — then spawns the detached engine
 * (`runtime/run.js`) in its own process group, prints the run id, and exits.
 */
export async function startCommand(args: string[]): Promise<void> {
  const topologyArg = args[0];
  if (!topologyArg || topologyArg.startsWith("--")) {
    console.error("usage: graph-bro start <topology-path> [--input <path>]");
    process.exitCode = 1;
    return;
  }
  const inputFlagIndex = args.indexOf("--input");
  const inputArg = inputFlagIndex >= 0 ? args[inputFlagIndex + 1] : undefined;

  const topologyPath = resolve(process.cwd(), topologyArg);
  let topologyJson: unknown;
  try {
    topologyJson = JSON.parse(readFileSync(topologyPath, "utf-8"));
  } catch (err) {
    console.error(`graph-bro: could not read topology '${topologyArg}': ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const compileResult = compile(topologyJson);
  if (!compileResult.ok) {
    console.error(`graph-bro: '${topologyArg}' is not a valid topology:`);
    for (const error of compileResult.errors) console.error(`  ${error.path}: ${error.message}`);
    process.exitCode = 1;
    return; // AE5: no run id printed on a malformed topology
  }

  for (const warning of compileResult.warnings) {
    console.error(`graph-bro: warning: ${warning.message}`);
  }

  let input: unknown = {};
  if (inputArg) {
    const inputPath = resolve(process.cwd(), inputArg);
    input = JSON.parse(readFileSync(inputPath, "utf-8"));
  }

  // graph-bro#7: a typo'd prompt-token root key would otherwise surface only
  // when the branch runs. Checked here rather than inside `compile` because a
  // root key can arrive purely via `--input`, which `compile` never sees.
  const inputRootKeys =
    input !== null && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
  const tokenErrors = checkPromptTokens(compileResult.compiled, inputRootKeys);
  if (tokenErrors.length > 0) {
    console.error(`graph-bro: '${topologyArg}' has unresolvable prompt tokens:`);
    for (const error of tokenErrors) console.error(`  ${error.message}`);
    process.exitCode = 1;
    return; // AE5 parity: no run id printed, nothing spawned
  }

  // R14: resolved before a run id is minted — a bad ref or a non-git
  // consumer directory is an authoring error, matching AE5's posture for
  // every other start-time gate. Resolved to a commit SHA, not the symbolic
  // ref: a moving branch tip between here and engine boot is the same class
  // of window graph-bro#12 already cost this project.
  const consumerRepoPath = process.cwd();
  let baseRefSha: string;
  try {
    baseRefSha = resolveBaseRef(consumerRepoPath, compileResult.compiled.baseRef);
  } catch (err) {
    console.error(`graph-bro: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  console.error(`graph-bro: base ref resolved to ${baseRefSha}`);

  const runId = randomUUID();
  // Pure functions of the run id — computed here and delivered on the
  // engine's argv, the way the topology path and input snapshot already are,
  // rather than having the child re-derive or read them back off the run
  // row: no row exists yet at the instant the child boots (spawn precedes
  // createRun below), so a read-back would be an intermittent failure keyed
  // on Node startup timing.
  const workspacePath = workspacePathForRun(runId);
  const runBranch = runBranchForRun(runId);

  const pid = spawnDetachedEngine([
    "start",
    runId,
    topologyPath,
    JSON.stringify(input),
    baseRefSha,
    workspacePath,
    runBranch,
  ]);
  if (pid === undefined) {
    console.error("graph-bro: failed to launch the engine process");
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  createRun(db, runId, pid, topologyPath, { baseRef: baseRefSha, workspacePath, runBranch });
  db.close();

  console.log(runId);
}
