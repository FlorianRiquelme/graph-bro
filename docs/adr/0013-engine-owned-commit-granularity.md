# ADR-0013: The engine owns commit granularity; every attempt is committed, including failures

- **Status:** Accepted
- **Date:** 2026-07-25
- **Context slice:** Engine Slice 2 — resolves R20/R21/R23, and supersedes the slice-2 brainstorm's "agent nodes get no git-mutating tools."

## Decision

The engine produces **exactly one commit per attempt** on the run-owned branch, regardless of what the agent does inside the workspace. ~~It records the workspace's HEAD before dispatching a write node and after it returns.~~ **Corrected during implementation (KTD-7, engine slice 2):** the boundary is anchored to the *re-entered, bounded* node's next activation, not to each write node individually — a loop body holding two write nodes would otherwise produce two commits for one attempt, desynchronising the one number the bound, the commit message, and the trace all share. Expressed as a before-invocation hook on the bounded node (commit whatever the workspace holds, then invoke): the engine records HEAD, compares it after the hook's own `git add -A` + `reset --soft` + `commit` sequence; if HEAD moved or the tree was dirty, the agent's own commits and any leftover edits are **squash-folded** into the engine's single attempt commit rather than failing the run. Because the hook only fires on re-entry, a **teardown commit runs on every terminal path** as well, catching the attempt a run that converges, fails, or hits its bound on its very first pass would otherwise leave uncommitted — and catching the (only) attempt in a topology with no bounded node at all, which never fires the hook in the first place.

**Every attempt is committed, including a failing one.** A run that is killed mid-attempt has that partial, uncommitted state preserved as a reachable commit under a side ref (not folded into the run branch — it was never a completed attempt) before the workspace is hard-reset to the last commit the engine actually made. `resume` re-enters from there, after first re-attaching the workspace to its run branch (a retained workspace's HEAD is left detached so the branch can be checked out elsewhere while the directory exists — resume must undo that before committing anything, or every post-resume attempt lands on the detached HEAD instead).

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
