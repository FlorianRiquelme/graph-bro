import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeExecutor, PROMPT_TOKEN, resolvePromptDelivery } from "../../src/executor/claude-code.js";
import { InMemoryNodeRegistry } from "../../src/executor/executor.js";
import { assertRepoClean } from "../../src/executor/read-only-policy.js";
import { openDb } from "../../src/store/db.js";
import { appendEvent, listEvents } from "../../src/store/trace.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-claude.mjs");

describe("executor: claude-code — prompt delivery (§13.4 compile-time rule)", () => {
  it("substitutes the {prompt} token into argv and closes stdin when the token is present", () => {
    const { argv, stdin } = resolvePromptDelivery(["claude", "-p", PROMPT_TOKEN, "--model", "haiku"], "hello world");

    expect(argv).toEqual(["claude", "-p", "hello world", "--model", "haiku"]);
    expect(stdin).toBeNull();
  });

  it("pipes the whole prompt on stdin when the template has no {prompt} token", () => {
    const { argv, stdin } = resolvePromptDelivery(["claude", "--model", "haiku"], "hello world");

    expect(argv).toEqual(["claude", "--model", "haiku"]);
    expect(stdin).toBe("hello world");
  });
});

describe("executor: claude-code — ClaudeCodeExecutor (real subprocess, scripted fake CLI)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "graph-bro-claude-code-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_SILENT_MS;
  });

  it("streams NDJSON events to the callback while the node runs, terminal event on type === 'result'", async () => {
    process.env.FAKE_CLAUDE_MODE = "success";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE });
    const events: unknown[] = [];
    const timestamps: number[] = [];

    const result = await executor.run("ping", {
      cwd,
      readOnly: true,
      model: "claude-haiku-4-5",
      timeout: 5000,
      onEvent: (event) => {
        events.push(event);
        timestamps.push(Date.now());
      },
    });

    // Incremental appends, not one final line: at least the init + assistant + result events,
    // and they weren't all delivered at the same instant (the fixture sleeps between them).
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect((events[0] as { type: string }).type).toBe("system");
    expect((events[events.length - 1] as { type: string }).type).toBe("result");
    expect(timestamps[timestamps.length - 1] - timestamps[0]).toBeGreaterThan(0);

    expect(result.isError).toBe(false);
    expect(result.text).toBe("pong");
  });

  it("Covers R6 (error path): a valid is_error:true envelope on exit 1 is parsed via is_error/result, not discarded by the non-zero-exit short-circuit", async () => {
    process.env.FAKE_CLAUDE_MODE = "error";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE });

    const result = await executor.run("do something forbidden", {
      cwd,
      readOnly: true,
      model: "claude-haiku-4-5",
      timeout: 5000,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe("permission denied");
  });

  it("registers the node's PGID with the registry on spawn and deregisters it on completion (KTD-13)", async () => {
    process.env.FAKE_CLAUDE_MODE = "success";
    const registry = new InMemoryNodeRegistry();
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE, registry });

    let duringRun: unknown[] = [];
    await executor.run("ping", {
      cwd,
      readOnly: true,
      model: "claude-haiku-4-5",
      timeout: 5000,
      onEvent: () => {
        duringRun = registry.list();
      },
    });

    expect(duringRun.length).toBe(1);
    expect(registry.list()).toHaveLength(0);
  });

  it("heartbeat: silence past the soft threshold emits a heartbeat event; a call under the hard threshold is not killed", async () => {
    process.env.FAKE_CLAUDE_MODE = "slow";
    process.env.FAKE_CLAUDE_SILENT_MS = "250";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE, heartbeatSoftMs: 50, heartbeatPollMs: 20 });
    const events: unknown[] = [];

    const result = await executor.run("ping", {
      cwd,
      readOnly: true,
      model: "claude-haiku-4-5",
      timeout: 5000, // hard threshold far above the 250ms silence — must not fire
      onEvent: (event) => events.push(event),
    });

    const heartbeats = events.filter((e) => (e as { type?: string }).type === "heartbeat") as { level: string }[];
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats.every((h) => h.level === "soft")).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.text).toBe("done");
  });

  it("heartbeat: hard threshold kills the node", async () => {
    process.env.FAKE_CLAUDE_MODE = "slow";
    process.env.FAKE_CLAUDE_SILENT_MS = "5000";
    const executor = new ClaudeCodeExecutor({
      binary: FIXTURE,
      heartbeatSoftMs: 30,
      heartbeatPollMs: 20,
      killGraceMs: 100,
    });
    const events: unknown[] = [];

    const result = await executor.run("ping", {
      cwd,
      readOnly: true,
      model: "claude-haiku-4-5",
      timeout: 100, // hard threshold — must fire well before the 5s silence ends
      onEvent: (event) => events.push(event),
    });

    const hardHeartbeats = events.filter(
      (e) => (e as { type?: string; level?: string }).type === "heartbeat" && (e as { level?: string }).level === "hard",
    );
    expect(hardHeartbeats.length).toBeGreaterThan(0);
    expect(result.isError).toBe(true);
  }, 10_000);

  it("Covers R7: a read-only node is spawned with the mutation-denying allowlist, no --dangerously-skip-permissions, and leaves the cwd clean", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "test"], { cwd });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(cwd, "committed.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });

    process.env.FAKE_CLAUDE_MODE = "success";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE });
    let initEvent: { argv: string[] } | undefined;

    await executor.run("attempt an edit", {
      cwd,
      readOnly: true,
      model: "claude-haiku-4-5",
      timeout: 5000,
      onEvent: (event) => {
        const typed = event as { type?: string; argv?: string[] };
        if (typed.type === "system") initEvent = event as { argv: string[] };
      },
    });

    expect(initEvent?.argv).toContain("--allowedTools");
    const allowlistArg = initEvent!.argv[initEvent!.argv.indexOf("--allowedTools") + 1];
    expect(allowlistArg).toContain("Read");
    expect(allowlistArg).not.toContain("Write");
    expect(initEvent!.argv.join(" ")).not.toContain("--dangerously-skip-permissions");

    // R7 backstop (KTD-10): the fake CLI never touched the fixture's real cwd, so it must still be clean.
    expect(() => assertRepoClean(cwd, "reader")).not.toThrow();
  });

  it("Covers R7 backstop (KTD-10): a dirty cwd after a read-only node's completion raises a loud, node-attributed failure", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "test"], { cwd });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(cwd, "committed.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });

    // Simulate an allowlist gap: something slipped through and mutated the cwd anyway.
    writeFileSync(join(cwd, "mutated-by-slipped-bash.txt"), "oops\n");

    expect(() => assertRepoClean(cwd, "reader-node")).toThrowError(/reader-node/);
  });

  it("Covers cost capture: envelope tokens/total_cost_usd/duration_ms land in the events row via appendEvent", async () => {
    process.env.FAKE_CLAUDE_MODE = "success";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE });

    const result = await executor.run("ping", {
      cwd,
      readOnly: true,
      model: "claude-haiku-4-5",
      timeout: 5000,
    });

    const dbDir = mkdtempSync(join(tmpdir(), "graph-bro-claude-code-db-"));
    const db = openDb({ baseDir: dbDir });
    try {
      appendEvent(db, {
        runId: "run-1",
        node: "reader",
        step: 1,
        model: "claude-haiku-4-5",
        inputTokens: result.tokens?.inputTokens,
        outputTokens: result.tokens?.outputTokens,
        durationMs: result.durationMs,
        costUsd: result.cost,
      });
      const [row] = listEvents(db, "run-1");

      expect(row).toMatchObject({
        model: "claude-haiku-4-5",
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 30,
        costUsd: 0.001,
      });
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
