# ADR-0002: CLI distributed as a global command on PATH (no consumer checkout)

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context slice:** Engine Slice 1 — resolves R11 ("usable from the consumer repo with no graph-bro checkout") and the "CLI is the only slice-1 surface" Key Decision.

## Decision

graph-bro ships an npm package exposing a `graph-bro` bin, installed **machine-globally on PATH**. The consumer (sensei) invokes it as `graph-bro <cmd>` from its own working directory. For slice 1 this is `npm link` from the graph-bro checkout — **no registry publish** (public npm or private) yet.

## Rationale

"No graph-bro checkout" is interpreted as: the consumer repo does not clone graph-bro into its tree or take a path/git-submodule dependency on it — the CLI is simply a command on PATH, invocable from any cwd. A machine-global install satisfies this for a solo operator with both repos local on one machine; we are not being asked to reach a machine that has never installed graph-bro.

A registry publish is deferred: the package/CLI surface is not stable mid-first-slice, and publishing a showcase project prematurely fixes an interface we're still discovering.

## Consequences

- The topology is passed **by file path** (`graph-bro start ./mining-topology.json --input …`): authored in sensei, read by the CLI. Keeps the R1/R2 boundary clean — graph-bro ships no consumer-named artifact.
- Rejected: **path/git dependency into the consumer** (violates R11's intent — a checkout by another name) and a **standalone compiled binary** (`bun build --compile`/`pkg` — heavier build, no slice-1 advantage over `npm link`).
- Pairs with a machine-global run-state location (next ADR) so status/tail/result resolve a run by id from any cwd.
- When a registry publish does happen, nothing about the invocation contract changes (`graph-bro <cmd>` is identical whether linked or installed) — so this is not rework, just a later packaging step.
