import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "run.js");

/**
 * Spawns the detached engine (`runtime/run.js`) in its own process group,
 * stdio ignored, unref'd (ADR-0004) — shared by `start` and `resume`, whose
 * only difference is the argv they pass. Returns the child's pid, or
 * `undefined` if the spawn failed to produce one.
 */
export function spawnDetachedEngine(args: string[]): number | undefined {
  const child = spawn(process.execPath, [RUNTIME_ENTRY, ...args], {
    detached: true,
    stdio: "ignore",
  });
  // Without this, an async spawn failure (EMFILE/ENOMEM/permission issues)
  // fires an unhandled 'error' event that crashes the CLI process itself.
  child.on("error", () => {});
  if (child.pid === undefined) return undefined;
  child.unref();
  return child.pid;
}
