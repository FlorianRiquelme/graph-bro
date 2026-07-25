import { spawn, type ChildProcess } from "node:child_process";

export interface SpawnedProcess {
  child: ChildProcess;
  pid: number;
  /** The process-group id. Equal to `pid` — `detached: true` makes the child its own group leader (§14.7). */
  pgid: number;
  /**
   * The tail of the child's stderr, capped at `STDERR_TAIL_LIMIT`. stderr has
   * to be drained regardless (an unread pipe backpressures and eventually
   * stalls the child), so retaining the tail of what is already being read
   * costs a bounded buffer and turns an otherwise silent death — a child that
   * exits before emitting a terminal envelope — into a reportable cause.
   */
  stderrTail: () => string;
}

/** Enough for a stack trace or a CLI usage error; small enough to keep in memory per in-flight node. */
const STDERR_TAIL_LIMIT = 8192;

export interface SpawnOptions {
  cwd: string;
  /** "closed" → stdin is not connected (prompt delivered as an argv token); "piped" → stdin is writable. */
  stdinMode: "closed" | "piped";
  /** Defaults to the current process's environment. */
  env?: NodeJS.ProcessEnv;
}

/** Spawns a detached child in its own process group so a later group-kill reaches every descendant, not just this child (§14.7). */
export function spawnDetached(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: [options.stdinMode === "piped" ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) {
    throw new Error(`failed to spawn '${command}': no pid assigned`);
  }
  // Drain stderr so an unread pipe never backpressures the child, keeping only
  // the tail — the whole stream is unbounded (a chatty CLI can emit megabytes),
  // but the last few KB is what names the cause when the child dies early.
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
  });
  return { child, pid: child.pid, pgid: child.pid, stderrTail: () => stderrTail };
}

/**
 * Group-kill (§14.7): SIGTERM the whole process group, escalating to SIGKILL
 * after `graceMs` if it hasn't exited. Reaps orphaned grandchildren the child
 * forked (e.g. a SIGTERM-ignoring helper process), not just the direct
 * child — a single `child.kill()` cannot reach those. Safe to call on an
 * already-exited process (ESRCH is swallowed); resolves once the child has
 * actually exited.
 */
export function killProcessGroup(pgid: number, child: ChildProcess, graceMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);

    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      // Group already gone.
      finish();
      return;
    }

    const timer = setTimeout(() => {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Group already gone by the time the grace period elapsed.
      }
    }, graceMs);
  });
}

/**
 * Fire-and-forget process-group signal (KTD-13's run-kill cascade): the
 * runtime's in-flight node registry only survives pid/pgid across an
 * `executor.run()` call, not the `ChildProcess` handle `killProcessGroup`
 * needs to await confirmed exit — so this just signals, swallowing ESRCH
 * (already-exited).
 */
export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}
