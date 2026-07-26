import type Database from "better-sqlite3";
import type { Activation, EngineState } from "../engine/state.js";

export type { Activation };

/**
 * Whole-state snapshot per super-step (the coarse resume point, §8.8's
 * "opaque blob per row" pattern): `{state, frontier, barrier, step, history}`
 * — round-trips whatever `EngineState`/`LoopResult` the loop already
 * produces, without the store layer needing to know the barrier's internal
 * shape (kept opaque JSON).
 */
export interface CheckpointSnapshot {
  state: EngineState;
  frontier: Activation[];
  barrier: unknown;
  step: number;
  history?: unknown[];
  /** KTD-5: nodeId -> attempts taken so far, for every node declaring `max_attempts` — continues across `resume` rather than restarting. */
  attempts?: Record<string, number>;
}

interface CheckpointRow {
  snapshot: string;
}

/**
 * Writes a super-step's checkpoint and reconciles pending writes in ONE
 * SQLite transaction (ADR-0008): pending-write rows from steps already
 * folded into an earlier durable checkpoint are pruned; the step being
 * checkpointed keeps its rows so `resume` can still discriminate completed
 * vs. in-flight siblings for the frontier this checkpoint hands off.
 */
export function writeCheckpoint(db: Database.Database, runId: string, snapshot: CheckpointSnapshot): void {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO checkpoints (run_id, step, snapshot) VALUES (?, ?, ?)
       ON CONFLICT(run_id, step) DO UPDATE SET snapshot = excluded.snapshot`,
    ).run(runId, snapshot.step, JSON.stringify(snapshot));

    db.prepare(`DELETE FROM pending_writes WHERE run_id = ? AND step < ?`).run(runId, snapshot.step);
  });
  tx();
}

export function readCheckpoint(db: Database.Database, runId: string, step: number): CheckpointSnapshot | undefined {
  const row = db
    .prepare(`SELECT snapshot FROM checkpoints WHERE run_id = ? AND step = ?`)
    .get(runId, step) as CheckpointRow | undefined;
  return row ? (JSON.parse(row.snapshot) as CheckpointSnapshot) : undefined;
}

/** The latest (highest-step) checkpoint for a run — the resume point. */
export function readLatestCheckpoint(db: Database.Database, runId: string): CheckpointSnapshot | undefined {
  const row = db
    .prepare(`SELECT snapshot FROM checkpoints WHERE run_id = ? ORDER BY step DESC LIMIT 1`)
    .get(runId) as CheckpointRow | undefined;
  return row ? (JSON.parse(row.snapshot) as CheckpointSnapshot) : undefined;
}
