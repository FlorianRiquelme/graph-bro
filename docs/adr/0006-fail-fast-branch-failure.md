# ADR-0006: Fail-fast is the sole branch-failure policy in slice 1

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context slice:** Engine Slice 1 — resolves "the branch-failure default: fail-fast versus collect-errors" for R10, F3, AE3.

## Decision

A failed fan-out branch **halts the run** (fail-fast per super-step, §14.8). Completed siblings' work is preserved as durable per-task pending writes, the failure surfaces in status and trace, and recovery is via `resume` (R9), which retries only the failed branch. **Collect-errors is deferred.**

## Rationale

Fail-fast alone satisfies every slice-1 acceptance example: AE3 explicitly allows "when the run ends *or halts*", and R10's no-silent-loss is met *because* per-task pending writes are durable (§8.5) — a succeeded sibling is neither discarded nor re-run on resume.

Nothing forces collect-errors into slice 1: the only thing that would is the engine's own acceptance depending on a mining run completing despite a persistently-bad batch — but "Engine acceptance excludes mining recall" is a settled Key Decision (recall is sensei#30's metric). Collect-errors also pairs naturally with already-deferred work — `on_error` routing (§16 item 9) and future heterogeneous-join voting/adversarial patterns.

Operator's call, eyes open on the one consequence below.

## Consequences

- **A sensei mining run that hits a *persistently* failing batch halts rather than delivering N−1 batches.** Acceptable for proving the engine (its bar excludes recall); if sensei's real runs later need to shrug off a bad batch and still deliver, that's the trigger to add collect-errors — "if this causes persistent errors we can look into fixing it" (operator).
- Recovery path is `resume`; a transient branch failure clears on resume without re-running completed readers.
- Collect-errors, when added, is a per-fan-out opt-in that folds errors into the join — it does not change this default.
