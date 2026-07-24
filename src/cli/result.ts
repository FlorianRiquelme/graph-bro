import { openDb } from "../store/db.js";
import { getRun } from "../store/pending-writes.js";
import { readLatestCheckpoint } from "../store/checkpoints.js";

/** `graph-bro result <run_id>`: the run's status plus its latest checkpointed state as the run's output. */
export async function resultCommand(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    console.error("usage: graph-bro result <run_id>");
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  const run = getRun(db, runId);
  const checkpoint = readLatestCheckpoint(db, runId);
  db.close();

  if (!run) {
    console.error(`graph-bro: no such run '${runId}'`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ runId: run.runId, status: run.status, output: checkpoint?.state ?? {} }));
}
