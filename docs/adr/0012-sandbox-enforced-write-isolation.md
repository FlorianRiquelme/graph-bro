# ADR-0012: Write-node blast radius enforced by an OS-level sandbox

- **Status:** Accepted
- **Date:** 2026-07-25
- **Context slice:** Engine Slice 2 — resolves R10/R11. Extends ADR-0007's enforcement story to write-capable nodes and widens ADR-0010's executor seam.

## Decision

A write-capable node's Claude Code subprocess is spawned under an **OS-enforced sandbox** the agent cannot opt out of: the engine synthesizes per-node settings JSON (`sandbox.enabled`, `allowUnsandboxedCommands: false`, filesystem writes scoped to the run's workspace, network denied unless the topology declares domains) and passes it via `--settings`. Tool policy (`--allowedTools`/`--tools`, no `--add-dir`) governs the non-Bash tools, which the sandbox does not cover. The consumer-checkout-clean assertion from ADR-0007 is retained as a **secondary** backstop.

As in ADR-0007, this fixes the *mechanism* — prevention at the OS level, layered under prevention at the tool-permission level — not the exact settings spelling, which planning resolves against the installed CLI.

## Rationale

ADR-0007 established the two-layer shape for read-only nodes: permission-based prevention primary, `git status --porcelain` detection secondary. Its own closing consequence anticipated that write-capable nodes would invert the policy and rely on worktree isolation instead. That inversion turns out to need a stronger primary than a tool allowlist, for a reason specific to writes: **there is no `git status --porcelain` equivalent for "everywhere else on the filesystem."** Read-only enforcement can fall back on detection because *clean* is checkable in one command. "Did not write outside this directory" is not, short of diffing the whole filesystem. Without an OS boundary, R10 could be asserted but never met.

This also withdraws a rationale carried in from the brainstorm, which rejected path-scoped write permissions on the grounds that "a write node needs Bash to run tests, and shell access defeats path allowlists." Claude Code's Bash sandbox exists precisely to close that hole. The premise was false against v2.1.220, and decisions resting on it were re-derived.

Consistent with the standing convention that supervised interactive work needs no permission design but **headless invocations must have their constraints enforced by the orchestrator** — see memory `permission-mode-supervised-vs-headless`. A write node runs with no human able to approve anything, so the engine is the only thing that can enforce.

## Considered options

- **Tool allowlist and post-hoc detection only.** Cheapest, no new dependency on Claude Code's settings shape. Rejected: leaves R10 unmet — a node writing to `~/.ssh` or a sibling repo is undetected, and the acceptance test could only cover whichever path happens to be checked.
- **Container-based isolation (Dagger container-use).** Rejected separately: it is an MCP server the *agent* calls, inverting ADR-0007's premise that the orchestrator enforces because the agent cannot be trusted to. Isolation an agent opts into is isolation an agent can skip. Also a hard Docker dependency, against ADR-0004's no-daemon posture.

## Consequences

- **ADR-0010's "narrow executor seam" widens.** The engine now generates Claude-Code-specific settings JSON, not only argv. A second backend gets meaningfully harder to add — accepted, since ADR-0010 already committed to one backend and treats the seam as narrow-by-intent rather than portable-by-design.
- **The engine acquires a platform assumption.** Sandboxing needs seatbelt (macOS) or bubblewrap (Linux).
- **The sandbox covers only the Bash tool.** Read/Write/Edit, WebFetch, and MCP tools are unaffected by it and remain governed by tool policy and cwd. Both halves are required; neither alone satisfies R10.
- **Network becomes a topology-declared surface.** With `allowUnsandboxedCommands: false` and network denied by default, any test command that fetches will fail until its domains are declared. This is new authoring surface introduced by this decision.
- **Prevention, not detection, for the primary case:** an escape attempt does not occur, rather than being caught afterwards — so the acceptance test asserts absence of the write, not presence of an error.
