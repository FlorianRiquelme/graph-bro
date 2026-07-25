import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * KTD-1: the workspace is a `git worktree` under graph-bro's own home, one
 * branch per run — never inside the consumer repo, and (per the Risks
 * section) never inside the run store's own directory either, since the
 * store is the only record of what a run did and a write scope covering it
 * would let a node rewrite its own trace. A sibling of `~/.graph-bro`, not a
 * child of it.
 */
function defaultWorkspacesRoot(): string {
  // GRAPH_BRO_WORKSPACES: mirrors GRAPH_BRO_HOME (src/store/db.ts) — an
  // override for tests, never a consumer-facing flag.
  return process.env.GRAPH_BRO_WORKSPACES || join(homedir(), ".graph-bro-workspaces");
}

/**
 * Named by run id, not by anything derived from the topology or consumer
 * repo: the worktree admin name derives from the directory's basename, and
 * two workspaces sharing a basename get silently de-duplicated names that
 * are then unpredictable to prune.
 */
export function workspacePathForRun(runId: string, workspacesRoot = defaultWorkspacesRoot()): string {
  return join(workspacesRoot, runId);
}

/** The run-owned branch a completed run hands back for the operator to review with ordinary git (R22). */
export function runBranchForRun(runId: string): string {
  return `graph-bro/run-${runId}`;
}

/** Every git call in this module is scripted, never interactive — captured output only, no passthrough of git's own progress chatter (e.g. `worktree add`'s "Preparing worktree ..." to stderr). */
const GIT_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

function gitErrorMessage(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string })?.stderr;
  if (stderr) return stderr.toString().trim();
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolves a declared (or default, "current branch's tip") base ref to a
 * commit SHA — done at `start`, not at engine boot, and delivered on argv
 * from there. Resolving from the symbolic ref at boot would let the branch
 * tip move in the window between `start` and the engine actually running,
 * the same class of window graph-bro#12 already cost this project. Throws
 * before a run id is minted: a bad ref or a non-git consumer directory is
 * an authoring error (R14), not a run failure.
 */
export function resolveBaseRef(consumerRepoPath: string, declaredRef?: string): string {
  const ref = declaredRef ?? "HEAD";
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: consumerRepoPath,
      encoding: "utf8",
      stdio: GIT_STDIO,
    }).trim();
  } catch (err) {
    throw new Error(`could not resolve base ref '${ref}' in '${consumerRepoPath}': ${gitErrorMessage(err)}`);
  }
}

/**
 * The CLI's own scratch directory (Claude Code's project-local `.claude/`)
 * excluded from the worktree at creation — keeps attempt commits clean and
 * keeps the CLI's own files out of every node's tree comparison.
 *
 * `git rev-parse --git-path info/exclude` resolves to the *common* git dir —
 * `info/` is shared across all worktrees of a repo (only
 * `info/sparse-checkout` is per-worktree) — so writing there would append to
 * the consumer's own `.git/info/exclude`, permanently, on every run. That
 * would leave the consumer's `git status`/`git add -A` silently ignoring an
 * untracked `.claude/` in their main working tree from then on, with no
 * mention of it in the run's output. `git rev-parse --git-dir`, by contrast,
 * resolves to the worktree's own private admin directory
 * (`<common-dir>/worktrees/<name>`), which git also honours for this
 * worktree's own exclude file — so writing `info/exclude` under it keeps the
 * workspace's scratch directory ignored without ever touching the consumer's
 * copy. That per-worktree `info/` directory does not exist by default and
 * must be created.
 */
function excludeScratchDirectory(workspacePath: string): void {
  const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
    cwd: workspacePath,
    encoding: "utf8",
    stdio: GIT_STDIO,
  }).trim();
  const worktreeGitDir = isAbsolute(gitDir) ? gitDir : join(workspacePath, gitDir);
  const infoDir = join(worktreeGitDir, "info");
  mkdirSync(infoDir, { recursive: true });
  const excludePath = join(infoDir, "exclude");
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const line = "/.claude/";
  if (existing.split("\n").some((l) => l.trim() === line)) return;
  appendFileSync(excludePath, `${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${line}\n`);
}

export interface CreateWorkspaceOptions {
  consumerRepoPath: string;
  baseRefSha: string;
  workspacePath: string;
  runBranch: string;
}

/**
 * Cuts the run's isolated worktree from the resolved SHA (never the symbolic
 * ref) and checks out a fresh run branch there in one step (R13/R22). The
 * consumer's own working tree and index are untouched by construction — a
 * linked worktree only ever adds to the shared object/ref store, never
 * writes the main worktree's files (R16).
 */
export function createWorkspace(options: CreateWorkspaceOptions): void {
  mkdirSync(join(options.workspacePath, ".."), { recursive: true });
  try {
    execFileSync(
      "git",
      ["worktree", "add", "-b", options.runBranch, options.workspacePath, options.baseRefSha],
      { cwd: options.consumerRepoPath, encoding: "utf8", stdio: GIT_STDIO },
    );
  } catch (err) {
    throw new Error(`could not create workspace worktree at '${options.workspacePath}': ${gitErrorMessage(err)}`);
  }
  excludeScratchDirectory(options.workspacePath);
}

/**
 * Locates an existing workspace for a resumed run (U5's minimal scope — a
 * halted run's worktree is retained per KTD-9; hard-resetting it to the last
 * committed attempt is U8's job). Throws with a clear message if the
 * directory is gone, rather than silently proceeding unisolated.
 */
export function reuseWorkspace(workspacePath: string): void {
  if (!existsSync(workspacePath)) {
    throw new Error(`workspace '${workspacePath}' is missing — it may have been removed by hand; cannot resume`);
  }
}

/**
 * U8: KTD-9 leaves a retained (halted) workspace's HEAD detached precisely so
 * its branch can be checked out elsewhere while the directory exists — but
 * that means resume must re-attach *before* committing anything, or every
 * post-resume attempt commits onto the detached HEAD instead of the run
 * branch, silently losing them from the handback. Throws — naming the
 * holding worktree's path, since git's own error already does — if the
 * branch is checked out elsewhere in the meantime, rather than proceeding
 * detached.
 */
export function reattachToRunBranch(workspacePath: string, runBranch: string): void {
  try {
    execFileSync("git", ["checkout", runBranch], { cwd: workspacePath, encoding: "utf8", stdio: GIT_STDIO });
  } catch (err) {
    throw new Error(`could not reattach workspace to run branch '${runBranch}': ${gitErrorMessage(err)}`);
  }
}

/**
 * KTD-9: a converged run needs no directory (the branch is the handback), so
 * its worktree is removed; a halted run keeps its workspace for `resume` and
 * for inspection, but with HEAD detached — while a worktree holds a branch,
 * git refuses to check that branch out or delete it elsewhere, which would
 * otherwise pin the very branch the operator most wants to pick up.
 */
export function finalizeWorkspace(options: { consumerRepoPath: string; workspacePath: string; converged: boolean }): void {
  if (options.converged) {
    execFileSync("git", ["worktree", "remove", "--force", options.workspacePath], {
      cwd: options.consumerRepoPath,
      encoding: "utf8",
      stdio: GIT_STDIO,
    });
    return;
  }
  execFileSync("git", ["checkout", "--detach", "HEAD"], { cwd: options.workspacePath, encoding: "utf8", stdio: GIT_STDIO });
}
