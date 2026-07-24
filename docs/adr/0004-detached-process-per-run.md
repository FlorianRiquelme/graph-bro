# ADR-0004: Detached process per run, no resident daemon

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context slice:** Engine Slice 1 — resolves the detach model behind R11 / AE5 ("start returns promptly with a run id while the run continues detached").

## Decision

`graph-bro start` spawns the engine as a `detached: true`, `unref()`'d child in its own process group, writes the run row + run_id to SQLite, prints the id, and exits 0. The detached child runs the graph to completion, writing checkpoints/events to the DB. `status`/`tail`/`result` are independent short-lived CLI calls that read the DB; `resume <run_id>` re-launches a fresh detached child from the last checkpoint. **No always-on daemon.**

## Rationale

For a solo operator on one machine this is strictly simpler than a daemon — no service lifecycle, start-on-boot, IPC protocol, or "is the daemon up?" failure mode. SQLite (ADR-0003) is the shared state between ephemeral CLI calls and detached engine processes, so no resident coordinator is needed. A daemon only earns its complexity with cross-run centralized scheduling/concurrency-limiting, which is out of slice-1 scope.

The operator noted this is cheaply reversible: because SQLite is the inter-process contract either way, swapping to a daemon later doesn't disturb the CLI or storage contracts.

## Consequences

- **Kill/resume** composes cleanly: killing a run kills that one process group (§13.4's group-kill rules already govern the CLI-agent nodes inside it); resume spawns a new detached process from the checkpoint (AE2).
- **No supervisor enforces the step cap / heartbeat for a wedged engine process** — these are self-enforced inside each engine process (bounded execution loop §16 item 3; node heartbeat §13.4), so they hold without a daemon.
- Reversible to a daemon later without touching the CLI invocation or SQLite schema.
