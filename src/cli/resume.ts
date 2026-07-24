import { openDb } from "../store/db.js";
import { claimOwnership, getRun, isProcessAlive, updateRunStatus } from "../store/pending-writes.js";
import { spawnDetachedEngine } from "./spawn-engine.js";

/**
 * `graph-bro resume <run_id>` (KTD-14 single-owner guard): refuses with a
 * clear error when the recorded `owner_pid` is still alive; only when the pid
 * is dead does it re-launch a fresh detached engine from the last checkpoint
 * and take ownership (the §13.2 self-heal pattern).
 *
 * Ownership transfer is a compare-and-swap (`claimOwnership`), not a plain
 * write: two `resume` invocations can both read the same dead `owner_pid`
 * and both pass the liveness check before either writes. Claiming with the
 * *this-process's own pid* as an atomic placeholder — before spawning the
 * engine — means only one racing invocation's CAS actually matches a row;
 * the loser detects it lost and aborts without spawning a second engine.
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

  if (!claimOwnership(db, runId, run.ownerPid, process.pid)) {
    db.close();
    console.error(`graph-bro: run '${runId}' is already being resumed by another process; refusing to race it`);
    process.exitCode = 1;
    return;
  }

  const pid = spawnDetachedEngine(["resume", runId, run.topologyPath]);
  if (pid === undefined) {
    // Claimed but failed to spawn: leave ownership at this (now-exiting)
    // process's pid rather than the stale dead one, so a later `resume`
    // still self-heals once this pid is no longer alive.
    updateRunStatus(db, runId, "failed");
    db.close();
    console.error("graph-bro: failed to launch the engine process");
    process.exitCode = 1;
    return;
  }

  claimOwnership(db, runId, process.pid, pid); // hand off from this process's placeholder claim to the real engine pid
  db.close();

  console.log(runId);
}
