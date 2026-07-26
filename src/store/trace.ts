import { z } from "zod";
import type Database from "better-sqlite3";

/**
 * The run-trace schema (ADR-0009: model/token/cost/duration captured from
 * inception; KTD-1: "topology grammar, trace schema, and the CLI-agent JSON
 * envelope are all zod-defined"). `payload` stays `z.unknown()` — it carries
 * heterogeneous shapes (`node_start`/`node_complete`/`node_error`/
 * `run_error`/`envelope_parse_error`, each with different fields) with no
 * single closed union across the codebase yet; the schema still validates
 * every other field's shape and gives write/read a formal, checked contract.
 */
export const EventInputSchema = z.object({
  runId: z.string().min(1),
  node: z.string().optional(),
  step: z.number().int().optional(),
  model: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  durationMs: z.number().optional(),
  costUsd: z.number().optional(),
  payload: z.unknown().optional(),
});

export type EventInput = z.infer<typeof EventInputSchema>;

export const EventRowSchema = EventInputSchema.extend({
  id: z.number().int(),
  createdAt: z.string(),
});

export type EventRow = z.infer<typeof EventRowSchema>;

interface RawEventRow {
  id: number;
  run_id: string;
  node: string | null;
  step: number | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  payload: string | null;
  created_at: string;
}

function toEventRow(row: RawEventRow): EventRow {
  return EventRowSchema.parse({
    id: row.id,
    runId: row.run_id,
    node: row.node ?? undefined,
    step: row.step ?? undefined,
    model: row.model ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    cacheCreationTokens: row.cache_creation_tokens ?? undefined,
    cacheReadTokens: row.cache_read_tokens ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    payload: row.payload !== null ? JSON.parse(row.payload) : undefined,
    createdAt: row.created_at,
  });
}

/** Appends one trace event; returns its row id. */
export function appendEvent(db: Database.Database, rawInput: EventInput): number {
  const input = EventInputSchema.parse(rawInput);
  const result = db
    .prepare(
      `INSERT INTO events (
         run_id, node, step, model, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, duration_ms, cost_usd, payload
       ) VALUES (@runId, @node, @step, @model, @inputTokens, @outputTokens,
         @cacheCreationTokens, @cacheReadTokens, @durationMs, @costUsd, @payload)`,
    )
    .run({
      runId: input.runId,
      node: input.node ?? null,
      step: input.step ?? null,
      model: input.model ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cacheCreationTokens: input.cacheCreationTokens ?? null,
      cacheReadTokens: input.cacheReadTokens ?? null,
      durationMs: input.durationMs ?? null,
      costUsd: input.costUsd ?? null,
      payload: input.payload !== undefined ? JSON.stringify(input.payload) : null,
    });
  return Number(result.lastInsertRowid);
}

/** Lists a run's events in insertion order (the trace). */
export function listEvents(db: Database.Database, runId: string): EventRow[] {
  const rows = db.prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY id`).all(runId) as RawEventRow[];
  return rows.map(toEventRow);
}

/** Cursor-based paging (`graph-bro tail`, §13.2 `tail(cursor, limit)`): events with `id > cursor`, oldest first. */
export function listEventsSince(db: Database.Database, runId: string, cursor: number, limit = 200): EventRow[] {
  const rows = db
    .prepare(`SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?`)
    .all(runId, cursor, limit) as RawEventRow[];
  return rows.map(toEventRow);
}

/** One attempt's usage, summed across every node that ran as part of it. */
export interface AttemptSummary {
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/**
 * R26: per-attempt token usage with reported USD alongside, grouped by the
 * `step` column `withTracing` stamps with the runtime's attempt counter
 * (U9) — the same counter `commitAttempt`'s message and the trace share.
 * Only `node_complete` events carry cost/token figures. A topology with no
 * bounded node never advances that counter, so every event stays stamped
 * `0` — returned as an empty array (not a single "attempt 0" bucket), so a
 * slice-1-shaped read-only run's `graph-bro result` output is unchanged
 * (U9's "no attempt aggregation" case, not a spurious one-attempt summary).
 *
 * U12/R20 residual skew: the runtime's shared counter (`src/runtime/run.ts`)
 * is seeded to 1 rather than 0 whenever the topology declares a bound, so no
 * invocation's cost is ever discarded here — but the counter only advances
 * when the bounded node is *invoked*, not when its next activation is
 * scheduled. A write node that runs after the bounded node closes an attempt
 * (but before the bounded node's own next run) is still attributed to the
 * attempt that just closed, one step later than the work it did. Exact
 * alignment would mean advancing the counter at scheduling time instead —
 * a larger change than the dropped bucket warranted; every invocation's
 * cost is accounted for, just not always in the attempt a human would draw
 * the boundary at.
 */
export function aggregateAttempts(events: EventRow[]): AttemptSummary[] {
  const byAttempt = new Map<number, AttemptSummary>();
  for (const event of events) {
    if ((event.payload as { type?: string } | undefined)?.type !== "node_complete") continue;
    if (event.step === undefined || event.step === 0) continue;
    const existing = byAttempt.get(event.step) ?? {
      attempt: event.step,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    };
    existing.inputTokens += event.inputTokens ?? 0;
    existing.outputTokens += event.outputTokens ?? 0;
    existing.cacheCreationTokens += event.cacheCreationTokens ?? 0;
    existing.cacheReadTokens += event.cacheReadTokens ?? 0;
    existing.costUsd += event.costUsd ?? 0;
    byAttempt.set(event.step, existing);
  }
  return [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt);
}
