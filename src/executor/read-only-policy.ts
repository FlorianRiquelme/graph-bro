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
 */
export const READ_ONLY_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash(git status *)", "Bash(git log *)"] as const;

/** Builds the `--allowedTools` argv pair for a read-only node. */
export function buildReadOnlyArgs(): string[] {
  return ["--allowedTools", READ_ONLY_ALLOWED_TOOLS.join(" ")];
}

/** Raised by the KTD-10 backstop when a read-only node leaves its cwd dirty. */
export class ReadOnlyViolationError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly porcelain: string,
  ) {
    super(`read-only node '${nodeId}' left the repo dirty (git status --porcelain):\n${porcelain}`);
    this.name = "ReadOnlyViolationError";
  }
}

/**
 * KTD-10 backstop: run per read-only node completion (not once after a whole
 * fan-out drains) so a violation is attributed to the offending node —
 * defense-in-depth, subordinate to the permission-mode primary. Raises
 * `ReadOnlyViolationError` if the cwd is left dirty.
 */
export function assertRepoClean(cwd: string, nodeId: string): void {
  const output = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 10_000 });
  if (output.trim().length > 0) {
    throw new ReadOnlyViolationError(nodeId, output);
  }
}
