# ADR-0010: One Claude Code backend behind a narrow executor seam, no registry

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context slice:** Engine Slice 1 — resolves how much backend generality R6 builds.

## Decision

Slice 1 ships **exactly one CLI-agent backend (Claude Code)**, implemented behind a **single narrow internal executor interface** — the §13.4 contract: spawn → deliver prompt (athena compile-time rule) → capture JSON envelope → group-kill on cancel/timeout (`detached` + `process.kill(-pid, …)`) → heartbeat (two-threshold, last-stdout-line). **No backend registry, no `list_backends`, no plugin discovery, no second adapter.**

## Rationale

The reference (athena-graphs) ships a pluggable backend registry, but slice 1 has one backend and one consumer — a registry/discovery layer is speculative. Hardcoding Claude Code inline is the opposite error (a second backend later means surgery). The narrow seam is the middle: one concrete implementation, but the executor contract is a single small interface so a second backend slots in later without touching the engine core.

Consistent with the project's standing pattern — build the minimum, leave the forward-compatible boundary (cf. ADR-0002 CLI distribution, ADR-0005 deferred fan-out sugar). "Nothing speculative," minus the one seam that costs nothing now.

## Consequences

- Claude Code's envelope/flags/permission-mode (ADR-0007) live *inside* the one implementation, not smeared across the engine.
- A second backend (another CLI coding agent) is a later, additive change: implement the interface, no engine-core edits, and only *then* consider whether a registry is worth it.
