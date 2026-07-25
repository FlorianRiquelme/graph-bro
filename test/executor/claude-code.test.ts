import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeExecutor, PROMPT_TOKEN, resolvePromptDelivery } from "../../src/executor/claude-code.js";
import { InMemoryNodeRegistry } from "../../src/executor/executor.js";
import { openDb } from "../../src/store/db.js";
import { appendEvent, listEvents } from "../../src/store/trace.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-claude.mjs");
const LATE_ENVELOPE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-claude-late-envelope.mjs");

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
    // A real read-only node always runs inside a real consumer git repo (KTD-10's
    // premise), so every test gets one — not just the two backstop-focused tests.
    cwd = mkdtempSync(join(tmpdir(), "graph-bro-claude-code-"));
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "test"], { cwd });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd }); // throwaway /tmp repo; no signing agent dependency
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_SILENT_MS;
  });

  it("keeps reading stdout until the stream ends, not until the node process exits", async () => {
    // `exit` fires when the process ends, not when its stdout has been
    // drained, so a CLI that writes its terminal envelope and exits promptly
    // can have that envelope still unread in the pipe. A parent that stops
    // reading at `exit` discards it and reports a *successful* node as failed
    // — exit code 0, no signal, no stderr. That was a ~50% failure of one
    // fan-out branch on the CI runner, invisible on a fast dev machine, which
    // drains the pipe before `exit` is even delivered.
    //
    // The fixture makes that ordering deterministic instead of racing for it
    // (see its header): a grandchild writes the envelope after the node
    // process is already gone, so reading only to `exit` always misses it.
    const executor = new ClaudeCodeExecutor({ binary: LATE_ENVELOPE_FIXTURE });

    const result = await executor.run("ping", {
      cwd,
      nodeId: "reader",
      capability: "read_only",
      model: "claude-haiku-4-5",
      timeout: 10_000,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toBe("written after the parent exited");
    expect(result.cost).toBe(0.001);
  }, 15_000);

  it("streams NDJSON events to the callback while the node runs, terminal event on type === 'result'", async () => {
    process.env.FAKE_CLAUDE_MODE = "success";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE });
    const events: unknown[] = [];
    const timestamps: number[] = [];

    const result = await executor.run("ping", {
      cwd,
      nodeId: "reader",
      capability: "read_only",
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
      nodeId: "reader",
      capability: "read_only",
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
      nodeId: "reader",
      capability: "read_only",
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
      nodeId: "reader",
      capability: "read_only",
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
      nodeId: "reader",
      capability: "read_only",
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
    process.env.FAKE_CLAUDE_MODE = "success";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE });
    let initEvent: { argv: string[] } | undefined;

    await executor.run("attempt an edit", {
      cwd,
      nodeId: "reader",
      capability: "read_only",
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

    // R7 backstop (KTD-10): run() itself enforces this on every read-only completion
    // (see below) — reaching this point without throwing already proves it passed.
  });

  it("Covers R7 backstop (KTD-10): run() raises a loud, node-attributed failure when a read-only node's completion leaves the cwd dirty", async () => {
    // "mutate-cwd": simulates an allowlist gap where something slips through
    // and mutates cwd *during* the node's run — the baseline is captured
    // before this process even spawns, so a pre-existing dirty cwd (U6's
    // rescoped per-node baseline) would not itself trip this.
    process.env.FAKE_CLAUDE_MODE = "mutate-cwd";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE });

    await expect(
      executor.run("ping", { cwd, nodeId: "reader-node", capability: "read_only", model: "claude-haiku-4-5", timeout: 5000 }),
    ).rejects.toThrowError(/reader-node/);
  });

  it("U6: a read-only node activating over a prior write node's uncommitted changes passes its backstop", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    // Stands in for an earlier write node's uncommitted work already sitting
    // in the shared workspace — the per-node baseline is captured *after*
    // this, so it must not fail a read-only node that changed nothing.
    writeFileSync(joinPath(cwd, "left-by-a-write-node.txt"), "uncommitted work\n");

    process.env.FAKE_CLAUDE_MODE = "success";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE });

    await expect(
      executor.run("ping", { cwd, nodeId: "reader-node", capability: "read_only", model: "claude-haiku-4-5", timeout: 5000 }),
    ).resolves.toMatchObject({ isError: false });
  });

  it("Covers AE2/KTD-2: forwards --json-schema on the invocation and surfaces the parsed structured_output, nested object intact", async () => {
    process.env.FAKE_CLAUDE_MODE = "structured";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE });
    let initEvent: { argv: string[] } | undefined;
    const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

    const result = await executor.run("review this", {
      cwd,
      nodeId: "reviewer",
      capability: "read_only",
      model: "claude-haiku-4-5",
      timeout: 5000,
      outputSchema: schema,
      onEvent: (event) => {
        const typed = event as { type?: string; argv?: string[] };
        if (typed.type === "system") initEvent = event as { argv: string[] };
      },
    });

    expect(initEvent?.argv).toContain("--json-schema");
    const schemaArg = initEvent!.argv[initEvent!.argv.indexOf("--json-schema") + 1];
    expect(JSON.parse(schemaArg)).toEqual(schema);

    expect(result.isError).toBe(false);
    expect(typeof result.text).toBe("string"); // the text contract is untouched (KTD-2)
    expect(result.structuredOutput).toEqual({ verdict: "pass", findings: [{ note: "looks good", nested: { depth: 2 } }] });
    expect(result.cost).toBe(0.002);
    expect(result.tokens?.inputTokens).toBe(12);
    expect(result.durationMs).toBe(30);
  });

  it("leaves structuredOutput undefined when no schema is declared (unchanged slice-1 behavior)", async () => {
    process.env.FAKE_CLAUDE_MODE = "success";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE });

    const result = await executor.run("ping", {
      cwd,
      nodeId: "reader",
      capability: "read_only",
      model: "claude-haiku-4-5",
      timeout: 5000,
    });

    expect(result.structuredOutput).toBeUndefined();
    expect(result.text).toBe("pong");
  });

  it("Covers cost capture: envelope tokens/total_cost_usd/duration_ms land in the events row via appendEvent", async () => {
    process.env.FAKE_CLAUDE_MODE = "success";
    const executor = new ClaudeCodeExecutor({ binary: FIXTURE });

    const result = await executor.run("ping", {
      cwd,
      nodeId: "reader",
      capability: "read_only",
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
