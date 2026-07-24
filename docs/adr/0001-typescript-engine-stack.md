# ADR-0001: TypeScript as the engine implementation language

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context slice:** Engine Slice 1 (`docs/plans/2026-07-24-001-feat-engine-slice-1-plan.md`, Outstanding Question: "Implementation language and stack")

## Decision

The graph engine is implemented in **TypeScript** (Node runtime).

## Context

The binding technical reference (`docs/research/graph-orchestration-landscape.md` §13–§16, LangGraph internals, athena-graphs) is Python, and the validating consumer sensei (`mine.py`) is Python. That biased slice 1 toward Python on a pure porting-risk basis — the crash-safe checkpoint / pending-writes / resume core (§8.5) is the highest-risk part and exists as proven Python.

Weighed against: the operator considers TypeScript the superior language for agentic development; the CLI-agent node (Claude Code) is Node-native with a first-party TS Agent SDK; graph-bro is greenfield with no stack to match; and the standing zod-everywhere convention makes R2's serializable topology a natural zod-schema'd artifact.

## Rationale

Operator's call: TypeScript is judged superior for agentic development, and graph-bro is a public showcase for "how you actually build graph engineering" — a TS/Node reach argument reinforces that. R2's serializable-topology requirement decouples engine language from the (Python) consumer, so co-locating with sensei was only a tiebreaker, not decisive.

## Consequences

- **zod-everywhere now binds** (standing convention, TS branch): topology grammar, run-trace schema, and CLI-agent JSON contracts are all zod-defined, not just HTTP-edge validation.
- **The §8.5 correctness core is re-implemented, not ported.** State-snapshot-per-super-step + per-task pending writes keyed by a deterministic `(run_id, node, step, triggers)` hash is the single most load-bearing property (§16) and must be built carefully in TS with its own test coverage (§15 checklist).
- **Distribution is npm-shaped** (feeds the next open decision: how sensei invokes the CLI with no graph-bro checkout — R11).
- **Subprocess control uses Node primitives:** `child_process` spawned `detached: true` (new process group) + `process.kill(-pid, …)` for SIGTERM→SIGKILL group reaping, and `readline` over stdout for NDJSON streaming — the Node equivalents of §13.4's `start_new_session=True` + `os.killpg` + asyncio streaming.
