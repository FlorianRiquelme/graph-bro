---
title: Engine Slice 2 - Write Nodes, Conditional Routing, Self-Correcting Loops - Plan
type: feat
date: 2026-07-25
topic: engine-slice-2
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Engine Slice 2: Write Nodes, Conditional Routing, Self-Correcting Loops - Plan

## Goal Capsule

- **Objective:** Ship the Engine track's headline primitive — a run that writes to a repo, judges its own output, routes on that judgment, and corrects itself without a human between start and result.
- **Product authority:** graph-bro#14 (origin), `STRATEGY.md` (Engine track), and this document. Where they disagree, this document is current: it settles decisions #14 left open.
- **Provenance:** brainstormed 2026-07-25, then grilled the same day against the slice-1 source and the installed `claude` CLI (v2.1.220). The grill narrowed scope to single-track, corrected two rationales that were factually wrong, and closed both of the questions that previously blocked planning.
- **Open blockers:** none. One planning-stage probe sits on the critical path (see Outstanding Questions).

---

## Product Contract

### Summary

graph-bro gains write-capable agent nodes, a `when` DSL that executes at run time, and a loop that re-enters on a machine-readable, schema-validated node output.
A run executes entirely inside an isolated, run-owned workspace branched from a declared base ref, loops until its own review passes or its attempt bound is hit, and hands back committed work on a run-owned branch.

Write work is **single-track** in this milestone. Fanning write work across N concurrent lanes is deferred to a follow-up slice.

### Problem Frame

Slice 1 shipped an engine that reads: fan-out, join, dedup, crash-safe resume, detached CLI — all of it read-only by construction.
Two compile-time walls block everything past that.
`src/topology/schema.ts` pins agent nodes to `read_only: z.literal(true)`, so a node that mutates a repo is rejected before a run id exists.
The `when` DSL is parsed and linted but never evaluated; its only consumer outside the schema is `src/topology/lint.ts`.
Nothing routes on state, so no run can react to its own output.

The cost of that gap is the target problem in `STRATEGY.md`, unchanged: the operator is the message bus.
A single-shot run produces work and stops, which means every run's output waits on human attention before it can move.
Running many workstreams at once is capped by how fast one person can context-switch between them, not by what the agents can do.

The comparison that matters is a coding session with subagents, which is what the operator does today.
That baseline already parallelizes within one feature, and **single-track graph-bro is slower than it on any single feature**.
That is accepted, not worked around, and it is explicitly not part of this milestone's acceptance bar.
The four wins that do not require beating it on wall-clock are the whole point: a session cannot be walked away from, cannot review and correct its own output, dies with its work when it dies, and serializes across features because the operator holds each thread.
None of those four need concurrent write lanes.

### Key Decisions

- **The graph covers the headless-able portion of the operator's workflow, not just execution.** A run spans planning through review→fix, because a graph that only executes is a session the operator already has. The dividing line is not stage count: any stage that resolves its own questions from repo context belongs here, and any stage that needs an answer from the operator belongs to the Human-checkpoint track. (session-settled: user-directed — chosen over an implement→review→fix-only driver: an execute-only graph delivers no unlock over a `goal` session.)

- **Write work is single-track; fan-out write lanes defer to slice 2b.** (grill-settled: user-approved — reverses the brainstorm's "write work fans out.") The brainstorm assumed per-lane loops extend existing machinery, on the grounds that the join barrier already re-arms. The slice-1 source says otherwise: `loop.ts:231` gives every plain-edge target the activation id `{nodeId: edge.to, instanceId: edge.to}`, so per-instance identity — and the `as` binding — die at the first plain edge after a fan-out, collapsing N lanes into one activation via `pushUnique`. State is one flat dict, so N lanes writing their own verdict to one `output_key` raises `StateConflictError` (`reducers.ts:92`). And `commitPendingWrite` only fires for activations carrying an `itemKey` (`loop.ts:308`), so nothing after a fan-out target gets per-instance durability. Lanes therefore require **subgraph instancing and per-instance state scoping** — a new engine primitive, not an extension. Deferring it removes the merge-conflict question and N-way isolation from this milestone without touching any of the four wins above.

- **A write node's blast radius is an OS-enforced boundary, not a post-hoc check.** The engine synthesizes per-node settings JSON — `sandbox.enabled`, `allowUnsandboxedCommands: false`, filesystem writes scoped to the workspace, network denied by default — and passes it via `--settings`. The consumer-checkout-clean assertion remains as a secondary backstop. This is the two-layer shape ADR-0007 already ratified (permission-mode primary, tree-clean backstop secondary) with a stronger primary, and it is the direct application of the standing convention that a headless invocation's constraints must be enforced by the orchestrator. It is also what makes "a write node cannot escape its workspace" a satisfiable requirement at all: there is no `git status --porcelain` equivalent for *everywhere else on the filesystem*, so without an OS boundary the requirement could only be asserted, never met.

- **The brainstorm's rejection of path-scoped write permissions was factually wrong and is withdrawn.** It read: "a write node needs Bash to run tests, and shell access defeats path allowlists." Claude Code's Bash sandbox exists precisely to close that hole — it applies at the OS level to the Bash tool specifically. Isolation is still built on a run-owned workspace, but on its real merits (handback shape, concurrent-run safety, resumability), not on that argument.

- **Isolation is built on git directly, not on an existing sandbox layer.** Dagger's container-use implements nearly this design, but it is an MCP server the agent calls, which inverts ADR-0007's premise that the orchestrator enforces constraints because the agent cannot be trusted to. Isolation an agent opts into is isolation an agent can skip. Its remaining value is containerization, which the solo-operator trust model does not require, and it would make Docker a hard dependency against ADR-0004's no-daemon posture.

- **Every node runs inside the workspace, and the workspace is created from a declared base ref.** (grill-settled: user-approved — chosen over running read-only nodes in the consumer's checkout.) If only write nodes were isolated, a planning or review node would read the operator's working tree *as it happens to be at launch*, including unrelated uncommitted work — making the run a function of desk state and misfiring slice 1's read-only backstop on a dirty tree the node never touched. A declared base ref (defaulting to the current branch tip) additionally lets a run start against `main` while the operator's checkout sits elsewhere mid-task, which the walk-away premise requires. This is also what makes "the run never modifies the consumer's working tree" **structural** rather than policed: nothing in the run ever has that path as its cwd.

- **The engine owns commit granularity: exactly one commit per attempt, whatever the agent does.** (grill-settled: user-approved — replaces "agent nodes get no git-mutating tools.") A tool allowlist cannot deliver this: `--disallowedTools "Bash(git commit:*)"` matches on the command string and is defeated by `sh -c`, a script, or a test runner's git hook, so the brainstorm's R9 read as a guarantee it could not make. Under the sandbox an agent's commit is already *contained* — it lands in the run's own workspace — so what the rule actually protects is per-attempt history, and that is better secured by an engine-side HEAD comparison before and after each write node, squash-folding whatever the agent committed. Detection cannot be talked around; an allowlist can. Folding rather than failing is chosen because failing an unattended run over something harmless the engine could absorb defeats the point of it being unattended.

- **Every attempt is committed, including the failing one.** (grill-settled: user-approved.) This resolves the collision between retaining a workspace for forensics and re-entering it on resume: resume commits the failed attempt to a side ref, hard-resets the workspace to the last good commit, and re-runs deterministically. Nothing is lost and the failure state is reachable from `git log` rather than from a temp directory the operator has to remember not to disturb — strictly better evidence than "the workspace is retained," and it makes write runs resumable, which is where slice 1's crash-safety earns the most.

- **Node output schemas are declared by the topology, never by the engine.** (grill-settled: user-approved.) `--json-schema` makes structured output a flag rather than a parsing problem, but an engine shipping a built-in `VerdictSchema` would know that its consumers do code review — the same category of leak as naming a consumer. Instead an agent node may declare an `output_schema`; the engine validates against it and writes the *parsed object* to `output_key`. `when` rules then address it by dotted path via the existing `getPath` traversal, and the existing prompt-template primitive carries findings to the fixer with no new mechanism. The generalization is worth more than a verdict type: any node can return structured data.

- **A router that matches nothing fails loudly.** (grill-settled: user-approved.) Today an empty frontier yields `dead_end` (`loop.ts:379`), which was unambiguous only because nothing was conditional. Once routing executes, an unexpected output value — a third enum member, a typo'd `"passed"` — silently exits the run through a status indistinguishable from a graph that finished, which is exactly the silent give-up this milestone forbids. Compile-time exhaustiveness was considered and demoted to a lint warning: requiring a default edge forces authors to write filler edges into END, and exiting through a filler edge is worse than failing with the unexpected value named.

- **The attempt bound is declared on the re-entered node, and is separate from `max_steps`.** `max_steps` is a runaway backstop; a graph can exhaust it for reasons unrelated to loop divergence. Placing the bound on the node rather than the back-edge means the engine counts activations instead of detecting cycles, makes the attempt counter one identifier shared by the bound, the commit message, and the trace, and dissolves the question of how two back-edges into one node interact. The cost is that a node on two loops gets one bound — acceptable, and cheaper than cycle analysis.

- **Hitting the attempt bound is its own run status, not a failure.** `failed` and `not_converged` call for different operator actions: the first means something broke and the branch may be worthless, the second means the run did its work, committed every attempt, and the reviewer still objects — a branch worth reading, and a labeled instance of the agent being unable to satisfy its own reviewer, which is the most valuable signal the calibration track will ever receive. The cost is near zero: `runs.status` is unconstrained `TEXT` (`001_init.sql:7`) and `resume` gates on owner-pid liveness only, never on status.

- **No cost ceiling.** (grill-settled: user-directed.) Runs execute against a subscription, not metered billing, so a USD cap guards nothing the operator cares about. This also means the scarce resource is the usage window, not the bill — so per-attempt **tokens** are the number the trace surfaces, with reported USD alongside, and ADR-0009's "what would one session have cost" is a token comparison.

- **No push, no PR, no capability grammar.** (grill-settled: user-approved — replaces "push and PR-opening are declared capabilities, off by default.") `STRATEGY.md` makes autonomy earned through calibration override rate, and no calibration data exists — so a declared capability would ship off by construction and stay off for the entire milestone, with its acceptance test asserting that an unbuilt feature did not fire. Inventing a capability-declaration grammar for a single unused instance, in a slice already adding `output_schema`, `max_attempts`, a write flag, and network domains to the authoring surface, is the kind of speculation that produces a grammar to regret. The framing already exists in this document: squash and rebase stay the operator's because `git merge --squash` already does them. `git push` already does this. It is also a free reduction in attack surface — no push credential goes near a headless write agent in the slice where the enforcement is new and unvalidated.

- **Committing is bounded to a run-owned branch.** graph-bro never commits into existing history and imposes no history shape on it. Squash, rebase, and cherry-pick stay the operator's, done with their own tools.

- **A review panel is not an engine requirement.** Several review nodes into a join with a reducer is already expressible with slice-1 primitives. Split-verdict handling is a reducer choice the topology author makes. Nothing ships to support panels and nothing prevents them.

- **`on_error` routing defers again.** ADR-0006's fail-fast plus a retained workspace is a coherent failure story: the run halts loudly, evidence stays in git, `resume` exists. ADR-0006 frames fail-fast as slice-1's decision with alternatives deferred, not as a permanent absolute — this milestone extends the deferral rather than closing it.

### Actors

- A1. **Operator** — the solo human. Starts a run, is absent until it finishes, reviews the handback with ordinary git.
- A2. **Engine** — the detached runtime. Owns the workspace, commits, routing, loop bounds, and the trace. The only component that enforces constraints.
- A3. **Write node** — a CLI-agent node that mutates files inside the run's workspace. Runs headless with no human able to approve anything.
- A4. **Review node** — a CLI-agent node that reads the work and returns a structured, schema-validated output.
- A5. **Consumer repo** — the external repository whose topology started the run and whose code the run changes.

### The run shape

```mermaid
flowchart TB
  START([start]) --> WS[/engine: create workspace from base ref/]
  WS --> PLAN[plan node]
  PLAN --> IMPL[implement node]
  IMPL --> C1[/engine: commit attempt/]
  C1 --> REV[review node]
  REV -->|when: fail| FIX[fix node]
  FIX --> C2[/engine: commit attempt/]
  C2 --> REV
  REV -->|when: pass| HB[hand back run-owned branch]
  HB --> END([end])
  REV -.attempt bound hit.-> NC([not_converged])
```

The loop re-enters `review`, whose `max_attempts` bounds it.
Every arrow into `review` is preceded by an engine commit, so the attempt count, the commit history, and the trace all key off the same number.

### Requirements

**Conditional routing and structured output**

- R1. A plain edge carrying a `when` rule is traversed only when that rule evaluates true against current shared state.
- R2. An agent node can declare an output schema. Its response is validated against that schema and the **parsed value** — not raw text — is what lands in state. A response that does not conform fails the run.
- R3. A node whose out-edges all carry `when` guards, none of which evaluate true, fails loudly, naming the node, each rule, and the values read. An empty frontier means "this node has no out-edges", never "no rule matched".
- R4. A fix node receives the review node's findings as its input.

**Loops and bounds**

- R5. A run can loop: a fix→review cycle re-enters a node.
- R6. A loop terminates either by converging or by hitting an attempt bound declared on the re-entered node, semantically distinct from `max_steps`.
- R7. Hitting the attempt bound produces a distinct terminal run status, distinguishable in the trace from step-budget exhaustion and from failure. Never a hang, never a silent give-up.

**Write capability and enforcement**

- R8. A topology can declare an agent node write-capable.
- R9. The engine enforces a declared tool policy for every write node — an allowlist, not unrestricted access.
- R10. A write node's filesystem writes are confined to the run's workspace by an OS-enforced boundary the agent cannot opt out of — not by tool policy alone.
- R11. Network access is denied to agent nodes unless the topology declares the domains a node may reach.
- R12. As a secondary backstop, the run asserts the consumer's checkout is untouched, and names the offending node if it is not.

**Workspace and blast radius**

- R13. Every node in a run executes inside a single run-owned workspace, isolated from the consumer's checkout.
- R14. The workspace is created from a declared base ref, defaulting to the current branch's tip. `start` reports the ref it resolved.
- R15. Concurrent runs do not collide with each other, including concurrent runs against the same consumer repo.
- R16. The run never modifies the consumer's checked-out working tree or index. Refs and workspace metadata are the run's declared footprint.
- R17. graph-bro never commits into the consumer's existing history and imposes no history shape on it.
- R18. The run never pushes and never opens a PR.
- R19. A failed or killed run leaves the consumer's working tree and index untouched.

**Commits, delivery, and recovery**

- R20. The engine owns commit granularity: exactly one commit per attempt, regardless of what the agent does inside the workspace. Agent-created commits are folded into the attempt's commit, not failed on.
- R21. Every attempt is committed, including a failing one, and stays reachable for forensics.
- R22. A completed run hands back committed work on a run-owned branch the operator reviews with ordinary git.
- R23. A run is resumable after a crash or kill: resume restores the workspace to the last committed attempt and re-enters deterministically.

**Observability**

- R24. The trace answers, from the consumer repo, what the run did: each attempt, each node's structured output, and which branch the router took — with the rule it evaluated and the values it read.
- R25. The trace states why the run stopped — converged, attempt bound hit, or failed — and the three are distinguishable.
- R26. Token usage per attempt is visible, with reported USD alongside, so a run that burns four attempts reads as a usage event.

**Showcase**

- R27. graph-bro ships one generic example demonstrating conditional routing and a self-correcting loop, naming no consumer, as `examples/fanout-read-join/` does for slice 1. Its smoke test proves the loop iterates at least once — an example that converges on the first attempt demonstrates routing, not self-correction.

### Key Flows

- F1. Run converges
  - **Trigger:** The implement node completes.
  - **Actors:** A2, A3, A4
  - **Steps:** Engine commits the attempt in the workspace; the review node returns a schema-validated structured output; the `when` rule on the pass edge evaluates true and the routing decision is traced; the run hands back its branch.
  - **Outcome:** Committed, reviewed work on a run-owned branch.
  - **Covered by:** R1, R2, R13, R20, R22, R24

- F2. Run self-corrects, then hits its bound
  - **Trigger:** The review node returns a failing structured output.
  - **Actors:** A2, A3, A4
  - **Steps:** Findings route to the fix node as input; the fix node writes in the workspace; the engine commits the attempt; review re-enters; the cycle repeats until the output routes to pass or the node's `max_attempts` is reached.
  - **Outcome:** Either convergence, or the run halts as `not_converged` with every attempt committed and visible in the trace.
  - **Covered by:** R4, R5, R6, R7, R21, R24, R25

- F3. Run dies mid-write, operator resumes
  - **Trigger:** The engine process is killed, or a node errors, mid-attempt.
  - **Actors:** A1, A2
  - **Steps:** Engine halts fail-fast; the partial attempt is committed to a side ref; the consumer's checkout is untouched throughout; the operator reads the trace, then resumes. Resume hard-resets the workspace to the last committed attempt and re-enters.
  - **Outcome:** The failure is diagnosable from `git log` without re-running anything, and the run continues from its last good attempt rather than from scratch.
  - **Covered by:** R16, R19, R21, R23, R25

- F4. Write node attempts to escape
  - **Trigger:** A write node issues a write outside the workspace, whether through a file tool or a shell command.
  - **Actors:** A2, A3
  - **Steps:** The OS-level boundary refuses the write; the run's secondary assertion confirms the consumer's checkout is untouched.
  - **Outcome:** The escape does not occur, rather than being detected after the fact.
  - **Covered by:** R10, R12, R13

### Acceptance Examples

- AE1. **Covers R1.** Given a topology with two `when`-guarded edges out of one node, when shared state satisfies exactly one rule, then only that edge's target activates.
- AE2. **Covers R2.** Given an agent node declaring an output schema, when the node returns a conforming response, then the parsed object — not its serialized text — is readable at the node's `output_key` by dotted path; and when it returns a non-conforming response, then the run fails naming the node and the violation.
- AE3. **Covers R3.** Given a node whose every out-edge carries a `when` guard, when state satisfies none of them, then the run fails naming the node, each rule, and the values read — and does not report `dead_end`.
- AE4. **Covers R6, R7.** Given a loop whose review never passes, when the re-entered node's attempt bound is reached, then the run halts in a status distinguishable in the trace from `max_steps` exhaustion and from failure.
- AE5. **Covers R10.** Given a write node that attempts to write outside the workspace via a shell command, when the node runs, then the write does not occur.
- AE6. **Covers R11.** Given a write node whose topology declares no network domains, when the node attempts a network request, then it is refused.
- AE7. **Covers R13, R14, R16.** Given a run started from a consumer repo with a dirty working tree, when the run executes, then every node reads the declared base ref's committed content, and the consumer's working tree and index are byte-identical afterwards.
- AE8. **Covers R20.** Given a write node that creates its own commits inside the workspace, when the attempt completes, then the run branch contains exactly one commit for that attempt.
- AE9. **Covers R21, R23.** Given a run killed mid-attempt, when the operator inspects the run branch, then the partial attempt is reachable as a commit; and when the operator resumes, then the workspace re-enters from the last committed attempt.
- AE10. **Covers R18.** Given a completed run, when the consumer's remotes are inspected, then nothing was pushed and no PR was opened.
- AE11. **Covers R27.** Given graph-bro's shipped engine and example graphs, when searched for any consumer name or consumer-domain term, then none appears; and the example's smoke test asserts the loop ran more than one attempt.

### Milestone acceptance bar

The Acceptance Examples above are per-requirement. This is the milestone-level bar, and it is
deliberately a single falsifiable statement:

> **An unattended run against sensei#23 that takes at least one fix→review iteration and hands back a
> branch the operator would merge.**

sensei#24 is the mechanics smoke test on the way there — bounded, explicit acceptance criteria,
existing tests to update, tiny blast radius.

Two things this bar is shaped to avoid:

- **A run that converges on the first attempt proves routing, not self-correction**, and is
  indistinguishable from a graph with no loop in it. Requiring a real iteration is what makes the
  milestone's headline primitive actually execute against a live model. The risk this guards against
  is a reviewer that rubber-stamps rather than discriminates — no unit test surfaces that, only a real
  run does.
- **Speed is explicitly not a gate.** Single-track graph-bro is slower than a `goal` session on a
  single feature; that is stated in the Problem Frame and accepted. "Did I reach for it instead of a
  session" would fail for reasons that say nothing about whether this milestone works.

sensei#31 stays out: its open questions are human judgment, which is the Human-checkpoint track's
residue, and it needs triage first.

### Scope Boundaries

- **Fan-out write lanes** — N concurrent write lanes on one feature, the merge of their results, and post-merge review. Deferred to slice 2b, per Key Decisions: it requires subgraph instancing and per-instance state scoping, which are a new engine primitive rather than an extension of slice 1's fan-out.
- **Push, PR-opening, and any capability-declaration grammar** — dropped, per Key Decisions.
- **Cost ceilings and budget enforcement** — dropped; runs are subscription-backed.
- **The front half of the operator's workflow** — ideation, brainstorming, and grilling. Each needs answers from the operator, which means the batched-interview primitive owned by the Human-checkpoint track. Nothing in this milestone may bake in an interrupt-shaped primitive that would fight the batch-shaped constraint that track carries.
- **Human-in-the-loop of any kind.** This milestone is unattended between start and results; review is an agent node.
- **Calibration** — override mining, facts, graduation to headless. Shares the trace, proceeds independently.
- **Topology map** (graph-bro#10) — separate and independently valuable.
- **`on_error` routing** — deferred again, per Key Decisions.
- **Review panels** — expressible with existing primitives; nothing ships to support or prevent them.
- **Container-based isolation** — rejected in favor of git-native isolation, per Key Decisions.
- **Design and ADRs** — this artifact is requirements only. The grill produced three ADR candidates (see Sources); a later session determines the rest of the how.

### Dependencies and Assumptions

- Claude Code v2.1.220 provides `--json-schema` (structured output via a `StructuredOutput` tool call), a settings-level Bash sandbox with filesystem and network policy, `--disallowedTools`, `--tools`, and `--settings`. R2, R10, and R11 depend on these; a backend without them cannot satisfy those requirements.
- The Bash sandbox applies **only to the Bash tool**. Read/Write/Edit and MCP tools are governed separately, by `--allowedTools`/`--tools` and by cwd with no `--add-dir`. R10 needs both halves, not just the sandbox.
- Slice 1's prompt-template interpolation is the carrier for R4, and structured output makes it sufficient: with a parsed object at `output_key`, a fix node's prompt reads `{{ verdict.findings }}` and needs no new mechanism.
- `mergeWrites` assigns write keys verbatim and flat, while read paths are dotted and traverse nesting — so a parsed object at a flat `output_key` is addressable by `when` rules and prompt tokens without change.
- `runs.status` is unconstrained `TEXT NOT NULL` (`001_init.sql:7`) and `resume` gates on owner-pid liveness and topology path only, never on status (`cli/resume.ts:34-45`) — so R7's distinct terminal status needs no migration and no resume change.
- Cost and token capture (ADR-0009) is implemented end-to-end today, so R26 is an aggregation concern rather than new instrumentation.
- The per-node hard timeout is **idle**-based, not wall-clock (`claude-code.ts:125` compares `Date.now() - lastLineAt`), so a long-running write node that streams continuously is not killed by the existing 10-minute bound.
- The boundary invariant is scoped to the shipped engine and example graphs, matching slice 1's acceptance test. ADRs naming the validating consumer as the driver of a decision are inside that line.
- The solo-operator trust model from KTD-8 continues to hold: read scoping means no-mutation-outside-workspace, not repo-scoped reads.
- Consumer repos are git repositories. Git-native isolation has no fallback for non-git consumers.

### Outstanding Questions

**Deferred to planning**

- **On the critical path: live-probe the `--json-schema` result envelope.** `envelope.ts:33` pins `result: z.string()`. If structured-output mode returns an object there, `parseEnvelope` throws, the catch at `claude-code.ts:110` swallows it, and the node returns a synthetic `isError` with empty text — a silent failure at the foundation of R2. Settle this the way KTD-8 settled the read-only tool probe (`read-only-policy.ts:5-12`): a live run against the installed CLI, with the finding recorded in a comment.
- Whether the workspace is a `git worktree` or a `git clone --shared`. Worktree is what container-use does and is simpler, but writes `.git/worktrees/<name>` into the consumer's `.git` and needs pruning; a shared clone touches the consumer's `.git` less but carries the source-gc hazard and needs a local push for handback. R15 and R16 constrain both, and neither is ruled out.
- Whether a resumed run continues the attempt count or restarts it — small, but it decides whether `resume` can launder a run past its bound.
- How the per-node settings JSON is synthesized and delivered, and how much of it is topology-declared versus engine-fixed.
- Whether a write node's tool allowlist is a fixed engine-owned set or declared per node.
- How `lintJoinDesync` should behave once routing executes. It currently warns whenever a join source is only conditionally reached and advises inserting a funnel node — advice that is wrong for a loop. Moot for single-track (no joins), but it will bite slice 2b.

### Sources

- graph-bro#14 — origin issue, the R1-R12 and open-questions list this document supersedes.
- Grilling session, 2026-07-25 — the eleven decisions recorded above, and the source reads that produced them.
- `docs/plans/2026-07-24-001-feat-engine-slice-1-plan.md` — the deferral record. KTD-7 (routing), KTD-8 (read-only command shape and the stated write-node inversion), KTD-10 (the tree-clean backstop that inverts here), KTD-12 (per-instance identity through the barrier).
- `src/topology/schema.ts` — `read_only: z.literal(true)` and the `WhenRule` grammar; both compile walls.
- `src/engine/loop.ts` — `transition()` at :211-257 (plain-edge activation identity, the fan-out arm/arrive path), the `dead_end` return at :379, and the `itemKey`-gated pending-write commit at :308.
- `src/engine/reducers.ts` — `StateConflictError` at :92, the flat-state constraint behind the lane deferral.
- `src/engine/barrier.ts` — `reset()` and `armSource()`, the re-arm machinery R5 builds on.
- `src/executor/read-only-policy.ts` — the allowlist and tree-clean assertion that R9 and R12 invert.
- `src/executor/envelope.ts` — `result: z.string()`, the pin the `--json-schema` probe must check.
- `claude --help` (v2.1.220) and the Claude Code settings documentation — `--json-schema`, `--settings`, `--disallowedTools`, `--tools`, and the `sandbox` property's Bash-only scope.
- `docs/adr/0006-fail-fast-branch-failure.md`, `docs/adr/0007-readonly-enforcement-permission-mode.md`, `docs/adr/0009-capture-cost-data-from-inception.md`, `docs/adr/0010-single-claude-code-backend-behind-seam.md`.
- Dagger container-use — worktree-plus-branch-per-agent isolation with auto-commit and git-native review; the design this milestone mirrors without taking the dependency.
- Reported failure data on shared-working-tree parallel agents: roughly a quarter of intended changes silently lost across five concurrent agents on one checkout, with the build still passing. The evidence behind isolating at all; it applies to slice 2b's lanes as much as to this slice's single track.

### ADR candidates from the grill

Three decisions meet the bar of hard to reverse, surprising without context, and the result of a real trade-off:

1. **Sandbox-enforced write isolation.** Amends ADR-0007's enforcement story and widens ADR-0010's narrow executor seam from argv to synthesized settings JSON.
2. **Engine-owned commit granularity, with every attempt committed including failures.** Imposes a history shape on the run branch and is the forensics contract.
3. **Topology-declared output schemas rather than an engine-owned verdict type.** The non-obvious one: a future reader will ask why an engine built for review loops has no verdict type, and the answer is the boundary invariant.

The attempt bound's placement and the unmatched-router failure are settled above but do not clear the bar — they belong in the plan, not in `docs/adr/`.
