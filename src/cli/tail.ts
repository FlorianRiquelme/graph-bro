import { openDb } from "../store/db.js";
import { listEventsSince } from "../store/trace.js";

/**
 * `graph-bro tail <run_id> [--cursor N] [--limit N]` (§13.2 `tail(cursor, limit)`
 * paging): prints new events as NDJSON on stdout (R12 — agent-legible per-node
 * start/end, outputs, failures), one per line, then reports the next cursor on
 * stderr so a caller can page incrementally without re-reading old events.
 */
export async function tailCommand(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    console.error("usage: graph-bro tail <run_id> [--cursor N] [--limit N]");
    process.exitCode = 1;
    return;
  }

  const cursorIndex = args.indexOf("--cursor");
  const cursor = cursorIndex >= 0 ? Number(args[cursorIndex + 1]) : 0;
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 200;

  const db = openDb();
  const events = listEventsSince(db, runId, cursor, limit);
  db.close();

  for (const event of events) console.log(JSON.stringify(event));
  const nextCursor = events.length > 0 ? events[events.length - 1].id : cursor;
  console.error(`# cursor=${nextCursor}`);
}
