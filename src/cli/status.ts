import { openDb } from "../store/db.js";
import { getRun } from "../store/pending-writes.js";
import { listEvents } from "../store/trace.js";

/**
 * `graph-bro status <run_id>`: a short-lived read over the global DB — works
 * from any cwd (KTD-2/ADR-0002). R25: additive only — `error` appears only
 * for a `failed` run, so every other status's output shape is unchanged.
 */
export async function statusCommand(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    console.error("usage: graph-bro status <run_id>");
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  const run = getRun(db, runId);
  const events = run?.status === "failed" ? listEvents(db, runId) : [];
  db.close();

  if (!run) {
    console.error(`graph-bro: no such run '${runId}'`);
    process.exitCode = 1;
    return;
  }

  const output: Record<string, unknown> = { runId: run.runId, status: run.status, ownerPid: run.ownerPid, createdAt: run.createdAt };
  if (run.status === "failed") {
    const stopped = [...events].reverse().find((event) => (event.payload as { type?: string })?.type === "run_stopped");
    const error = (stopped?.payload as { error?: string } | undefined)?.error;
    if (error) output.error = error;
  }

  console.log(JSON.stringify(output));
}
