import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "../topology/compile.js";
import { checkPromptTokens } from "../topology/lint.js";
import { openDb } from "../store/db.js";
import { createRun } from "../store/pending-writes.js";
import { spawnDetachedEngine } from "./spawn-engine.js";

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

  const runId = randomUUID();
  const pid = spawnDetachedEngine(["start", runId, topologyPath, JSON.stringify(input)]);
  if (pid === undefined) {
    console.error("graph-bro: failed to launch the engine process");
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  createRun(db, runId, pid, topologyPath);
  db.close();

  console.log(runId);
}
