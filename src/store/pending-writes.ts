import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { deriveInstanceId } from "../topology/compile.js";
import { mergeWrites, type Write } from "../engine/reducers.js";
import type { EngineState } from "../engine/state.js";
import type { ReducerName } from "../topology/schema.js";
import { readLatestCheckpoint, type Activation } from "./checkpoints.js";

/**
 * The deterministic coordinates of one task's pending write (§8.5's per-task
 * write, keyed per KTD-12 by the fan-out per-instance `itemKey` so N sibling
 * branches of one node id at one step don't collapse to one row).
 */
export interface PendingWriteKeyParts {
  runId: string;
  node: string;
  step: number;
  itemKey: string;
  triggers: string[];
}

/**
 * Deterministic hash of `(run_id, node, step, item_key, triggers)`. ERROR
 * control-signal writes pass `isError: true`, which folds a distinct marker
 * into the hash input — a separate key space from regular writes at the same
 * coordinates, so an ERROR write never collides with (and is never mistaken
 * for) the regular write it stands in for.
 */
export function pendingWriteKey(parts: PendingWriteKeyParts, isError = false): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      runId: parts.runId,
      node: parts.node,
      step: parts.step,
      itemKey: parts.itemKey,
      triggers: parts.triggers,
      kind: isError ? "error" : "write",
    }),
  );
  return hash.digest("hex");
}

export interface CommitPendingWriteInput extends PendingWriteKeyParts {
  writes: Record<string, unknown>;
  isError?: boolean;
}

export interface CommitPendingWriteResult {
  key: string;
  /** `false` when `INSERT OR IGNORE` hit an already-committed row (idempotent re-delivery). */
  inserted: boolean;
}

/**
 * Commits a task's pending write the instant it completes (sync, ADR-0008).
 * `INSERT OR IGNORE` on the deterministic key: first write per key wins,
 * making re-delivery of the same task's write idempotent.
 */
export function commitPendingWrite(db: Database.Database, input: CommitPendingWriteInput): CommitPendingWriteResult {
  const isError = input.isError ?? false;
  const key = pendingWriteKey(input, isError);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO pending_writes (write_key, run_id, node, step, item_key, triggers, is_error, writes)
       VALUES (@key, @runId, @node, @step, @itemKey, @triggers, @isError, @writes)`,
    )
    .run({
      key,
      runId: input.runId,
      node: input.node,
      step: input.step,
      itemKey: input.itemKey,
      triggers: JSON.stringify(input.triggers),
      isError: isError ? 1 : 0,
      writes: JSON.stringify(input.writes),
    });
  return { key, inserted: result.changes === 1 };
}

export interface PendingWriteRow {
  writeKey: string;
  runId: string;
  node: string;
  step: number;
  itemKey: string;
  triggers: string[];
  isError: boolean;
  writes: Record<string, unknown>;
}

interface RawPendingWriteRow {
  write_key: string;
  run_id: string;
  node: string;
  step: number;
  item_key: string;
  triggers: string;
  is_error: number;
  writes: string;
}

function toPendingWriteRow(row: RawPendingWriteRow): PendingWriteRow {
  return {
    writeKey: row.write_key,
    runId: row.run_id,
    node: row.node,
    step: row.step,
    itemKey: row.item_key,
    triggers: JSON.parse(row.triggers) as string[],
    isError: row.is_error === 1,
    writes: JSON.parse(row.writes) as Record<string, unknown>,
  };
}

export function listPendingWrites(db: Database.Database, runId: string, opts: { step?: number } = {}): PendingWriteRow[] {
  const rows =
    opts.step !== undefined
      ? db
          .prepare(`SELECT * FROM pending_writes WHERE run_id = ? AND step = ? ORDER BY rowid`)
          .all(runId, opts.step)
      : db.prepare(`SELECT * FROM pending_writes WHERE run_id = ? ORDER BY step, rowid`).all(runId);
  return (rows as RawPendingWriteRow[]).map(toPendingWriteRow);
}

/** Registers/updates the run's owner pid (KTD-14 single-owner guard). */
export function createRun(db: Database.Database, runId: string, ownerPid: number): void {
  db.prepare(
    `INSERT INTO runs (run_id, owner_pid) VALUES (?, ?)
     ON CONFLICT(run_id) DO UPDATE SET owner_pid = excluded.owner_pid`,
  ).run(runId, ownerPid);
}

export function getRunOwnerPid(db: Database.Database, runId: string): number | undefined {
  const row = db.prepare(`SELECT owner_pid FROM runs WHERE run_id = ?`).get(runId) as
    | { owner_pid: number }
    | undefined;
  return row?.owner_pid;
}

/** Liveness check (signal 0) for `owner_pid` — the guard `resume`/`start` consume (KTD-14). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but we lack permission to signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ResumeOptions {
  /** Reducer resolution for replayed writes, mirroring the topology's join config (KTD-11 seam). */
  reducerForKey?: (key: string) => ReducerName | undefined;
}

export interface ResumeResult {
  step: number;
  state: EngineState;
  frontier: Activation[];
  completedInstanceIds: Set<string>;
}

/**
 * Loads the last checkpoint, replays its non-ERROR pending writes onto their
 * succeeded tasks, and recomputes the frontier so completed instances are
 * skipped (§8.5 `_reapply_writes_to_succeeded_nodes`; R9/AE2). ERROR
 * control-signal writes are excluded from the replay — a failed task's
 * activation survives in the frontier and is forced to re-run.
 */
export function resume(db: Database.Database, runId: string, options: ResumeOptions = {}): ResumeResult {
  const checkpoint = readLatestCheckpoint(db, runId);
  if (!checkpoint) {
    return { step: 0, state: {}, frontier: [], completedInstanceIds: new Set() };
  }

  const inFlightStep = checkpoint.step + 1;
  const rows = listPendingWrites(db, runId, { step: inFlightStep }).filter((row) => !row.isError);
  const completedInstanceIds = new Set(rows.map((row) => deriveInstanceId(row.node, row.itemKey)));

  const writes: Write[] = rows.flatMap((row) => Object.entries(row.writes).map(([key, value]) => ({ key, value })));
  const state = mergeWrites(checkpoint.state, writes, options.reducerForKey ?? (() => undefined));

  const frontier = checkpoint.frontier.filter((activation) => !completedInstanceIds.has(activation.instanceId));

  return { step: checkpoint.step, state, frontier, completedInstanceIds };
}
