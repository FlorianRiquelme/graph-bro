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
  consumer repo (R7). Read-only is what lets fan-out branches run in parallel without an isolated
  workspace each.
- **Write-capable node** — a node permitted to mutate files. The inverse of a read-only node in both
  directions: its tool policy allows mutation, and its backstop asserts confinement rather than
  cleanliness. Always paired with a **workspace** and a **sandbox**; never runs against the consumer's
  checkout.
- **Workspace** — the single isolated, run-owned checkout that **every** node of a run executes in,
  created from the **base ref**. The unit of blast-radius containment and the reason the consumer's
  working tree is untouched by construction rather than by policy. _Not:_ "sandbox" (a different,
  narrower boundary — see below), and not "worktree" (a mechanism that might implement it).
- **Base ref** — the committed ref a run's workspace is created from; defaults to the current
  branch's tip and is reported by `start`. Makes a run a function of committed state, never of the
  operator's in-flight edits, so two runs from the same base see the same code.
- **Sandbox** — the OS-level boundary confining what a node's *shell commands* may write and reach.
  Narrower than a workspace in scope and lower in the stack: the workspace says *where the run lives*,
  the sandbox says *what the OS will refuse*. Tool policy covers the tools the sandbox does not.
  _Not:_ a synonym for workspace, isolation, or containerization.
- **Super-step** — one iteration of the execution loop: snapshot state, run the ready frontier, merge
  updates through reducers, recompute the next frontier, checkpoint. Nodes never see each other's
  mid-step writes.
- **Attempt** — one activation of the node a loop re-enters. The single identifier shared by the loop
  bound, the commit the engine makes, and the trace — so "attempt 3" names the same thing in `git log`
  and in the trace. Counted per activation, so a run that never loops has exactly one.
- **Attempt bound** — the per-node cap on how many times a loop's re-entered node may activate.
  Semantically distinct from `max_steps`, which is a runaway backstop a graph can exhaust for reasons
  unrelated to a loop failing to converge. Exhausting it is **not_converged** — a terminal state
  meaning the run did its work and the reviewer still objects, which is a different thing from a
  failure and calls for a different response.
- **Routing decision** — the trace record of one `when` evaluation: the edge, the rule, the values
  read, and the boolean. What makes the trace answer *why* a branch was taken, not only which. A node
  whose every guard evaluated false fails loudly rather than silently draining the frontier.
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
- **Prompt template** — an `agent` node's `prompt` string bearing **interpolation tokens**, resolved
  against the node's input snapshot at activation (a fan-out branch additionally sees its `as` binding).
  A prompt with no tokens is not a template — it passes through byte-identical. _Not:_ an expression
  language; there are no conditionals, loops, or computation, only value interpolation with dotted-path
  access.
- **Interpolation token** — a placeholder in a prompt template addressing a value in the input snapshot
  by dotted path (same `getPath` semantics as `for_each`). The snapshot's values may be
  consumer-authored, caller-supplied via `--input`, or model-authored (an earlier node's
  `output_key`); resolution is **single-pass** — a substituted value is never re-scanned for
  tokens — which guards against re-interpretation, not against the value's content. A token
  addressing an absent path **fails loud** (R5); a present `null`/empty value is serialized, not
  a failure. Escapable as `\{{ path }}` (runtime string; authored in a topology JSON file as
  `\\{{ path }}`) when a prompt needs to emit the literal delimiters as text.
- **Prompt-token root check** — the check that every interpolation token's **root** state key
  is one the run can actually produce (a `set` update key, an `output_key`, a fan-out `as`, or
  an `--input` top-level key). Fatal at `start` before a run id is minted, so a typo'd root surfaces
  before any node executes rather than mid-run; re-run as the engine boots, since the engine re-reads
  the topology itself — which closes the `start`-to-spawn edit window and is the only gate `resume` gets
  (an engine-side miss fails the run with a `run_error` instead of dispatching a node). Roots only:
  anything deeper is a runtime fact, since per-branch item shape varies branch to branch. _Not:_ a
  reachability analysis — a key produced anywhere counts everywhere. So a pass means the root is
  *produced somewhere*, not that it is in scope at the node reading it: a key written only by a later
  node, by the reading node itself, or on a branch that never fires still fails at activation time.
- **Resolved prompt** — the concrete instruction a branch actually ran with, after its template's tokens
  were substituted. This — not the template — is what the trace records (R6), so per-branch
  differentiation is observable after the fact.
- **Output schema** — a contract an `agent` node declares for its own response. The engine validates
  against it and puts the **parsed value** — not the raw text — at the node's `output_key`, which is
  what makes a node's output addressable by dotted path from a `when` rule or a prompt token. Always
  authored by the consumer's topology: graph-bro ships no domain-shaped schema of its own, because an
  engine with a built-in verdict type would know that its consumers do code review (boundary
  invariant, ADR-0014). A non-conforming response fails loudly (R5). _Not:_ a retry mechanism, and not
  a guarantee — structured output is a tool call the model can fail to make.

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
- ADR-0012 — Write-node blast radius enforced by an OS-level sandbox, tool policy layered above it.
- ADR-0013 — The engine owns commit granularity; every attempt is committed, including failures.
- ADR-0014 — Node output schemas are declared by the topology; the engine ships none.
