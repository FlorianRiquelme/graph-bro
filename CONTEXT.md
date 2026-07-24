# graph-bro — Context & Glossary

The ubiquitous language for graph-bro. Use these terms verbatim in code, issues, tests, and docs;
avoid the listed synonyms. Decisions that shaped these terms live in `docs/adr/`.

## Core vocabulary

- **Topology** — the serializable, consumer-authored graph definition (nodes + edges + `max_steps`).
  Contains no opaque callables so it survives a process restart (R2). Authored *in the consumer repo*
  and handed to the engine by file path. _Not:_ "graph definition", "workflow spec", "DAG" (it may loop).
- **Node** — a function of shared state whose result is a state update (R4). Slice-1 kinds: `agent`
  (runs a CLI coding agent), `set` (deterministic write). The `human` node kind (HITL) is deferred.
- **Edge** — an authoring-surface connection between nodes. Carries the composable primitives:
  **fan-out** (`for_each` over a state path) and **join** (multi-source barrier). Compiles down to
  channels at runtime.
- **Channel + subscriber** — the *runtime* model (not nodes+edges): a join is a resettable barrier
  channel, conditional routing is a runtime writer (§16, settled). Nodes/edges are how a topology is
  *authored*; channels are how it *runs*.
- **Fan-out** — spawning one instance of a target node per item in a runtime-determined list; N is
  known only at run time (R3). Declared as an edge modifier (`for_each`/`as`), not a node kind.
- **Join / barrier** — a multi-source edge whose barrier fires when its sources are complete, then
  resets (so loops can re-arm it). Barrier **mode** (`all`/`any`) is split from the **reducer**.
- **Reducer** — the merge policy resolving concurrent/repeated writes to one state key. Built-ins:
  `append`, `merge`, `sum`, `dedup`. Unregistered write conflicts **fail loudly** (R5, §16).
- **Read-only node** — a node declared `read_only: true`: it reads and proposes, never mutates the
  consumer repo (R7). Read-only is what lets fan-out branches run in parallel without a sandbox.
- **Super-step** — one iteration of the execution loop: snapshot state, run the ready frontier, merge
  updates through reducers, recompute the next frontier, checkpoint. Nodes never see each other's
  mid-step writes.
- **Checkpoint** — the durable per-super-step state snapshot: `{state, frontier, barrier state, step,
  history}`. The whole resumability contract; resume loads one snapshot and skips completed nodes (R9).
- **Pending writes** — per-task durable writes keyed by the deterministic `(run_id, node, step,
  item_key, triggers)` hash — `item_key` is the fan-out per-instance discriminator (KTD-12), without
  which N siblings of one node id at one step collapse to a single row. The single most load-bearing
  correctness property (§8.5): a succeeded sibling is never re-run when a failing sibling retries.
- **Run** — one detached execution of a topology, identified by a **run id**. Persists to SQLite;
  survives crashes; addressed by id from any consumer repo via the CLI.
- **Trace** — the agent-legible record of "what happened on the way" (R12): per-node start/end,
  outputs, failures, routing, and per-node data to compute cost later. Stored in SQLite, read via the
  CLI (`tail`/`result`/`trace`), never by the consumer running SQL.
- **Consumer** — the external repo that authors a topology and invokes the engine (slice 1: sensei).
  graph-bro never names a consumer or its domain (R1, boundary invariant).

## Settled decisions (see `docs/adr/`)

- ADR-0001 — TypeScript engine stack (zod-everywhere binds).
- ADR-0002 — CLI as a global command on PATH, no consumer checkout (`npm link` for slice 1).
- ADR-0003 — SQLite as the durable run store, one global DB from inception.
- ADR-0004 — Detached process per run, no daemon.
- ADR-0005 — Fan-out and join as composable edge primitives; sugar deferred.
- ADR-0006 — Fail-fast is the sole branch-failure policy in slice 1.
- ADR-0007 — Read-only nodes enforced via Claude Code's permission system.
- ADR-0008 — Synchronous checkpoint writes at both levels.
- ADR-0009 — Capture per-node cost data (raw tokens + reported cost) from inception.
- ADR-0010 — One Claude Code backend behind a narrow executor seam, no registry.
- ADR-0011 — Bounded fan-out concurrency (default K=5) + per-node model selection.
