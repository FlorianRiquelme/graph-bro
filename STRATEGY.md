---
name: graph-bro
last_updated: 2026-07-24
---

# graph-bro Strategy

## Target problem

Running many parallel coding-agent workflows, I am the message bus: every handoff
and every mid-flight question routes through my attention serially, so parallelism
is capped by my context-switching capacity, not agent capacity. The crux: agent
work genuinely needs human judgment at unpredictable points, so the routing can't
simply be deleted — the judgment has to be front-loaded or batched.

## Our approach

Most agent questions (85–90% of grill recommendations in practice) are answerable
from durable per-repo context — ADRs, conventions, docs — built once per repo and
accumulated after that. So the bet: agents resolve their own defaults from that
context, and human judgment is reserved for the small residue, delivered as
batched, dependency-aware interviews at graph checkpoints (dictate once, answers
cascade) — never as one-by-one interrupts. Unattended between checkpoints; the
residue shrinks as calibration data accumulates.

## Who it's for

**Primary:** Me (Florian) — a solo operator running a fleet of coding agents
across parallel workstreams; client or personal, the type of work doesn't matter.
I'm hiring graph-bro to keep several feature builds in flight simultaneously
without serving as the message bus. Greenfield bootstrapping stays 100% attended
and out of scope.

**Secondary:** Public showcase — a working, opinionated answer to "everyone talks
about graph engineering; here's how you actually build it." Training material for
colleagues, not a general-purpose tool.

## Key metrics

- **Override rate on auto-resolved decisions** — of the decisions agents answered
  from context, the % I later reverse; measured in the calibration ledger
  (graduation threshold: below `T` across `N` runs → headless).
- **Redundant escalations** — surfaced questions that were already answerable from
  existing facts, ADRs, or a previous run; tagged during the batch interview.
  Novelty-immune: new territory legitimately escalates, known ground shouldn't.
- **Human touches per shipped feature** — distinct interventions (interviews,
  unblocking, manual fixes) from kickoff to merged PR; measured from the engine
  event log.
- **Sustained concurrent workstreams** — features genuinely in flight at once
  without dropped balls; measured from engine run states.
- **Rework rate** — % of graph-declared-done work I have to correct or redo;
  the guard metric, measured from follow-up fix commits and review findings.

## Tracks

### Engine

The orchestration substrate: state channels, checkpoints, joins, CLI-agent nodes,
crash-safe resume, and loop primitives that let a run self-correct (review→fix,
retry-with-feedback) before anything reaches me.

_Why it serves the approach:_ Removes the message bus — dependable enough to keep
feeding features in.

### Human checkpoint

The batched, dependency-aware interview: question batching, dictate-once
resolution, answers cascading to collapse downstream questions, redundancy tagging.

_Why it serves the approach:_ The judgment residue arrives on my terms, not as
interrupts.

### Calibration & earned trust

Override mining → facts store → per-repo graduation to headless, by the numbers
(see `docs/design/calibration-loop.md`). Trust isn't a feeling — it's the
override rate staying under threshold.

_Why it serves the approach:_ The residue shrinks over time; autonomy is earned,
never given by default.

### Agent-legible observability

Run history as a first-class product surface, designed for an agent (Opus/Fable
session) as the primary reader. "What happened on the way" must be answerable
from the trace alone — and from consumer repos: an agent shipping features
through the graph in another repository gets the right logs and run context
without being inside the graph-bro repo. Cost accounting (vs. the "what would a
simple session have cost" baseline) rides on the same event log.

_Why it serves the approach:_ Instrumented iteration, cost control, and
debuggability-by-agent — the system can't earn trust if I can't see what it did.

## Not working on

- **Greenfield bootstrapping** — creating the initial context/guardrails for a
  fresh repo is 100% attended human work; the graph consumes that context, it
  doesn't create it.
- **Generalization for other users** — deliberately opinionated around my
  workflow (compound-engineering skills, grill-with-docs); a later milestone
  only if real demand shows up.
- **Graph memory / knowledge graphs / GraphRAG as a product direction** —
  graph-bro orchestrates work. Retrieval over the observability logs may become
  useful down the line; open to it, but that's a separate, future effort.

## Marketing

**One-liner:** Everyone talks about graph engineering — this is how you actually
build it.
