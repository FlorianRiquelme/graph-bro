# ADR-0008: Synchronous checkpoint writes at both levels in slice 1

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context slice:** Engine Slice 1 — resolves "checkpoint granularity and write cadence" for R9, AE2.

## Decision

Granularity is §16's settled two levels (unchanged): whole-state snapshot per super-step (coarse resume) + per-task pending writes (fine crash-safety). **Cadence is synchronous at both levels for slice 1**, overriding §16's async *default*:

- **Per-task pending write** committed synchronously the moment a node completes, keyed by the deterministic `(run_id, node, step, triggers)` hash.
- **Coarse whole-state checkpoint** (frontier + barrier state + step) committed synchronously at each super-step boundary.

## Rationale

§16's async default exists to keep *fast, fine-grained* nodes cheap (checkpoint overhead dominates at microsecond nodes). graph-bro's node profile is the opposite: CLI coding-agent subprocesses running seconds-to-minutes and costing real money. A SQLite WAL commit is sub-millisecond — negligible against node cost. So sync buys the *strongest* crash-safety at *effectively zero* cost, and the general-engine async trade is simply wrong for this profile. This is the cadence call §16 explicitly left to planning, not a re-litigation of its architecture.

## Consequences

- **R9/AE2 airtight:** a crash after 12 of 17 readers complete re-runs zero of the 12 — all 12 outputs are already committed at their completion instants, independent of super-step boundaries.
- **Revisit trigger:** async only becomes worth considering if a future node type is fast/fine-grained enough that per-write commit overhead shows up in wall-clock. Not slice 1.
- Pairs with ADR-0003: each super-step's coarse checkpoint + its pending-writes reconciliation is one SQLite transaction.
