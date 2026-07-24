import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/store/db.js";
import { getRun } from "../../src/store/pending-writes.js";

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

export async function waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 50): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Polls a run's status directly against the SQLite store (`GRAPH_BRO_HOME`)
 * instead of shelling out to a full CLI subprocess every tick — a poll loop
 * driving `status` through `runCliSync` pays a fresh Node start + native
 * `better-sqlite3` load per tick, which adds up over a 5-20s wait.
 */
export function waitForRunStatus(home: string, runId: string, status: string, timeoutMs: number): Promise<void> {
  return waitFor(() => {
    const db = openDb({ baseDir: home });
    try {
      return getRun(db, runId)?.status === status;
    } finally {
      db.close();
    }
  }, timeoutMs);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
