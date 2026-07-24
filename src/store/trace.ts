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
