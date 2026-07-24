# ADR-0009: Capture per-node cost data from inception; defer only reporting

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context slice:** Engine Slice 1 — resolves what R12's "enough per-node data to compute cost later" requires slice 1 to record.

## Decision

Every CLI-agent node execution records into the `events`/trace schema: **model id, raw input/output/cache token counts, duration, and Claude Code's self-reported `cost_usd`** — both the raw tokens *and* the reported cost. Cost *aggregation and baseline-comparison reporting* stay deferred (STRATEGY observability track); only capture ships now.

## Rationale

Cost data is capture-now-or-lose-forever: a run's cost can't be reconstructed after the fact without the tokens recorded at run time. So reporting can defer but capture cannot, if the deferred feature is to cover slice-1 runs — and ADR-0003's whole point is a global history from inception with no backfill. Capture is nearly free: §13.4 already parses Claude Code's JSON result envelope, which carries `usage` (input/output/cache tokens), `total_cost_usd`, and `duration_ms` — so this is "keep the fields we already parse."

Raw tokens **and** reported cost are both stored: **tokens are the durable truth** (cost is recomputable from them if pricing assumptions change), the **reported `cost_usd` is a convenience** for immediate reads without a pricing table (operator's call).

## Consequences

- The SQLite `events` schema carries cost columns from the first migration — the deferred cost-baseline feature reaches back over all history.
- Recomputation is possible later against updated per-model pricing without having lost information.
- No aggregation/reporting surface is built in slice 1 (out of scope); the data simply accumulates.
