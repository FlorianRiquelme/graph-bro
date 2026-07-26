import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/store/db.js";
import { getRun } from "../../src/store/pending-writes.js";
import { appendEvent, listEvents } from "../../src/store/trace.js";
import { createWorkspace, resolveBaseRef, runBranchForRun, workspacePathForRun } from "../../src/workspace/lifecycle.js";
import { captureWorkspaceIntegrityManifest, WORKSPACE_INTEGRITY_MANIFEST_EVENT_TYPE } from "../../src/workspace/integrity.js";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
export const FAKE_CLAUDE = join(REPO_ROOT, "test", "fixtures", "fake-claude.mjs");

/** A scratch git repo — the "consumer repo" cwd a read-only node's backstop checks. */
export function gitRepo(prefix = "graph-bro-cli-repo-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  // Local override: these are throwaway /tmp repos that exist only as a
  // read-only backstop's "consumer repo" stand-in — signing scratch test
  // commits gains nothing and makes the suite depend on an interactive
  // signing agent (e.g. 1Password) staying unlocked for the whole run.
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Spawns the real built CLI (`dist/cli/index.js`) synchronously — the actual
 * invocation shape a consumer uses. Throws immediately if the spawn itself
 * failed (`result.error`) or the process was killed by a signal rather than
 * exiting normally — both leave `status: null`, which a bare `toBe(0)`
 * assertion on the caller side can't distinguish from "the CLI legitimately
 * exited null" and would otherwise report as an opaque `null !== 0` failure.
 */
export function runCliSync(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): CliResult {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf-8",
  });
  if (result.error) {
    throw new Error(`runCliSync(${args.join(" ")}) failed to spawn: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(
      `runCliSync(${args.join(" ")}) was killed by signal ${result.signal}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal };
}

export async function waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 50, describeState?: () => string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs}ms${describeState ? `\n${describeState()}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Polls a run's status directly against the SQLite store (`GRAPH_BRO_HOME`)
 * instead of shelling out to a full CLI subprocess every tick — a poll loop
 * driving `status` through `runCliSync` pays a fresh Node start + native
 * `better-sqlite3` load per tick, which adds up over a 5-20s wait.
 *
 * On timeout, reports the status actually observed plus the run's trace tail.
 * A bare "timed out" cannot distinguish the three failure modes that reach
 * here — the run never started, the run is genuinely slow, or the run reached
 * a *different* terminal status (a `failed` run never becomes `completed`, so
 * it burns the whole timeout looking exactly like starvation). Diagnosing that
 * from a CI log with no reproduction is otherwise guesswork.
 */
export function waitForRunStatus(home: string, runId: string, status: string, timeoutMs: number): Promise<void> {
  const readRun = (): { status: string } | undefined => {
    const db = openDb({ baseDir: home });
    try {
      return getRun(db, runId);
    } finally {
      db.close();
    }
  };
  return waitFor(
    () => readRun()?.status === status,
    timeoutMs,
    50,
    () => {
      const db = openDb({ baseDir: home });
      try {
        const observed = getRun(db, runId)?.status ?? "<no run row>";
        const tail = listEvents(db, runId)
          .slice(-12)
          .map((event) => `  #${event.id}${event.node ? ` [${event.node}]` : ""} ${JSON.stringify(event.payload)}`)
          .join("\n");
        return `waiting for run ${runId} status '${status}', observed '${observed}'\ntrace tail:\n${tail || "  <no events>"}`;
      } finally {
        db.close();
      }
    },
  );
}

/**
 * U5: several resume-flow tests simulate a pre-crash run by hand-seeding the
 * DB (checkpoint + pending writes) rather than actually crashing a real
 * engine — that hand-seeded row still needs a real workspace, since every
 * run now executes inside one (R13). Creates it via the same lifecycle
 * `createWorkspace` production code uses, so the test's premise matches
 * what `start` actually produces.
 *
 * U4/R8/KTD-8: also records the workspace-integrity manifest as a trace
 * event, exactly as `main()`'s own `start` path does immediately after
 * `createWorkspace` — without this, every hand-seeded run here would look
 * to `resume` like a workspace whose manifest never got recorded (a real
 * crash between `createWorkspace` and that append, not "a workspace created
 * by some means other than `start`"), and `resume`'s own integrity check
 * would refuse to proceed on every one of these tests. `workspacesRoot`'s
 * parent is `GRAPH_BRO_HOME` (`join(home, "workspaces")` is what every
 * caller passes), so this opens the same store the caller's own `openDb`
 * calls will, briefly, just to append the one event.
 */
export function seedWorkspaceForRun(
  consumerRepoPath: string,
  runId: string,
  workspacesRoot: string,
): { baseRef: string; workspacePath: string; runBranch: string } {
  const baseRef = resolveBaseRef(consumerRepoPath);
  const workspacePath = workspacePathForRun(runId, workspacesRoot);
  const runBranch = runBranchForRun(runId);
  createWorkspace({ consumerRepoPath, baseRefSha: baseRef, workspacePath, runBranch });

  const db = openDb({ baseDir: dirname(workspacesRoot) });
  try {
    const manifest = captureWorkspaceIntegrityManifest(workspacePath);
    appendEvent(db, { runId, payload: { type: WORKSPACE_INTEGRITY_MANIFEST_EVENT_TYPE, manifest } });
  } finally {
    db.close();
  }

  return { baseRef, workspacePath, runBranch };
}

export interface GitShimOptions {
  /**
   * Contiguous argv tokens to intercept, matched anywhere in the real `git`
   * invocation — e.g. `["add", "-A"]`, or a single subcommand token such as
   * `["commit-tree"]` to intercept regardless of the (variable) arguments
   * that follow it.
   */
  match: string[];
  /** stderr text the shim emits on each intercepted invocation. */
  stderr: string;
  /** Exit code for intercepted invocations. Defaults to 1. */
  exitCode?: number;
  /** How many times to intercept before delegating to the real git. Defaults to 1 (one-shot). */
  times?: number;
}

export interface GitShim {
  /** Scratch directory to prepend to `PATH` so this shim's `git` is found first. */
  dir: string;
  /** Removes the scratch directory. */
  cleanup: () => void;
}

/**
 * U6/KTD-20: a deterministic replacement for racing a live background writer
 * against `git`. Writes an executable `git` into a fresh scratch directory
 * that intercepts a matching invocation `times` times (failing it with the
 * given `stderr`/`exitCode`), then delegates every other invocation —
 * matched or not, past the intercept count — to the real, absolutely
 * resolved git, so it is never re-entered via `PATH`. One-shot state lives in
 * a counter file inside the shim's own scratch directory, so two tests using
 * this helper concurrently (each with their own `dir`) never interfere.
 *
 * Reusable beyond U6: a future test intercepting a different subcommand (say
 * `commit-tree` or `commit`, whose trailing arguments vary run to run) can
 * match on just that one token rather than a full trailing argv.
 */
export function createGitShim(options: GitShimOptions): GitShim {
  const { match, stderr, exitCode = 1, times = 1 } = options;
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim().split("\n")[0];
  const dir = mkdtempSync(join(tmpdir(), "graph-bro-git-shim-"));
  const gitPath = join(dir, "git");

  // Bash (not sh) for its arrays: matching an arbitrary-length token sequence
  // anywhere in argv — not just as a trailing suffix — needs a sliding-window
  // comparison over an argv array, which POSIX sh has no clean way to express.
  const script = `#!/bin/bash
set -u
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
REAL_GIT=${JSON.stringify(realGit)}
COUNTER_FILE="$DIR/.shim-count"
MAX_TIMES=${times}
EXIT_CODE=${exitCode}
PATTERN=(${match.map((token) => JSON.stringify(token)).join(" ")})

args=("$@")
n=\${#PATTERN[@]}
matched=0
for ((i = 0; i + n <= \${#args[@]}; i++)); do
  ok=1
  for ((j = 0; j < n; j++)); do
    if [ "\${args[i+j]}" != "\${PATTERN[j]}" ]; then ok=0; break; fi
  done
  if [ "$ok" = "1" ]; then matched=1; break; fi
done

count=0
[ -f "$COUNTER_FILE" ] && count="$(cat "$COUNTER_FILE")"

if [ "$matched" = "1" ] && [ "$count" -lt "$MAX_TIMES" ]; then
  echo $((count + 1)) > "$COUNTER_FILE"
  printf '%s' ${JSON.stringify(stderr)} >&2
  exit "$EXIT_CODE"
fi

exec "$REAL_GIT" "$@"
`;
  writeFileSync(gitPath, script);
  chmodSync(gitPath, 0o755);

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
