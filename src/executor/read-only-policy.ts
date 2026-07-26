import { execFileSync } from "node:child_process";
import { resolveWorkspaceGitTarget, runWorkspaceGit } from "../workspace/commit.js";

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

/**
 * U4: pathspec limiting the `--ignored=<mode>` read folded into
 * `capturePorcelain` below to the config surface a consumer repo's own
 * `.gitignore` conventionally excludes (`.claude/` is a widespread
 * convention). Pathspec-limited so this never enumerates the whole tree the
 * same convention excludes, e.g. `node_modules`.
 */
const IGNORED_SCAN_PATHSPECS = [".claude", ".mcp.json", "CLAUDE.md"];

/**
 * `git status --porcelain` over the node's workspace — call once before and
 * once after a read-only node runs.
 *
 * R6/KTD-6: routed through the pinned helper whenever the consumer repo is
 * known. Discovering the repository by walking up from a cwd inside the
 * agent-writable workspace is the same defect class #6 describes: a rewritten
 * gitlink would point this check at a substitute repo that always reports
 * clean, and `git status` honours `core.fsmonitor`, which git *executes* —
 * from the unsandboxed engine process, with its full inherited environment.
 * The fallback is for callers with no consumer repo (a unit test running
 * against a plain directory); it is never the engine's own path.
 *
 * U4: `runWorkspaceGit`'s excludes pin exists so the CLI's own scratch stays
 * out of *attempt commits* — exactly wrong for this backstop, whose entire
 * job is seeing a write under `.claude` (a read-only node planting
 * `.claude/settings.local.json`). Called here with `honourExcludes: false`
 * (pinning `/dev/null`, not omitting the override — omitting it hands
 * resolution back to the operator's own config) and `--untracked-files=all`
 * so a newly created directory's contents are reported in full. Folds in a
 * second, pathspec-limited `--ignored=<mode>` read over the config surface:
 * a consumer repo whose own committed `.gitignore` excludes `.claude/` (a
 * separate ignore source from `core.excludesFile`) would otherwise keep a
 * planted `settings.local.json` invisible no matter how excludes resolve.
 *
 * `--ignored=traditional`, deliberately, not the plan's stated
 * `--ignored=matching`: measured against a consumer `.gitignore` excluding
 * `.claude/`, `matching` collapses an *entirely ignored directory* to one
 * `!! .claude/` entry — identical whether the directory holds only the CLI's
 * own unconditional, benign `.cc-writes/` scratch (U1's probe) or a
 * maliciously planted `settings.local.json` alongside it. That is doubly
 * wrong: it false-positives on every live read-only run against such a
 * consumer (the scratch dir alone trips the diff), and once `.claude/` is
 * filtered to fix that, the planted file becomes undetectable too, since it
 * produces the exact same collapsed string. `traditional` reports ignored
 * paths at file granularity instead, so an untouched `.cc-writes/` (empty)
 * yields nothing, a benign file inside it yields a path `withoutCcWrites`
 * below already subtracts, and a planted `settings.local.json` yields itself.
 *
 * Both reads run every time this is called — including for the *baseline*
 * capture before a node runs — so stable ignored content is present in both
 * the before and after reads and cancels out in `assertRepoClean`'s
 * comparison; only a newly planted ignored path shows up as a difference.
 */
export function capturePorcelain(cwd: string, consumerRepoPath?: string): string {
  if (consumerRepoPath) {
    const target = resolveWorkspaceGitTarget(consumerRepoPath, cwd);
    const tracked = runWorkspaceGit(target, ["status", "--porcelain", "--untracked-files=all"], { honourExcludes: false });
    const ignored = runWorkspaceGit(
      target,
      ["status", "--porcelain", "--untracked-files=all", "--ignored=traditional", "--", ...IGNORED_SCAN_PATHSPECS],
      { honourExcludes: false },
    );
    return tracked + ignored;
  }
  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 10_000 });
}

/**
 * U1's probe: a live run unconditionally creates
 * `<workspace>/.claude/.cc-writes/` in every capability arm — the CLI's own
 * scratch directory, not agent action. A file landing there mid-run is a new
 * porcelain entry the before/after comparison would otherwise read as a
 * violation, so both sides of that comparison are filtered through this
 * first. Coverage of the rest of the config surface (`.claude/settings*`,
 * `.claude/hooks`, `.mcp.json`, `CLAUDE.md`) is left to the integrity
 * manifest's own narrowed assertion — this backstop only needs to stop
 * treating the CLI's own scratch as a violation, not to stop tracking it.
 */
const CC_WRITES_PREFIX = ".claude/.cc-writes/";

function withoutCcWrites(porcelainOutput: string): string {
  return porcelainOutput
    .split("\n")
    .filter((line) => !line.slice(3).startsWith(CC_WRITES_PREFIX))
    .join("\n");
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
export function assertRepoClean(cwd: string, nodeId: string, baselinePorcelain: string, consumerRepoPath?: string): void {
  const output = capturePorcelain(cwd, consumerRepoPath);
  if (withoutCcWrites(output) !== withoutCcWrites(baselinePorcelain)) {
    throw new ReadOnlyViolationError(nodeId, output);
  }
}
