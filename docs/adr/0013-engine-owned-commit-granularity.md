# ADR-0013: The engine owns commit granularity; every attempt is committed, including failures

- **Status:** Accepted
- **Date:** 2026-07-25
- **Context slice:** Engine Slice 2 — resolves R20/R21/R23, and supersedes the slice-2 brainstorm's "agent nodes get no git-mutating tools."

## Decision

The engine produces **exactly one commit per attempt** on the run-owned branch, regardless of what the agent does inside the workspace. It records the workspace's HEAD before dispatching a write node and after it returns; if HEAD moved, the agent committed, and those commits are **squash-folded** into the engine's single attempt commit rather than failing the run.

**Every attempt is committed, including a failing one.** A run that dies or errors mid-attempt has that partial attempt committed to a side ref before the workspace is hard-reset to the last good commit. `resume` re-enters from there.

## Rationale

The brainstorm's rule was "agent nodes get no git-mutating tools," justified by commit-history legibility — so `git log` answers "which attempt fixed it." A tool allowlist cannot deliver that. `--disallowedTools "Bash(git commit:*)"` matches on the command string and is defeated by `sh -c`, by a script, or by a test runner with a git hook. Stated as a requirement it read as a guarantee the implementation could not make.

Under ADR-0012 the agent's commit is already *contained* — it lands in the run's own workspace, not the consumer's history — so containment is not what the rule protects. What it protects is per-attempt history, and a HEAD comparison secures that dependably where an allowlist does not: detection cannot be talked around. Folding rather than failing follows from the milestone's premise: failing an unattended run over something harmless the engine could absorb defeats the point of it being unattended.

Committing failed attempts resolves a collision the brainstorm did not notice. Retaining a workspace "for forensics" and re-entering it on `resume` are incompatible — resume mutates the evidence, and re-running a write node against a half-written tree is nondeterministic besides. Committing the failure makes both work from one mechanism: resume becomes deterministic (hard-reset to a known commit), and the forensic record moves from a temp directory the operator must remember not to disturb into `git log`.

## Considered options

- **Declared policy only** — deny-list git mutation, don't check. Rejected: leaves the per-attempt history claim unbacked.
- **Detect and fail** — same HEAD comparison, but a moved HEAD fails the run. Rejected: same cost as folding, worse behavior, for an act that is harmless under ADR-0012's containment.
- **Do not resume write runs** — fail-fast, retain the workspace, operator restarts. Rejected: abandons slice 1's crash-safety on exactly the runs where it is worth most, and burns every completed attempt of a loop that dies late.
- **Resume by hard-resetting without committing the failure.** Rejected: deterministic, but destroys the uncommitted residue — the single most informative forensic artifact.

## Consequences

- **The run branch has an imposed history shape:** one commit per attempt, in order, including failures. This is graph-bro imposing shape on *its own* branch only; the consumer's existing history remains untouched and unshaped, per R17.
- **"Workspaces are retained for forensics" is no longer the evidence contract.** The commits are. Retention becomes incidental, and the workspace is safe to reuse.
- **Attempt is one identifier across three systems** — the loop bound, the commit message, and the trace all key off the same activation count. This is the main reason the attempt bound sits on the re-entered node rather than the back-edge.
- **Squash-folding loses the agent's own commit messages.** Accepted; they are recoverable from the trace, which records each node's output.
- Whether a resumed run continues or restarts the attempt count is left to planning — it decides whether `resume` can launder a run past its bound.
