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

export interface ReadOnlyPolicy {
  argv: string[];
}

/**
 * R9/KTD-9: the allowlist above grants `Bash(git diff *)` and
 * `Bash(git show *)`, and both accept `--output=<path>` — a legitimate flag
 * of an allowed command that writes a file anywhere the OS lets the process
 * write. The allowlist string cannot express "not through this flag either";
 * only the OS sandbox can, so a read-only node gets the same sandbox layer a
 * write node gets — enabled, `failIfUnavailable`, and (unlike the write
 * policy) an *empty* filesystem write scope, since a read-only node has no
 * legitimate reason to write anywhere. There is no per-node path to
 * canonicalise here — the write scope is always empty regardless of the
 * node's cwd — so, unlike `buildWritePolicy`, this builder takes no
 * workspace argument; it stays pure and argument-free.
 *
 * This composes with, and does not replace, `assertRepoClean`'s porcelain
 * backstop: the sandbox refuses an escape through an absolute or `../`
 * path that porcelain scoped to the node's cwd would never see, while
 * porcelain still catches an in-workspace write the sandbox's own default
 * writable set (see the residual note below) would otherwise let through
 * silently.
 *
 * Residual (record it here, next to the read-scope caveat above, rather
 * than let it be discovered later as a surprise): an empty `allowWrite`
 * does not mean "no writable paths" — live-probed against `claude` 2.1.220,
 * the sandbox still permits writes to the process's own cwd and to the
 * platform temp directory (`$TMPDIR`) even with an empty array; only paths
 * outside that default writable set (e.g. `$HOME`) are refused. A
 * read-only node therefore still has a real, residual ability to write into
 * temp directories, which sit outside the workspace and are invisible to
 * `assertRepoClean`'s porcelain check. This unit closes the workspace-escape
 * class (R9); it does not make a read-only node's filesystem access empty.
 */
export function buildReadOnlyPolicy(): ReadOnlyPolicy {
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      filesystem: { allowWrite: [] },
      network: { allowedDomains: [] },
    },
  };
  return { argv: ["--settings", JSON.stringify(settings)] };
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
