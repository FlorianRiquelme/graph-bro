# ADR-0003: SQLite as the durable run store, one global DB from inception

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context slice:** Engine Slice 1 — resolves "where durable run state physically lives so consumer repos can reach it" (R9, R11, R12).

## Decision

Durable run state lives in a **single machine-global SQLite database** at `~/.graph-bro/graph-bro.db` (WAL mode), holding every run since graph-bro's inception. The CLI is the agent-legible read surface over it.

## Rationale

Chosen over a per-run filesystem directory + NDJSON trace (which §16 item 7 literally prescribes). The operator's decision: a single global DB gives a stable cross-run history from day one with **no later migration** of accumulated NDJSON logs into a queryable store — the observability track's cost/history features (deferred scope) inherit a populated store rather than a backfill problem.

Two objections that would have favored filesystem are answered:

- **Agent-legibility** (STRATEGY's observability north star: "what happened on the way" answerable from the trace alone by a consumer-repo agent) is preserved by making the **CLI the legibility layer** — `graph-bro tail/result/trace <run_id>` read SQLite and emit structured text/NDJSON to stdout. The agent reads CLI output, never SQL. Legibility is a property of the CLI's output format, not the storage substrate.
- **"Mature ecosystem over zero-dep"** (standing convention) actively favors SQLite (`better-sqlite3`) over a hand-rolled atomic-write-then-rename directory scheme.

## Consequences

- **Schema (slice 1):** `runs`, `checkpoints` (state-snapshot-per-super-step), `pending_writes` (keyed by the deterministic `(run_id, node, step, triggers)` hash — §8.5's single most load-bearing correctness property), `events` (the trace). The `side_effects` ledger (§11.5) is **out** — a read-only driver has no engine-known side effects (plan scope).
- **Crash-safety is transactional:** a super-step's checkpoint write + its pending-writes reconciliation commit in one SQLite transaction, replacing filesystem temp-file→rename.
- **Concurrency:** multiple concurrent runs = multiple detached writer processes against one DB. WAL mode + `busy_timeout` serialize writers (SQLite allows one writer + concurrent readers); adequate at a solo operator's scale (a handful of concurrent runs). Revisit only if concurrency outgrows a single-writer lock.
- **`better-sqlite3` adds a native-module dependency** — accepted under the mature-ecosystem convention.
