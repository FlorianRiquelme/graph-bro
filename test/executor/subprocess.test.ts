import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { killProcessGroup, spawnDetached } from "../../src/executor/subprocess.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-claude.mjs");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("executor: subprocess", () => {
  it("spawnDetached assigns pid === pgid (own process group)", () => {
    const spawned = spawnDetached(FIXTURE, [], { cwd: process.cwd(), stdinMode: "closed" });
    expect(spawned.pgid).toBe(spawned.pid);
    return killProcessGroup(spawned.pgid, spawned.child, 200);
  });

  it("group-kill reaps a spawned child AND a SIGTERM-ignoring grandchild it forked (§14.7)", async () => {
    const spawned = spawnDetached(FIXTURE, [], {
      cwd: process.cwd(),
      stdinMode: "closed",
      env: { ...process.env, FAKE_CLAUDE_MODE: "grandchild-resist" },
    });

    const grandchildPid: number = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("timed out waiting for grandchild_pid")), 5000);
      spawned.child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const line = buffer.split("\n").find((l) => l.trim().length > 0);
        if (line) {
          clearTimeout(timer);
          resolve((JSON.parse(line) as { pid: number }).pid);
        }
      });
    });

    expect(isAlive(spawned.pid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    await killProcessGroup(spawned.pgid, spawned.child, 300);

    expect(isAlive(spawned.pid)).toBe(false);
    expect(isAlive(grandchildPid)).toBe(false);
  }, 10_000);

  it("killProcessGroup resolves immediately for an already-exited child", async () => {
    const spawned = spawnDetached(FIXTURE, [], {
      cwd: process.cwd(),
      stdinMode: "closed",
      env: { ...process.env, FAKE_CLAUDE_MODE: "success" },
    });

    await new Promise<void>((resolve) => spawned.child.once("exit", () => resolve()));

    await expect(killProcessGroup(spawned.pgid, spawned.child, 200)).resolves.toBeUndefined();
  });
});
