import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../store/db.js";
import { createRun, getRun, isProcessAlive } from "../store/pending-writes.js";

const RUNTIME_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "run.js");

/**
 * `graph-bro resume <run_id>` (KTD-14 single-owner guard): refuses with a
 * clear error when the recorded `owner_pid` is still alive; only when the pid
 * is dead does it re-launch a fresh detached engine from the last checkpoint
 * and take ownership (the §13.2 self-heal pattern).
 */
export async function resumeCommand(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    console.error("usage: graph-bro resume <run_id>");
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  const run = getRun(db, runId);
  if (!run) {
    db.close();
    console.error(`graph-bro: no such run '${runId}'`);
    process.exitCode = 1;
    return;
  }
  if (isProcessAlive(run.ownerPid)) {
    db.close();
    console.error(`graph-bro: run '${runId}' is still owned by live process ${run.ownerPid}; refusing to resume`);
    process.exitCode = 1;
    return;
  }
  if (!run.topologyPath) {
    db.close();
    console.error(`graph-bro: run '${runId}' has no recorded topology path; cannot resume`);
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, [RUNTIME_ENTRY, "resume", runId, run.topologyPath], {
    detached: true,
    stdio: "ignore",
  });
  if (child.pid === undefined) {
    db.close();
    console.error("graph-bro: failed to launch the engine process");
    process.exitCode = 1;
    return;
  }

  createRun(db, runId, child.pid); // self-heal: take ownership; topology_path is preserved (COALESCE)
  db.close();
  child.unref();

  console.log(runId);
}
