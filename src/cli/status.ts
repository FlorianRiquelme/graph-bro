import { openDb } from "../store/db.js";
import { getRun } from "../store/pending-writes.js";

/** `graph-bro status <run_id>`: a short-lived read over the global DB — works from any cwd (KTD-2/ADR-0002). */
export async function statusCommand(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    console.error("usage: graph-bro status <run_id>");
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  const run = getRun(db, runId);
  db.close();

  if (!run) {
    console.error(`graph-bro: no such run '${runId}'`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ runId: run.runId, status: run.status, ownerPid: run.ownerPid, createdAt: run.createdAt }));
}
