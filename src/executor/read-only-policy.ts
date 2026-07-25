import { execFileSync } from "node:child_process";

/**
 * KTD-8: the read-only allowlist — `Read`/`Grep`/`Glob` plus read-only Bash
 * specifiers. Omitting `Edit`/`Write`/`NotebookEdit` blocks mutation; no
 * `--dangerously-skip-permissions` is needed (live-verified against `claude`
 * v2.1.218: a prompt asking the agent to write a file, run with
 * `--allowedTools "Read"` only, produced no file on disk, a
 * `permission_denials` entry naming the denied `Write` tool call, `is_error:
 * false`, and exit code 0). Scope caveat (KTD-8): this denies mutation but
 * does not scope *where* `Read`/`Grep`/`Glob` may read.
 *
 * U6: widened with `diff`/`show` — a review node's whole job is judging a
 * diff, which the slice-1 allowlist (status/log only) can't do.
 */
export const READ_ONLY_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git status *)",
  "Bash(git log *)",
  "Bash(git diff *)",
  "Bash(git show *)",
] as const;

/** Builds the `--allowedTools` argv pair for a read-only node. */
export function buildReadOnlyArgs(): string[] {
  return ["--allowedTools", READ_ONLY_ALLOWED_TOOLS.join(" ")];
}

/** Raised by the KTD-10 backstop when a read-only node changes its cwd. */
export class ReadOnlyViolationError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly porcelain: string,
  ) {
    super(`read-only node '${nodeId}' changed the workspace (git status --porcelain):\n${porcelain}`);
    this.name = "ReadOnlyViolationError";
  }
}

/** `git status --porcelain` in `cwd` — call once before and once after a read-only node runs. */
export function capturePorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 10_000 });
}

/**
 * KTD-10 backstop, rescoped to a per-node baseline (U6): every node now
 * shares one workspace, so a read-only node activating after a write node's
 * uncommitted changes — but before the attempt commit — must not false-fail
 * on porcelain output it didn't create. Compares against `baselinePorcelain`
 * (captured before the node ran) rather than asserting emptiness, so the
 * assertion means "this node changed nothing", which is what it was always
 * for. Raises `ReadOnlyViolationError` if the two differ.
 */
export function assertRepoClean(cwd: string, nodeId: string, baselinePorcelain: string): void {
  const output = capturePorcelain(cwd);
  if (output !== baselinePorcelain) {
    throw new ReadOnlyViolationError(nodeId, output);
  }
}
