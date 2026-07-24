# ADR-0005: Fan-out and join as composable edge primitives, not a sealed macro

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context slice:** Engine Slice 1 — resolves "the concrete topology grammar (the serializable format's shape)" for R2, R3, R5.

## Decision

The topology grammar adopts athena-graphs' JSON envelope (`nodes` + `edges` + `max_steps`), expressed as a zod schema. Dynamic fan-out and join are **two composable edge-level primitives**, not a single bundled node:

- **Fan-out** is an edge modifier: `{ from, for_each: "<dotted state path>", as: "<item binding>", to }` — spawns one instance of `to` per item in the runtime list; N = the list's length (R3).
- **Join** is the ordinary multi-source barrier edge: `{ from: [<sources>], mode: "all"|"any", reducer, into, to }` — the same primitive used everywhere, with barrier `mode` split from merge-policy `reducer` (§16).
- **`dedup`** joins `append`/`merge`/`sum` as a built-in reducer (the mining join needs it).

The runtime remains channels + subscribers (§16); node-vs-edge is an authoring-surface choice that compiles to identical channel wiring.

## Rationale

Chosen over a sealed `fan_out` node (macro bundling router + template + barrier) because graph-bro's declared trajectory is loops + conditional routing (next slice, the Engine headline), HITL interrupt nodes inside branches, subgraphs, and heterogeneous joins (e.g. adversarial-reviewer voting: N fanned critics + one fixed synthesizer). A sealed macro fights all four — the fanned target can't easily loop/branch/be-a-subgraph, and its join only knows its own fan. Composable primitives keep the fanned target an ordinary node, so those capabilities compose for free.

The macro's usual advantage (misuse safety) is weak here: slice 1 already has a multi-source barrier join, so the barrier machinery and §14.9 desync risk exist regardless of framing — the macro would only hide them. Since the barrier is load-bearing either way, composability costs little extra now and avoids a re-cut later.

## Consequences

- **The §14.9 join-desync lint (compile-time) + runtime watchdog ship in slice 1** — mandated by §16 regardless, and they carry most of the safety a macro would have provided by construction.
- **The `fan_out` authoring sugar is deferred** (would expand to fan-out edge + target + join edge at compile time). At one topology (sensei's mining graph, authored once) the ergonomic win is marginal and the safety win is already covered by the lint; deferring avoids fitting the sugar's shape to a sample size of one. Revisit when a second consumer or a second sensei topology reveals the common case. ("Nothing speculative.")
- **`read_only: true` (R7) is what makes parallel fan-out safe** without a sandbox: read-only branches mutate no cwd, so they sidestep §13.4's "file-editing CLI agents sharing a cwd must run sequentially." R3 and R7 are load-bearing for each other.
- Rejected: a `Send`-returning router callable (violates R2 serializability) and static pre-expanded fan-out (can't size from runtime state, violates R3).
