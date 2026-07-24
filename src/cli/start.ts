import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../topology/compile.js";
import { openDb } from "../store/db.js";
import { createRun } from "../store/pending-writes.js";

const RUNTIME_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "run.js");

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

  let input: unknown = {};
  if (inputArg) {
    const inputPath = resolve(process.cwd(), inputArg);
    input = JSON.parse(readFileSync(inputPath, "utf-8"));
  }

  const runId = randomUUID();
  const child = spawn(process.execPath, [RUNTIME_ENTRY, "start", runId, topologyPath, JSON.stringify(input)], {
    detached: true,
    stdio: "ignore",
  });
  if (child.pid === undefined) {
    console.error("graph-bro: failed to launch the engine process");
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  createRun(db, runId, child.pid, topologyPath);
  db.close();
  child.unref();

  console.log(runId);
}
