---
title: Engine Slice 2 Fix Set — Round 2 Review Findings
type: findings
date: 2026-07-25
topic: engine-slice-2-round-2-findings
reviewed: bb6fba1..aa277ce (the 21-finding fix set, PR #15)
execution: none
---

# Engine Slice 2 Fix Set: Round 2 Review Findings

**This is a findings record, not a plan.** It exists because the previous round's
`final-findings.json` was ephemeral and its content had to be restated from memory. Do not treat
the ordering here as an implementation sequence — that is `/ce-plan`'s job.

Seven reviewers ran against `bb6fba1..aa277ce` (37 files, ~3000 executable changed lines):
correctness, security, adversarial, testing, reliability, maintainability, project-standards.
Ephemeral artifacts were at `/tmp/compound-engineering-501/ce-code-review/20260725-223730-13c75ecc/`.

**The adversarial lens ran in-process, not cross-model.** The review was self-initiated as a
shipping tail, so the peer route — which egresses repo code to another provider — was not taken
without Florian's say-so. The independent-model perspective is therefore missing from this round.

**State at review time:** `npm run build` clean, `npm test` green (36 files, 376 passed, 11
skipped), CI green 4 consecutive runs. Every finding below is a *latent* defect, not a broken gate.

---

## Confirmed by two or more independent reviewers

### F1. Resume permanently refuses a healthy run whose last attempt committed nothing — P1
`src/runtime/run.ts:437` · correctness (conf 100, reproduced against the built CLI) + adversarial (conf 75)

`committedAttemptCounts` derives spent attempts by parsing `graph-bro: attempt N (node)` commit
messages. But `commitAttempt` deliberately returns `committed: false` and creates **no commit** when
an attempt changed nothing. So a bounded node whose attempt produced no diff leaves the checkpoint
at N and git at N−1, and U8's reconciliation refuses the resume — permanently, on every retry.

This is worse than the bug U8 fixed: it rejects healthy runs. It was the explicit risk in U8's own
brief and the tests miss it because every crash/resume fixture bounds the read-only `review` node,
where the hook always has a diff to fold, and the fake CLIs vary content every attempt.

Both reviewers propose the same shape: stop inferring spent attempts from commit messages. Record a
durable per-boundary trace event in `withAttemptCommit` (the trace is already this run's durable
record — no new column, no fourth migration) and reconcile against that.

### F2. `preserveInterruptedAttempt` bypasses the `stageAll` retry — P1
`src/workspace/commit.ts:407` · reliability (conf 100) + maintainability (conf 75) + adversarial (conf 75)

`commitAttempt` was rerouted through `stageAll` in this fix set because a node's leaked background
writer makes `git add -A` die with `short read while indexing` / `fatal: adding files failed`.
`preserveInterruptedAttempt` still calls `runWorkspaceGit(target, ["add", "-A"])` directly — and it
runs **on every resume, immediately after a kill**, which is precisely when a detached writer is
most likely still alive. The failure class this fix set closed elsewhere is still open on the path
most exposed to it. One-line fix; needs a test that does not race a real writer.

### F3. Integrity manifest ignores symlinks — P0 (security) / P2 (correctness), both conf ≥75
`src/workspace/integrity.ts:47` · security + correctness, both reproduced by probe

`hashDirectory` branches only on `isDirectory()` / `isFile()`, so a symlink dirent is skipped
entirely. A symlinked `.claude/settings.local.json` inside a pre-existing `.claude/` is invisible to
the manifest. Since the sandbox-side half of finding #4 is deferred (issue #18), U4 is the *only*
shipped control for that class — a bypass means #4 is not actually closed.

The two reviewers split on severity (P0 vs P2) while agreeing the defect is real; recorded here at
the higher reading because U4 is currently load-bearing and alone.

### F4. Integrity assertion covers only bounded nodes — P0 (security) / P2 (adversarial)
`src/runtime/run.ts:475` · security (conf 75) + adversarial (conf 50)

The assertion is installed inside `withAttemptCommit`, which is applied only when
`attemptBounds[nodeId] !== undefined`. An **unbounded** agent node therefore boots its CLI against
planted config before any check runs — reachable in the shipped `examples/review-fix-loop`, whose
write-capable `fix` node is unbounded. Both propose extracting a `withWorkspaceIntegrity` wrapper
applied to every agent node, leaving `withAttemptCommit` to own only the commit.

### F5. Compile-time single-track guard over-rejects — P2
`src/topology/compile.ts:162` and `:214` · correctness (conf 100) + adversarial (conf 75)

Two facets of the same over-strictness, both reproduced against `dist/`:
- The guard groups **all** plain out-edges, including edges into `set` nodes and `END`, while
  `runLoop`'s frontier assertion filters to agent activations. The two rules disagree, so the
  compiler rejects topologies the runtime would run happily.
- `isMutuallyExclusiveGroup` accepts only `equals` literals, so a provably exclusive
  `equals: L` / `not_equals: L` pair on one key (and `truthy`/`falsy`) is rejected.

### F6. `stageAll`'s retry has no test at all — P2
`src/workspace/commit.ts:175` · testing (conf 75) + reliability + adversarial

Neither the retry-and-succeed branch nor the exhausted / non-matching-error throw branch is covered.
The only test that could have reached this path was deleted in this same fix set, and its
replacement asserts a pure string function that never invokes git. Suggested shape: extract the
retry/rethrow decision as a pure predicate and unit-test it against synthetic stderr — mirroring the
`quiescenceWarningFor` extraction already used in this file for an analogous untestable race.

---

## Single-reviewer findings

### F7. Pinning `core.excludesFile` blinded the read-only backstop — P1
`src/executor/read-only-policy.ts:105` · security (conf 75, probe-verified)

**Introduced by this fix set's own `fe51ff7`.** Routing `capturePorcelain` through `runWorkspaceGit`
made it inherit the pinned `core.excludesFile`, whose content is `/.claude/`. So
`git status --porcelain` can no longer see a read-only node planting `.claude/settings.local.json` —
exactly what that backstop is documented to catch. Proposed fix: give `runWorkspaceGit` an opt-out
(`honourExcludes`, default true so `add`/`commit` are unchanged) and call it from `capturePorcelain`
with excludes off plus `--untracked-files=all`.

### F8. Integrity manifest may treat the CLI's own scratch dir as tamper — P0, conf 50, NEEDS A PROBE
`src/workspace/integrity.ts:25` · adversarial

`CONFIG_SURFACE_PATHS` hashes the whole `.claude` tree. If a real `claude` invocation creates or
mutates `<workspace>/.claude` (it is the CLI's own project-local scratch directory — the reason
`core.excludesFile` pins `/.claude/` in the first place), then **every real write run trips the
integrity assertion and fails**. CI is green because the fake CLI never creates `.claude/`.

The two mechanisms in this fix set contradict each other: one excludes `.claude/` from commits as
the CLI's own scratch, the other treats any change under it as tamper. Resolve by probing one live
`claude --print` run against a scratch worktree, then either narrow `CONFIG_SURFACE_PATHS` to the
real startup surface (`settings.json`, `settings.local.json`, `hooks/**`) or drop the excludes pin.
**This is the highest-value unknown in the set** — it is the difference between U4 working and U4
breaking every live run.

### F9. Domain terminology: "worktree" where `CONTEXT.md` reserves "workspace" — P2
`src/engine/loop.ts:215`, `src/topology/compile.ts:164` · project-standards (conf 75)

`CONTEXT.md` explicitly reserves *workspace* as the domain term and names *worktree* as merely a
mechanism that might implement it. Both new single-track diagnostics use the reserved sense. No test
asserts the message text, so it is a safe text fix.

### F10. Resume's pre-terminal status write has no regression test — P2
`src/cli/resume.ts:75` · testing

R14's whole point was that a wait for a terminal value must not be satisfiable by the prior
process's row. Nothing asserts it.

### F11. Live enforcement suite has no automated execution path — P2
`test/integration/sandbox-enforcement.test.ts:31` · testing + adversarial

Already tracked as issue #19 (U2). Adversarial adds: CI installs `bubblewrap`/`socat` but nothing
ever exercises a real sandbox, so the job goes green on package presence even where the runner
forbids unprivileged user namespaces. Suggested: a functional probe
(`bwrap --dev-bind / / --ro-bind /etc /etc true`) after the install.

### F12. Unit tests write into the operator's real home directory — P3
`src/workspace/commit.ts:33-37` · adversarial (conf 100)

`resolveExcludesFilePath` writes to `GRAPH_BRO_WORKSPACES || ~/.graph-bro-workspaces/.git-excludes`,
so in-process unit tests touch `$HOME`. Fix: write atomically and only on content change, and set
`GRAPH_BRO_WORKSPACES` to a scratch dir in `test/setup/hermetic-git.ts`.

---

## Residual risks worth a decision (not defects)

- **Pre-upgrade runs are permanently unresumable.** A run halted before U4 has no manifest trace
  event, so `resume` now throws `no workspace integrity manifest recorded`. This is the same
  upgrade-path class U10 added an explicit guard for, without the equivalent operator-facing message.
- **`main()`'s workspace-creation catch returns without `disposeWorkspace`**, so a `start` failing
  between `createWorkspace` and the manifest append leaves an attached worktree pinning the run
  branch. R12 as written is not fully met.
- **`refs/graph-bro/partial-attempt/<runId>` → `<runId>/<n>` (KTD-13) has no migration path.** A run
  whose ref was created by the old code hits a git D/F conflict on `update-ref .../1` at next resume.
- **Hermetic-git does not reach write-node subprocesses.** `minimalEnv` strips `GIT_CONFIG_*` while
  preserving `HOME`, so any git a write node runs sees the operator's real global config. No fixture
  does today. Also uncovered: `test/setup/build-once.ts` (globalSetup, main process).
- **R7 is closed only for engine-owned git.** A write node's own `git commit` still inherits
  `commit.gpgsign=true` + `gpg.format=ssh` via the preserved `HOME`, from a tty-less subprocess.
- **The pinned `core.excludesFile` overrides the operator's global excludes for every engine
  `git add -A`**, so files their `~/.gitignore_global` keeps out of git (`.env`, key material,
  `.direnv/`) are now folded into attempt commits on the run branch. Framed as intentional; worth an
  explicit decision.
- **ADR-0012's KTD-12 correction is now stale.** It claims the executor seam gains only "a workspace
  root, permitted domains, a declared output schema, and a named capability discriminant" — but
  `RunOptions` now also carries `consumerRepoPath`, and `read-only-policy.ts` imports workspace git
  internals. The ADR was edited in this diff, but not for this widening.
- **`agentNodeCapability` is optional on `EngineGraph`**, and nothing asserts `main()` populates it —
  so a wiring regression silently disables the runtime single-track enforcement while every loop
  test stays green.
- **`resolveWorkspaceGitTarget` re-runs `git rev-parse --git-common-dir` plus a `worktrees/` scan on
  every call**, now on the per-node hot path. No correctness impact; memoizable.
- **`CONFIG_SURFACE_PATHS` covers only `.claude`, `.mcp.json`, `CLAUDE.md`** — any future
  project-root CLI-config path is silently unguarded.
- **`capturePorcelain` keeps an unpinned fallback** for callers without a `consumerRepoPath`.
  Production always passes one, but `buildNodeFns`' parameter is optional, so a future caller
  silently re-enables the escape.

---

## Standing context for whoever picks this up

Hard-won during the fix set; all of it will otherwise be rediscovered the hard way.

1. **The operator's git config makes local tests lie.** `~/.gitignore_global` and
   `~/.config/git/ignore` both ignore `.claude/`. A scratch-directory test passed locally for a whole
   review cycle against a mechanism that never worked. `test/setup/hermetic-git.ts` now neutralizes
   this, but note `GIT_CONFIG_GLOBAL=/dev/null` alone is **insufficient** — it unsets
   `core.excludesFile` and git falls back to the XDG default, so the file must also be forced empty
   via `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`.
2. **Four tests in the last round were vacuous or racy.** Every one asserted on a *second* effect
   that the injected fault also broke. Before claiming a red, verify the test fails for the reason
   you think — and re-verify after changing the scenario, not just after writing it.
3. **Status is written before teardown, by design (KTD-12).** Any test that waits on a run status and
   then touches the workspace is racing the engine's disposal. Wait on the disposal outcome.
4. **`process.exit()` truncates queued pipe writes in Node**, so a fixture that writes then exits can
   lose its own output and prove nothing about the parent.
5. Live probes against `claude` 2.1.220: an empty `sandbox.filesystem.allowWrite` array is **accepted**
   and the sandbox engages, but it does **not** mean "no writable paths" — cwd and `$TMPDIR` stay
   writable; only paths outside that default set (e.g. `$HOME`) are refused. The slice-2 fix plan's
   Dependencies section still states this wrongly.
6. Open issues from the last round: #16 (U6b MCP/env confinement), #17 (U12 attribution skew),
   #18 (sandbox-side half of #4), #19 (U2 live enforcement controls — operator action, live quota).
