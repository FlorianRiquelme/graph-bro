# ADR-0007: Read-only nodes enforced via Claude Code's permission system

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context slice:** Engine Slice 1 — resolves the "enforcement mechanics are planning's choice" clause of R7.

## Decision

A `read_only: true` node's Claude Code subprocess is spawned with a **read-only tool policy**: read/search/analysis tools allowed (Read, Grep, Glob, read-only Bash), mutation tools denied (Edit, Write, NotebookEdit, write/exec Bash). Enforcement is **prevention at the tool-permission level**, using Claude Code's own permission system — not prompt-only trust and not post-hoc detection.

The exact flag mechanics (`--disallowedTools`/`--allowedTools` vs `--permission-mode` vs settings deny rules) are resolved in planning against current Claude Code docs; this ADR fixes the *mechanism* (permission-based prevention), not the flag spelling.

## Rationale

Corrects an over-broad reading of the standing "bypass-permissions / don't design permission rules" convention: that convention is scoped to **supervised interactive** work, where the human catches mutations. **Headless engine nodes have no human in the loop**, so the engine must enforce read-only dependably — permission-based prevention is the correct, dependable lever (operator's explicit direction). See memory `permission-mode-supervised-vs-headless`.

This also cleanly splits from §16's guidance to treat `--dangerously-skip-permissions` as a headless hang-mitigation: that applies to *write-capable* nodes (avoid permission-prompt hangs). A read-only node has nothing to prompt for, so it uses a restrictive policy and never skips permissions.

## Consequences

- **Prevention, not detection:** a read-only node cannot mutate the repo in the first place, so concurrent read-only fan-out branches sharing one cwd (ADR-0005) are genuinely safe — no need for per-branch worktree sandboxes in slice 1.
- **Optional loud-fail backstop (defense-in-depth):** a near-free `git status --porcelain` assertion at the fan-out boundary can turn any prevention gap (tool-policy hole, a Bash command that slipped through) into a loud failure, matching the loud-fail convention. Kept as a cheap backstop, subordinate to the permission-mode primary. *(Confirm/drop during planning.)*
- **Write-capable node types (future)** invert the policy: broad tool access + `--dangerously-skip-permissions` to avoid headless hangs, with mutation isolation handled by worktree-per-node (§16) rather than a permission policy.
