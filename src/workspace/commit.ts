import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Mirrors `lifecycle.ts`'s `defaultWorkspacesRoot` — graph-bro's own state
 * directory, never inside any workspace, so its content is outside anything
 * the sandbox can write. `resolveExcludesFilePath` needs this same root
 * for a file that is not per-workspace.
 */
function defaultWorkspacesRoot(): string {
  return process.env.GRAPH_BRO_WORKSPACES || join(homedir(), ".graph-bro-workspaces");
}

/**
 * A single static excludes file graph-bro owns, outside every workspace
 * (U5/R10 corrected): a per-worktree `info/exclude` is not consulted by git
 * at all — `info/` is a *common* path shared across a repo's worktrees, so
 * writing one there either silently does nothing or (the U5 bug this
 * replaces) ends up appended to the *consumer's* shared file. `-c
 * core.excludesFile=<path>` on every engine invocation sidesteps all of
 * that: it needs no location inside the workspace, so the sandboxed node
 * can never see or touch it, and it makes the engine's own view
 * deterministic against the operator's global excludes too — an operator's
 * `~/.gitignore_global` can no longer change what an attempt commit
 * contains. Content is invariant, so this always overwrites rather than
 * reading-then-appending; memoized per process since every engine git call
 * needs it.
 */
const EXCLUDES_CONTENT = "/.claude/\n";

let excludesFilePath: string | undefined;
export function resolveExcludesFilePath(): string {
  if (excludesFilePath) return excludesFilePath;
  const root = defaultWorkspacesRoot();
  mkdirSync(root, { recursive: true });
  const path = join(root, ".git-excludes");
  // Conditional (R17): a fresh process (a new engine invocation, a fresh
  // test module) has no in-memory cache, so this line runs again on every
  // such process's very first git call — skip the write entirely once the
  // file already holds the right content, rather than rewriting a static
  // file on every single one of them. Atomic: written to a sibling temp file
  // and renamed into place rather than truncated in place, so a concurrent
  // reader (another process's `git` invocation reading `-c
  // core.excludesFile=<path>` at the same moment) can never observe a
  // partially-written file.
  if (!existsSync(path) || readFileSync(path, "utf8") !== EXCLUDES_CONTENT) {
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmpPath, EXCLUDES_CONTENT);
    renameSync(tmpPath, path);
  }
  excludesFilePath = path;
  return path;
}

/**
 * KTD-7: the attempt commit boundary. `commitAttempt` folds whatever the
 * workspace holds — any commits the agent made itself, plus any leftover
 * dirty/untracked state — into exactly one commit, comparing against
 * `priorHead` (the workspace's HEAD as of the last commit, or its creation
 * commit for the very first attempt). Fold rather than fail: halting an
 * unattended run over an agent's own commits defeats the point (R20).
 */

const GIT_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

export interface WorkspaceGitTarget {
  gitDir: string;
  workTree: string;
}

/**
 * KTD-6: the one helper every engine git invocation against a workspace goes
 * through. `--git-dir`/`--work-tree` are pinned to a target resolved by
 * `resolveWorkspaceGitTarget` — never left for git to discover by walking up
 * from a cwd inside the workspace, which is exactly how a rewritten gitlink
 * would get consulted. The `-c` overrides neutralize every kind of
 * repo-supplied execution the engine's unsandboxed process would otherwise
 * inherit on *this* invocation: `core.hooksPath`/`core.fsmonitor` stop hooks
 * firing on `checkout`/`commit`/etc, and `commit.gpgsign`/`tag.gpgsign` stop
 * the operator's own signing config (a `gpg.format ssh` signer, say) from
 * running inside a detached, tty-less process on every engine-owned attempt
 * commit (#14) — that config lives in the *operator's* gitconfig, which is
 * not scoped per-repo, so it cannot be avoided by resolving a "clean" git-dir
 * the way hooks/filters can. `core.excludesFile` pins a graph-bro-owned
 * excludes file (U5/R10) so the CLI's scratch directory stays out of every
 * attempt commit without ever writing anything inside the workspace or the
 * consumer's shared `.git/info/exclude`.
 */
export function runWorkspaceGit(target: WorkspaceGitTarget, args: string[]): string {
  return execFileSync(
    "git",
    [
      "--git-dir",
      target.gitDir,
      "--work-tree",
      target.workTree,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      `core.excludesFile=${resolveExcludesFilePath()}`,
      ...args,
    ],
    { encoding: "utf8", stdio: GIT_STDIO },
  );
}

/**
 * KTD-7: resolves a workspace's administrative directory by asking the
 * *consumer* repo which of its registered linked worktrees points at this
 * path — never by reading anything inside the workspace itself, most of all
 * `<workspace>/.git`, which is precisely the gitlink #6 shows a sandboxed
 * node can rewrite to redirect the engine's git at a substitute repository
 * it fully controls (its own hooks, its own filter drivers, its own
 * config). Each linked worktree's private admin dir records its own target
 * in `<common-dir>/worktrees/<name>/gitdir` — a file that lives under the
 * consumer's own `.git`, outside anything the workspace sandbox can write —
 * so matching on *that* file's content, rather than trusting the workspace's
 * own gitlink, is what defeats the rewrite. Matches by content rather than by
 * directory name to tolerate git's own disambiguation suffixes.
 */
export function resolveWorkspaceGitTarget(consumerRepoPath: string, workspacePath: string): WorkspaceGitTarget {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: consumerRepoPath,
    encoding: "utf8",
    stdio: GIT_STDIO,
  }).trim();
  const commonDirAbs = isAbsolute(commonDir) ? commonDir : join(consumerRepoPath, commonDir);
  const worktreesDir = join(commonDirAbs, "worktrees");
  const resolvedWorkspacePath = realpathSync(workspacePath);

  const entries = existsSync(worktreesDir) ? readdirSync(worktreesDir) : [];
  for (const entry of entries) {
    const gitdirFile = join(worktreesDir, entry, "gitdir");
    if (!existsSync(gitdirFile)) continue;
    const recordedGitlink = readFileSync(gitdirFile, "utf8").trim();
    try {
      if (realpathSync(dirname(recordedGitlink)) === resolvedWorkspacePath) {
        return { gitDir: join(worktreesDir, entry), workTree: resolvedWorkspacePath };
      }
    } catch {
      continue; // a stale/pruned worktree entry — not this workspace
    }
  }
  throw new Error(
    `could not resolve administrative directory for workspace '${workspacePath}' from consumer repo '${consumerRepoPath}' — is it a linked worktree of that repo?`,
  );
}

function currentHead(target: WorkspaceGitTarget): string {
  return runWorkspaceGit(target, ["rev-parse", "HEAD"]).trim();
}

/** How many times `git add -A` is retried when a file is being rewritten underneath it. */
const STAGE_ATTEMPTS = 5;
/**
 * git's own wording when a file changed size while it was being hashed. Matched
 * rather than retrying every failure, so a genuine error (a bad object, a full
 * disk, a locked index) still surfaces immediately instead of being retried
 * five times and reported late.
 */
const CONCURRENT_MODIFICATION = /short read while indexing|unable to index file|file changed as we read it/i;

/**
 * `git add -A`, tolerant of a detached process still writing into the
 * workspace.
 *
 * A node can leave a background writer behind, which is a case this module
 * already knows about and deliberately reports as a *warning* rather than a
 * failure (`quiescenceWarning`). But `git add -A` itself dies with `fatal:
 * adding files failed` when a file it is hashing shrinks mid-read — so the
 * whole attempt commit, and with it the run, failed before the warning could
 * ever be produced. The graceful path was unreachable in precisely the
 * scenario it was written for.
 *
 * A retry is the right shape because the condition is transient by
 * definition: the next pass re-stats and re-reads whatever the writer has
 * settled on. If every attempt loses the race the throw stands — at that
 * point the workspace genuinely cannot be snapshotted, and R20's
 * fold-rather-than-fail does not extend to inventing a commit from a tree
 * that will not hold still.
 */
function stageAll(target: WorkspaceGitTarget): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      runWorkspaceGit(target, ["add", "-A"]);
      return;
    } catch (err) {
      const detail = `${(err as { stderr?: unknown }).stderr ?? ""}${(err as Error).message ?? ""}`;
      if (attempt >= STAGE_ATTEMPTS || !CONCURRENT_MODIFICATION.test(detail)) throw err;
    }
  }
}

function porcelain(target: WorkspaceGitTarget): string {
  return runWorkspaceGit(target, ["status", "--porcelain"]);
}

/** The workspace's HEAD right now — the runtime's starting `priorHead` for the very first attempt, on both `start` (the creation commit) and `resume` (wherever the workspace was left). */
export function readHead(consumerRepoPath: string, workspacePath: string): string {
  return currentHead(resolveWorkspaceGitTarget(consumerRepoPath, workspacePath));
}

export interface CommitAttemptOptions {
  /** KTD-7: resolves the workspace's real admin dir; never read from inside the workspace. */
  consumerRepoPath: string;
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
 * still gets one). Every git call here runs through `runWorkspaceGit`
 * (KTD-6): a consumer repo whose committed content supplies a hooks path or
 * a `filter.*.clean` driver must not execute inside the unsandboxed engine
 * process on every attempt, and the operator's own signing config must not
 * turn every attempt commit into a signature attempt from a tty-less process.
 */
export function commitAttempt(options: CommitAttemptOptions): CommitAttemptResult {
  const { consumerRepoPath, workspacePath, priorHead, attemptNumber, nodeId } = options;
  const target = resolveWorkspaceGitTarget(consumerRepoPath, workspacePath);

  const headBefore = currentHead(target);
  const dirtyBefore = porcelain(target);
  if (headBefore === priorHead && dirtyBefore.trim() === "") {
    return { committed: false, head: priorHead };
  }

  stageAll(target);
  // `--soft` moves the branch ref back to `priorHead` without touching the
  // index or working tree, so the diff between `priorHead` and whatever was
  // just staged now includes both the agent's own commits (already reflected
  // in the index) and the leftover dirty/untracked state just staged above.
  runWorkspaceGit(target, ["reset", "--soft", priorHead]);
  runWorkspaceGit(target, ["commit", "-m", `graph-bro: attempt ${attemptNumber} (${nodeId})`]);
  const head = currentHead(target);

  return { committed: true, head, quiescenceWarning: quiescenceWarningFor(porcelain(target), attemptNumber, nodeId) };
}

/**
 * The quiescence verdict for a workspace's post-commit `git status --porcelain`
 * output: a warning naming the node when anything is still dirty, `undefined`
 * when the tree settled.
 *
 * Pure, and separate from `commitAttempt`, because the alternative is
 * untestable. Proving this end-to-end means racing a live background writer
 * against four git subprocesses and hoping it dirties the tree in the window
 * between the commit and the status read — which depends on process
 * scheduling, on whether git's stat shortcut decides to re-read the file at
 * all, and on the machine. That test failed intermittently in three different
 * ways on three different machines, which is exactly the spawned-process race
 * R5 bars from the blocking gate. The decision itself is what carries the
 * behavior, so it is tested directly instead.
 */
export function quiescenceWarningFor(porcelainOutput: string, attemptNumber: number, nodeId: string): string | undefined {
  if (porcelainOutput.trim().length === 0) return undefined;
  return `workspace not quiescent after committing attempt ${attemptNumber} for node '${nodeId}' — a detached process may still be writing:\n${porcelainOutput}`;
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
function nextPartialAttemptRefName(target: WorkspaceGitTarget, runId: string): string {
  const namespace = partialAttemptRef(runId);
  const existing = runWorkspaceGit(target, ["for-each-ref", "--format=%(refname)", `${namespace}/*`]).trim();
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

/** One `commitAttempt`/teardown commit, as parsed off its `graph-bro: attempt N (nodeId)` message. */
interface AttemptCommitInfo {
  sha: string;
  attemptNumber: number;
  nodeId: string;
}

const ATTEMPT_COMMIT_PATTERN = /^graph-bro: attempt (\d+) \((.+)\)$/;

/**
 * Walks the run's own history (never past `baseRefSha`, which is shared
 * consumer history, not this run's) and parses every `commitAttempt`/teardown
 * commit's `graph-bro: attempt N (nodeId)` message. Newest first (git log's
 * own order) — both `findLastCommittedAttempt` and `committedAttemptCounts`
 * read off this one walk rather than each parsing commit messages themselves.
 */
function parseAttemptCommits(target: WorkspaceGitTarget, baseRefSha: string): AttemptCommitInfo[] {
  const log = runWorkspaceGit(target, ["log", "--format=%H %s", `${baseRefSha}..HEAD`]);
  const commits: AttemptCommitInfo[] = [];
  for (const line of log.trim().split("\n")) {
    if (!line) continue;
    const spaceIndex = line.indexOf(" ");
    const sha = line.slice(0, spaceIndex);
    const match = ATTEMPT_COMMIT_PATTERN.exec(line.slice(spaceIndex + 1));
    if (match) commits.push({ sha, attemptNumber: Number.parseInt(match[1], 10), nodeId: match[2] });
  }
  return commits;
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
function findLastCommittedAttempt(target: WorkspaceGitTarget, baseRefSha: string): string {
  const [nearest] = parseAttemptCommits(target, baseRefSha);
  return nearest ? nearest.sha : baseRefSha;
}

/**
 * R15/KTD-11: nodeId -> the highest attempt number actually committed to the
 * workspace's history, for reconciling against a resumed checkpoint's own
 * per-node attempt counts. A resumed checkpoint can *promise* more attempts
 * than git actually holds — a kill between the checkpoint write and the
 * attempt commit that was about to fold the prior round's edits, discarded by
 * `preserveInterruptedAttempt`'s hard reset — and that gap is exactly what
 * `resume` must refuse loudly on rather than silently re-enter the bounded
 * node against a workspace that no longer reflects what the checkpoint
 * claims. Extends `parseAttemptCommits` rather than a second parser of the
 * commit message shape.
 */
export function committedAttemptCounts(
  consumerRepoPath: string,
  workspacePath: string,
  baseRefSha: string,
): Record<string, number> {
  const target = resolveWorkspaceGitTarget(consumerRepoPath, workspacePath);
  const counts: Record<string, number> = {};
  for (const commit of parseAttemptCommits(target, baseRefSha)) {
    if ((counts[commit.nodeId] ?? 0) < commit.attemptNumber) counts[commit.nodeId] = commit.attemptNumber;
  }
  return counts;
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
export function preserveInterruptedAttempt(
  consumerRepoPath: string,
  workspacePath: string,
  runId: string,
  baseRefSha: string,
): PreserveInterruptedAttemptResult {
  const target = resolveWorkspaceGitTarget(consumerRepoPath, workspacePath);
  const lastGood = findLastCommittedAttempt(target, baseRefSha);
  const head = currentHead(target);
  const dirty = porcelain(target);
  if (head === lastGood && dirty.trim() === "") {
    return { preserved: false };
  }

  runWorkspaceGit(target, ["add", "-A"]);
  const treeSha = runWorkspaceGit(target, ["write-tree"]).trim();
  const sha = runWorkspaceGit(target, [
    "commit-tree",
    treeSha,
    "-p",
    head,
    "-m",
    `graph-bro: interrupted attempt for run ${runId}`,
  ]).trim();
  runWorkspaceGit(target, ["update-ref", nextPartialAttemptRefName(target, runId), sha]);

  runWorkspaceGit(target, ["reset", "--hard", lastGood]);
  runWorkspaceGit(target, ["clean", "-fd"]);

  return { preserved: true, sha };
}
