---
title: Fan-out Branch Differentiation - Plan
type: feat
date: 2026-07-24
topic: fanout-branch-differentiation
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
---

# Fan-out Branch Differentiation - Plan

## Goal Capsule

- **Objective:** Let a fan-out `agent` node authored in a JSON topology differentiate its
  branches, so N read-only readers each receive a prompt derived from their own `as`-bound
  item instead of byte-identical text. Delivered as **prompt templating over the node's input
  snapshot**, available on any `agent` node (fan-out branches additionally see their `as`
  binding). Per-branch cwd is explicitly out of scope for this work.
- **Product authority:** issue graph-bro#6 (this capability), issue graph-bro#1 (engine
  capabilities surfaced by the mining use case; boundary invariant), issue sensei#30 (driving
  consumer, hard blocking dependency), `STRATEGY.md` (Engine + Agent-legible observability
  tracks), `CONTEXT.md` (ubiquitous language).
- **Open blockers:** none. This extends the merged/merging engine slice-1 (see
  `docs/plans/2026-07-24-001-feat-engine-slice-1-plan.md`); it does not depend on any unbuilt
  capability.

---

## Product Contract

### Summary

Fan-out `agent` branches cannot tell each other apart today: the `for_each` edge binds each
item into the branch snapshot (`activation.binding = { key: as, value: item }`), the loop folds
it into the `input` passed to the node fn, but the agent executor only reads a **static**
`prompt` string and never consults that input. N branches therefore run with identical prompt,
identical cwd, and no signal of which item is theirs. This capability makes the `prompt` string
a template resolved against the node's input snapshot, so each branch's prompt embeds its bound
item. The primitive is domain-agnostic and preserves the read-only + clean-repo invariants
per branch.

### Problem Frame

This is the first real engine capability the mining use case surfaces, exactly as graph-bro#1
anticipated: a read-only fan-out where every branch reads a *different* slice of input. It does
not work end-to-end from a JSON topology today because branches are indistinguishable. The
driving consumer, sensei#30 (full-mode mining), needs each read-only reader branch to inspect a
different batch of transcripts and takes a hard blocking dependency on this capability. The gap
is already documented in the suite: `test/integration/fanout-join.test.ts` uses an `append`
reducer specifically because "the real runtime's `node.prompt` is a static string … so every
branch's stub response is identical," proving arrival by count rather than by distinct value.

### Requirements

- **R1 — Templated agent prompt.** An `agent` node's `prompt` may contain interpolation tokens
  that reference values in the node's input snapshot. At execution the tokens are replaced with
  the resolved values before the prompt reaches the executor. A prompt with no tokens behaves
  exactly as today.
- **R2 — Resolution against the input snapshot, any agent node.** Tokens resolve against the
  same `input` the node fn already receives — for a fan-out branch that is
  `{ ...snapshot, [as]: item }`; for any other agent node it is the plain state snapshot.
  Templating is a general agent-node capability, not fan-out-special-cased: a prompt may
  reference an upstream node's output as readily as a fan-out branch references its `as` item.
- **R3 — Dotted-path access.** A token may address a nested field of the bound value using the
  engine's existing path convention (the same `getPath` semantics `for_each` already uses), so
  an object-valued item can be projected to the field a branch actually needs.
- **R4 — Non-string values are serialized.** A token resolving to a string inlines verbatim (no
  surrounding quotes); `number`/`boolean`/`null` inline as their JSON scalar form (`5`, `true`,
  `null`); an object or array is `JSON.stringify`-serialized **pretty-printed at 2-space indent**
  (legible to the reading agent; token cost is trivial).
- **R5 — Unresolvable reference fails loud, resolved before the executor runs.** *Absence* — the
  path resolver (`getPath`) yielding `undefined`, whether from a missing key, a literally-`undefined`
  value, or descent into a non-object — fails the branch loudly with an error naming the node and the
  unresolved token, rather than silently interpolating empty text. A path that is **present** but
  holds `null`, `""`, or `[]` is a *value*, not an absence: it serializes per R4. Resolution runs at
  the `config.prompt(state)` evaluation (`loop.ts:114`), which precedes `executor.run`, so an
  unresolvable token errors **before** the executor is ever invoked for that branch. This matches the
  engine's fail-loud stance (unregistered reducer write conflicts fail loudly, R5/§16). Consequence
  under fan-out: because fail-fast is the sole branch-failure policy (ADR-0006), one branch's
  unresolvable token aborts the **whole** run, not just that branch — the consumer must trust its own
  batch shape.
- **R6 — Trace records the resolved prompt.** The per-node trace records each branch's
  *resolved* prompt, not the template, so the agent-legible record (R12) shows the actual
  instruction each branch ran with. This is what makes differentiation observable after the
  fact.
- **R7 — Boundary invariant preserved.** The capability is domain-agnostic: no consumer
  name/domain appears in shipped `src/` or `examples/`. The read-only allowlist and the
  per-branch `assertRepoClean()` backstop continue to apply unchanged to every branch (cwd
  stays `process.cwd()` for all branches in this work, so clean-repo semantics do not move).
- **R8 — Showcase demonstrates distinct outputs; the test proves them.** Distinctness is *asserted
  deterministically* in the integration test via a **prompt-echoing stub executor + `dedup`** join:
  distinct resolved prompts necessarily yield distinct stub outputs, so `dedup` proving distinctness
  is airtight and never flakes on agent nondeterminism. Separately, `examples/fanout-read-join` is
  **rewritten in place** — retiring the `append`-by-count workaround for a `dedup` join — to
  *demonstrate* N branches producing distinct outputs against a real agent (illustrative, never a
  gated assertion on exact output equality).

### Flows

**F1 — Differentiated fan-out read (happy path).**
1. A `set` (or prior) node populates a state list (e.g. `batch.items`).
2. A `for_each` edge fans out over that list into a read-only `agent` node, binding each item as `as`.
3. Each branch resolves its templated `prompt` against its own `input` snapshot → a prompt that names its item.
4. Each branch runs read-only; the clean-repo backstop asserts per branch on completion.
5. A join barrier collects branch outputs; a `dedup` reducer merges to distinct values.
6. The trace shows each branch's resolved prompt and distinct output.

**F2 — Unresolvable token (failure path).**
1. A branch's template references a path absent from its item.
2. Resolution fails loud before the executor is invoked; the branch errors naming node + token.
3. Fail-fast branch policy (ADR-0006) governs what happens to the run from there.

### Acceptance Examples

- **AE1 — Distinct branch prompts.** Given a `for_each` fan-out over a 3-item list into a
  read-only `agent` whose `prompt` references its `as` item, when the run executes against a
  prompt-echoing stub executor, then the three branches invoke the executor with three *distinct*
  resolved prompts (not one repeated string), and a `dedup` join yields three distinct outputs.
  (Distinctness of *prompts* is deterministic string resolution; the echoing stub makes distinctness
  of *outputs* deterministic too — see R8.)
- **AE2 — Non-fan-out templating.** Given a single `agent` node whose `prompt` references an
  upstream node's output key, when the run executes, then the resolved prompt contains that
  upstream value.
- **AE3 — Unresolvable token fails loud.** Given a branch template referencing a missing path,
  when the branch activates, then it fails with an error naming the node and the unresolved
  token, and the executor is never called for that branch.
- **AE4 — Read-only still holds per branch.** Given the differentiated fan-out of AE1, when any
  branch would mutate the repo, then `assertRepoClean()` fails that branch exactly as today —
  differentiation does not weaken the invariant.
- **AE5 — Untemplated prompt unchanged.** Given an `agent` node whose `prompt` contains no
  tokens, when the run executes, then behavior is byte-identical to today.

### Key Decisions

- **Ship prompt templating; defer per-branch cwd.** graph-bro#6 offered templating (general)
  and per-branch cwd (fits a directory-per-branch item). The driving consumer needs each branch
  to read a *batch* (a list), not operate inside one directory, so templating covers it and cwd
  is unnecessary now. (session-settled: user-delegated — "whatever the issue needs"; resolved to
  templating because the issue recommends it and the consumer's batch shape is data, not a
  directory. Per-branch cwd is a later issue if a directory-per-branch case appears.)
- **Resolve against the input snapshot, available on any agent node.** Templating interpolates
  over the `input` the node fn already receives rather than a fan-out-only special case.
  (session-settled: user-approved — chosen over restricting resolution to the `as` binding: the
  snapshot already contains the binding, so a restriction would add gating logic for a narrower
  capability at no benefit.)
- **Unresolvable references fail loud.** Chosen over silent empty-string interpolation, to match
  the engine's fail-loud convention. (assumption grounded in R5/§16; confirm at planning if a
  lenient mode is ever wanted.)
- **Trace stores the resolved prompt, not the template.** So differentiation is observable from
  the trace alone, serving the Agent-legible observability track.

### Non-Goals / Out of Scope

- **Per-branch cwd** — deferred to a later issue; every branch keeps `process.cwd()`.
- **Changes to fan-out concurrency, join/barrier, or reducers** — the `dedup` reducer already
  exists; only the showcase's reducer choice changes.
- **A general expression/templating language** — this is value interpolation over the snapshot
  with dotted-path access, not conditionals, loops, or computation inside the template.
- **Escaping literal delimiters** — no escape mechanism ships this slice; a prompt needing the
  literal delimiter sequence is a documented known limitation (filed issue), given trusted
  single-author data. Resolution is single-pass, so a substituted value containing the delimiter is
  never re-interpreted.
- **Compile/lint-time token validation** — deferred to a follow-up issue; unresolved tokens fail
  loud at activation only (see Resolved).
- **Consumer domain in shipped code** — sensei's transcript/mining specifics stay in sensei.

### Assumptions

- The latent seam `AgentNodeConfig.prompt: string | ((state) => string)` (`loop.ts:109`) and the
  per-branch `input` fold (`loop.ts:299`) are the intended integration points; a compiled
  template resolver satisfies the function branch. (Grounded by the scout dossier; planning
  confirms the exact wiring.)
- The token grammar itself (delimiter, exact syntax) is a planning/implementation decision, not
  fixed here; graph-bro#6 floated `{{ <as-name>.<path> }}` as a candidate.

### Resolved (grill 2026-07-24)

- **Detection timing — activation-time only this slice.** Unresolved-token failure surfaces at
  activation (R5), not at compile/lint time. Static root-name token linting would catch only
  root-name typos (deep paths and per-item shape are inherently runtime) and requires a
  "what state keys can exist at node X" reachability analysis larger than the templating primitive
  itself — a pure quality-of-life add behind no capability. **Filed as a follow-up issue**, not
  built here.
- **Trust/escaping — single-pass, trusted, no escape hatch.** Tokens resolve **single-pass**: a
  substituted value is never re-scanned, so a resolved value that happens to contain the delimiter
  lands as literal text. Fan-out data is **trusted** (the consumer authors both template and data —
  a single-author boundary, not an untrusted perimeter), so **no value-escaping mechanism** ships
  this slice. A prompt needing *literal* delimiters is a **documented known limitation** with a
  filed issue, not a surprise. (Single-pass is correct semantics regardless of trust; an escape
  grammar is speculative complexity until a real prompt needs it.)

### How This Work Fits Together

- **graph-bro#1** named this exact shape (read-only fan-out, each branch reads a different
  slice) as the first capability the mining use case would surface. This capability closes that
  gap for the JSON-authored path.
- **sensei#30** is the driving consumer and takes a hard blocking dependency: its read-only
  reader branches each inspect a different transcript batch via a templated prompt. graph-bro
  ships the generic primitive; sensei supplies the domain.
- **Engine slice-1** (`docs/plans/2026-07-24-001-...`) built the fan-out/join/read-only/trace
  substrate this extends. This work activates a seam that slice left latent
  (`prompt: (state) => string`) rather than adding a new subsystem.
