# ADR-0012: Write-node blast radius enforced by an OS-level sandbox

- **Status:** Accepted
- **Date:** 2026-07-25
- **Context slice:** Engine Slice 2 — resolves R10/R11. Extends ADR-0007's enforcement story to write-capable nodes and widens ADR-0010's executor seam.

## Decision

A write-capable node's Claude Code subprocess runs under **five layered enforcement mechanisms**
(engine slice 2 planning, KTD-3), not two: (1) the auto-deny (`dontAsk`) permission mode, so anything
not explicitly allowed is refused without blocking the run; (2) a **path-scoped** allow rule
(`Edit(/**)`, anchored to the canonicalised workspace as cwd) confining the file tools — a bare tool
name carries no path scope, which is the exact defect an earlier version of this design was falsified
by probe over; (3) deny rules — binding in every permission mode — for the workspace's own
CLI-configuration paths and the built-in web tools; (4) the OS sandbox (`sandbox.enabled`,
`sandbox.failIfUnavailable`) for the Bash tool's filesystem and network reach, with topology-declared
domains feeding its network allowlist; (5) strict MCP configuration (`--strict-mcp-config`, no
`--mcp-config`), so the operator's own user-scoped MCP servers never load. **The layers are not
independent** — layer 1's mode is what gives layers 2 and 3 any force at all. Tool policy governs the
non-Bash tools, which the sandbox does not cover. The consumer-checkout-clean assertion from ADR-0007
is retained as a **secondary** backstop, now comparing against a baseline captured at run start rather
than asserting cleanliness (KTD-11), since a run may start from a deliberately dirty consumer checkout.

As in ADR-0007, this fixes the *mechanism* — prevention at the OS level, layered under prevention at
the tool-permission level — not the exact settings spelling, which planning resolves against the
installed CLI.

## Rationale

ADR-0007 established the two-layer shape for read-only nodes: permission-based prevention primary, `git status --porcelain` detection secondary. Its own closing consequence anticipated that write-capable nodes would invert the policy and rely on worktree isolation instead. That inversion turns out to need a stronger primary than a tool allowlist, for a reason specific to writes: **there is no `git status --porcelain` equivalent for "everywhere else on the filesystem."** ~~Read-only enforcement can fall back on detection because *clean* is checkable in one command.~~ "Did not write outside this directory" is not, short of diffing the whole filesystem. Without an OS boundary, R10 could be asserted but never met.

**Corrected 2026-07-25 (Engine Slice 2 review, finding #3).** The struck sentence was wrong, and it was load-bearing: it is the entire reason this ADR left read-only nodes on detection alone. *Clean* is **not** checkable in one command. `git status --porcelain` is scoped to the node's working tree, so it cannot see a write that lands outside it — and a read-only node is granted `Bash(git diff *)` and `Bash(git show *)`, both of which accept `--output=<path>`, verified writing a file anywhere the process can reach. The allowlist string cannot express "this flag of this allowed command is forbidden"; only the OS layer can. The distinction this ADR drew between write and read-only enforcement therefore does not hold, and read-only nodes now get the same OS sandbox with an empty filesystem write scope (see Consequences).

This also withdraws a rationale carried in from the brainstorm, which rejected path-scoped write permissions on the grounds that "a write node needs Bash to run tests, and shell access defeats path allowlists." Claude Code's Bash sandbox exists precisely to close that hole. The premise was false against v2.1.220, and decisions resting on it were re-derived.

Consistent with the standing convention that supervised interactive work needs no permission design but **headless invocations must have their constraints enforced by the orchestrator** — see memory `permission-mode-supervised-vs-headless`. A write node runs with no human able to approve anything, so the engine is the only thing that can enforce.

## Considered options

- **Tool allowlist and post-hoc detection only.** Cheapest, no new dependency on Claude Code's settings shape. Rejected: leaves R10 unmet — a node writing to `~/.ssh` or a sibling repo is undetected, and the acceptance test could only cover whichever path happens to be checked.
- **Container-based isolation (Dagger container-use).** Rejected separately: it is an MCP server the *agent* calls, inverting ADR-0007's premise that the orchestrator enforces because the agent cannot be trusted to. Isolation an agent opts into is isolation an agent can skip. Also a hard Docker dependency, against ADR-0004's no-daemon posture.

## Consequences

- ~~**ADR-0010's "narrow executor seam" widens.** The engine now generates Claude-Code-specific settings JSON, not only argv.~~ **Corrected by KTD-12 (Engine Slice 2 planning):** the seam itself does not widen to carry settings JSON — it stays narrow, gaining only a workspace root, permitted domains, a declared output schema, and a named capability discriminant (`NodeCapability`, replacing the old `readOnly: boolean`). **Widened further by this fix set:** `RunOptions` (`src/executor/executor.ts`) also carries `consumerRepoPath`, so the read-only backstop can pin its `git status --porcelain` check to the consumer repo rather than the agent-writable workspace; and the read-only policy itself (`src/executor/read-only-policy.ts`) imports `resolveWorkspaceGitTarget`/`runWorkspaceGit` from `src/workspace/commit.js`, reaching into workspace git internals that the seam previously kept out of the policy layer. Settings synthesis (the five layers above) stays entirely behind the seam, inside the Claude Code backend (`src/executor/write-policy.ts`, `claude-code.ts`) — a second backend still only needs to honor the same narrow intent, not reproduce Claude-Code-specific settings JSON. One genuine narrowing does belong on the seam: a backend must be able to answer whether an OS boundary is available, since a write run refuses to start without one (KTD-12).
- **The engine acquires a platform assumption.** Sandboxing needs Seatbelt (macOS) or bubblewrap + socat (Linux/WSL2); native Windows has none. ~~A write run~~ **Any run with an agent node** checks this before creating a workspace and refuses to start, naming the reason, rather than running unconfined. *(Widened 2026-07-25 by the read-only correction above: the precheck moved from write-bearing runs to any agent-bearing run, so a pure read-only topology on a bare Linux box that worked before now refuses to start. A real regression in reach, accepted for the boundary it buys — macOS is always available, and CI installs both packages.)*
- **Read-only nodes are OS-confined too** *(added 2026-07-25, finding #3).* They get the same sandbox block with `filesystem.allowWrite: []` and no allowed domains. Two caveats, both verified by live probe against CLI v2.1.220 rather than assumed: an empty write scope does **not** mean "no writable paths" — the CLI retains its default writable set, so the node's own cwd and the temp directory stay writable, and only paths outside that set (a `$HOME` target, a sibling repo) are refused. And it restricts writes only: `Read`/`Grep`/`Glob` stay unscoped. So a read-only node can still write to `$TMPDIR`, which is outside the workspace and invisible to `git status --porcelain` — the residual this correction does not close. What it does close is the arbitrary-path escape via an allowed command's flag, which is what made detection-only untenable.
- **The sandbox covers only the Bash tool.** Read/Write/Edit, WebFetch, and MCP tools are unaffected by it and remain governed by layers 2/3/5 above. All layers are required; none alone satisfies R10.
- **Network becomes a topology-declared surface.** With network denied by default, any shell command that fetches will fail until its domains are declared. This is new authoring surface introduced by this decision.
- **Prevention, not detection, for the primary case:** an escape attempt does not occur, rather than being caught afterwards — so the acceptance test asserts absence of the write, not presence of an error.
- **A synthesized minimal environment replaces inheritance for write nodes** (KTD-4): the subprocess gets an allowlisted set of env vars (`PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM`), not the engine's own environment, so a secret sitting in the engine's process never reaches a write node.
