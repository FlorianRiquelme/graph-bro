import { openDb } from "../store/db.js";
import { getRun } from "../store/pending-writes.js";
import { readLatestCheckpoint } from "../store/checkpoints.js";
import { aggregateAttempts, listEvents } from "../store/trace.js";

/**
 * `graph-bro result <run_id>`: the run's status plus its latest checkpointed
 * state as the run's output. R25/R26: additive fields only, so a slice-1
 * read-only run's output shape is unchanged — `error` appears only for a
 * `failed` run (from the trace's own `run_stopped` event, U9), and
 * `attempts` only when the run actually advanced an attempt counter.
 */
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
  const events = run ? listEvents(db, runId) : [];
  db.close();

  if (!run) {
    console.error(`graph-bro: no such run '${runId}'`);
    process.exitCode = 1;
    return;
  }

  const output: Record<string, unknown> = { runId: run.runId, status: run.status, output: checkpoint?.state ?? {} };

  if (run.status === "failed") {
    const stopped = [...events].reverse().find((event) => (event.payload as { type?: string })?.type === "run_stopped");
    const error = (stopped?.payload as { error?: string } | undefined)?.error;
    if (error) output.error = error;
  }

  const attempts = aggregateAttempts(events);
  if (attempts.length > 0) output.attempts = attempts;

  console.log(JSON.stringify(output));
}
