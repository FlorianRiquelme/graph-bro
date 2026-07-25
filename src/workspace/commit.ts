import { execFileSync } from "node:child_process";

/**
 * KTD-7: the attempt commit boundary. `commitAttempt` folds whatever the
 * workspace holds — any commits the agent made itself, plus any leftover
 * dirty/untracked state — into exactly one commit, comparing against
 * `priorHead` (the workspace's HEAD as of the last commit, or its creation
 * commit for the very first attempt). Fold rather than fail: halting an
 * unattended run over an agent's own commits defeats the point (R20).
 */

const GIT_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: GIT_STDIO });
}

function currentHead(workspacePath: string): string {
  return git(workspacePath, ["rev-parse", "HEAD"]).trim();
}

function porcelain(workspacePath: string): string {
  return git(workspacePath, ["status", "--porcelain"]);
}

/** The workspace's HEAD right now — the runtime's starting `priorHead` for the very first attempt, on both `start` (the creation commit) and `resume` (wherever the workspace was left). */
export function readHead(workspacePath: string): string {
  return currentHead(workspacePath);
}

export interface CommitAttemptOptions {
  workspacePath: string;
  /** The workspace's HEAD as of the last commit action (or its creation commit, for the first attempt). */
  priorHead: string;
  attemptNumber: number;
  /** The bounded node this attempt boundary is anchored to, for the commit message and any quiescence warning. */
  nodeId: string;
}

export interface CommitAttemptResult {
  committed: boolean;
  /** The workspace's HEAD after this call — feed back in as the next call's `priorHead`. Unchanged from `priorHead` when nothing was committed. */
  head: string;
  /**
   * Set when the workspace is still dirty immediately after committing — a
   * detached background writer can outlive the node that spawned it. Traced
   * as a warning naming the node rather than silently absorbed or failed.
   */
  quiescenceWarning?: string;
}

/**
 * Commits everything new since `priorHead` — the agent's own commits
 * squash-folded together with any leftover dirty/untracked state — into one
 * commit (R20/AE8). Returns `committed: false` without creating an empty
 * commit when nothing changed since `priorHead` (R21's counterpart: an
 * attempt that did nothing produces no commit, only a *failing* attempt
 * still gets one). Runs with hooks disabled (`-c core.hooksPath=/dev/null`):
 * a consumer repo whose committed content supplies a hooks path must not
 * execute inside the unsandboxed engine process on every attempt.
 */
export function commitAttempt(options: CommitAttemptOptions): CommitAttemptResult {
  const { workspacePath, priorHead, attemptNumber, nodeId } = options;

  const headBefore = currentHead(workspacePath);
  const dirtyBefore = porcelain(workspacePath);
  if (headBefore === priorHead && dirtyBefore.trim() === "") {
    return { committed: false, head: priorHead };
  }

  git(workspacePath, ["add", "-A"]);
  // `--soft` moves the branch ref back to `priorHead` without touching the
  // index or working tree, so the diff between `priorHead` and whatever was
  // just staged now includes both the agent's own commits (already reflected
  // in the index) and the leftover dirty/untracked state just staged above.
  git(workspacePath, ["reset", "--soft", priorHead]);
  git(workspacePath, ["-c", "core.hooksPath=/dev/null", "commit", "-m", `graph-bro: attempt ${attemptNumber} (${nodeId})`]);
  const head = currentHead(workspacePath);

  const dirtyAfter = porcelain(workspacePath);
  const quiescenceWarning =
    dirtyAfter.trim().length > 0
      ? `workspace not quiescent after committing attempt ${attemptNumber} for node '${nodeId}' — a detached process may still be writing:\n${dirtyAfter}`
      : undefined;

  return { committed: true, head, quiescenceWarning };
}

/**
 * The namespace prefix under which a run's preserved interrupted attempts
 * live — never the run branch, since none of them was ever a completed
 * attempt (R20's one-commit-per-attempt count must not include them). Keyed
 * on the run id alone rather than a single ref name: a run can be killed and
 * resumed more than once, and each cycle's preserved commit must stay
 * independently reachable rather than the next cycle silently overwriting it
 * (KTD-13). Callers enumerate this prefix with `git for-each-ref` rather than
 * `rev-parse`-ing a single name.
 */
export function partialAttemptRef(runId: string): string {
  return `refs/graph-bro/partial-attempt/${runId}`;
}

/** The next unused ref under `partialAttemptRef`'s namespace for this run — one per preserved cycle, so a second kill-and-resume never displaces the first's commit (KTD-13). `refs/graph-bro/partial-attempt/*` sits outside `refs/heads/`, so git keeps no reflog and a displaced commit would be immediately gc-eligible. */
function nextPartialAttemptRefName(workspacePath: string, runId: string): string {
  const namespace = partialAttemptRef(runId);
  const existing = git(workspacePath, ["for-each-ref", "--format=%(refname)", `${namespace}/*`]).trim();
  // Highest existing suffix + 1, not a count: counting reuses a suffix as soon
  // as any earlier ref in the namespace is gone, which would overwrite a
  // preserved commit — the exact silent displacement KTD-13 exists to stop.
  const highest = existing
    .split("\n")
    .map((refName) => Number.parseInt(refName.slice(namespace.length + 1), 10))
    .reduce((max, suffix) => (Number.isFinite(suffix) && suffix > max ? suffix : max), 0);
  return `${namespace}/${highest + 1}`;
}

export interface PreserveInterruptedAttemptResult {
  preserved: boolean;
  sha?: string;
}

/**
 * Walks back from HEAD, within this branch's own history (never past
 * `baseRefSha`, which is shared consumer history, not this run's), for the
 * nearest commit `commitAttempt`/the teardown commit made — both use the
 * `graph-bro: attempt N (...)` message. Falls back to `baseRefSha` itself
 * when no attempt has ever been committed yet (a crash during the very
 * first attempt). This — not HEAD — is "the last actually committed
 * attempt": HEAD may sit on top of it if the agent made its own commits
 * that a crash prevented `commitAttempt` from ever folding.
 */
function findLastCommittedAttempt(workspacePath: string, baseRefSha: string): string {
  const log = git(workspacePath, ["log", "--format=%H %s", `${baseRefSha}..HEAD`]);
  for (const line of log.trim().split("\n")) {
    if (!line) continue;
    const spaceIndex = line.indexOf(" ");
    if (line.slice(spaceIndex + 1).startsWith("graph-bro: attempt ")) return line.slice(0, spaceIndex);
  }
  return baseRefSha;
}

/**
 * F3/AE9/U8: a killed run's mid-attempt state is preserved as a reachable,
 * inspectable commit under `partialAttemptRef` — *not* folded into the run
 * branch, since it was never a completed attempt — then the workspace is
 * hard-reset to the last actually committed attempt, so resume re-enters
 * from a clean, known-good tree. A no-op if the workspace is already at
 * that state (a graceful stop, or a resume of an already-clean retained
 * workspace).
 *
 * Uses plumbing (`write-tree`/`commit-tree`) rather than `git stash create`:
 * the latter only captures tracked changes, missing any file a killed write
 * node had just created. `reset --hard` alone would leave those same
 * untracked files behind, so `clean -fd` follows it. Compares against
 * `findLastCommittedAttempt`, not `priorHead`-style equality with HEAD: an
 * agent's own commit made mid-attempt (never folded by `commitAttempt`
 * before the kill) leaves the tree clean but HEAD already past the last
 * real attempt commit, which a bare porcelain check would miss entirely.
 */
export function preserveInterruptedAttempt(workspacePath: string, runId: string, baseRefSha: string): PreserveInterruptedAttemptResult {
  const lastGood = findLastCommittedAttempt(workspacePath, baseRefSha);
  const head = currentHead(workspacePath);
  const dirty = porcelain(workspacePath);
  if (head === lastGood && dirty.trim() === "") {
    return { preserved: false };
  }

  git(workspacePath, ["add", "-A"]);
  const treeSha = git(workspacePath, ["write-tree"]).trim();
  const sha = git(workspacePath, [
    "commit-tree",
    treeSha,
    "-p",
    head,
    "-m",
    `graph-bro: interrupted attempt for run ${runId}`,
  ]).trim();
  git(workspacePath, ["update-ref", nextPartialAttemptRefName(workspacePath, runId), sha]);

  git(workspacePath, ["reset", "--hard", lastGood]);
  git(workspacePath, ["clean", "-fd"]);

  return { preserved: true, sha };
}
