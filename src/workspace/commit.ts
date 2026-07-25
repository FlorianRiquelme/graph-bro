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
