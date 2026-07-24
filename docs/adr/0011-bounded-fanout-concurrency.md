# ADR-0011: Bounded fan-out concurrency (default K=5) + per-node model selection

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context slice:** Engine Slice 1 — a gap not in the plan's listed open questions, surfaced during grilling.

## Decision

Parallel node execution runs through a **bounded worker pool** with a mandatory max-concurrency cap: **global default K=5, overridable per-topology**. A fan-out still *logically* spawns all N branches; the executor drains them K-at-a-time to completion.

Relatedly, the `agent` node schema carries a **per-node `model` field** so the topology selects the model per node. Read-only reader nodes are expected to use a **cheap model** (Haiku/Sonnet), never Fable/Opus.

## Rationale

graph-bro's branches are not cheap threads — each is a Claude Code subprocess (heavy memory + an Anthropic API call). A large mining run could fan out to 170 batches, not 17; spawning them all at once would exhaust the machine and slam API rate limits, turning the slice's headline primitive (parallel fan-out) into its headline failure mode. R8 bounds *step count*, not *concurrent width*, so this is a genuine gap.

K=5 is low enough to be safe on one machine and under typical API limits, high enough to prove real parallelism (operator's call). Cheap models for read-only discovery nodes follow the standing cost-conscious model-routing convention and are what keep a K=5 fan-out safely within rate limits ("as long as we're not using Fable for the read-only models").

## Consequences

- No semantic change: the join still fires on all N (AE1's 17-execute-and-join holds); only wall-clock parallelism is bounded.
- Composes with ADR-0008: branches durably checkpoint as they drain through the pool, so a crash mid-drain resumes cleanly (uncompleted branches re-enter the frontier).
- The topology can raise K where a workload and its models tolerate it; the default protects the unconfigured case.
- ce-plan must include `model` in the agent-node zod schema; the showcase example graph (R13) should demonstrate a cheap read-only model.
