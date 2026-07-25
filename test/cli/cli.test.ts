import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/store/db.js";
import { writeCheckpoint } from "../../src/store/checkpoints.js";
import { commitPendingWrite, createRun, getRunOwnerPid } from "../../src/store/pending-writes.js";
import { FAKE_CLAUDE, gitRepo, isAlive, runCliSync, seedWorkspaceForRun, waitFor, waitForRunStatus } from "../fixtures/cli-harness.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const FAKE_CLAUDE_FIX_REVIEW = join(FIXTURES_DIR, "fake-claude-fix-review.mjs");

function writeTopology(cwd: string, topology: unknown): string {
  const path = join(cwd, "topology.json");
  writeFileSync(path, JSON.stringify(topology));
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "add topology"], { cwd });
  return path;
}

/** A single read-only reader node -> END. */
function singleNodeTopology() {
  return {
    nodes: [{ id: "reader", kind: "agent", read_only: true, model: "claude-haiku-4-5", prompt: "ping", output_key: "greeting" }],
    edges: [
      { from: "START", to: "reader" },
      { from: "reader", to: "END" },
    ],
    max_steps: 10,
  };
}

/** A two-hop chain (for tail-paging: several trace events across two steps). */
function twoNodeTopology() {
  return {
    nodes: [
      { id: "reader1", kind: "agent", read_only: true, model: "claude-haiku-4-5", prompt: "ping1", output_key: "g1" },
      { id: "reader2", kind: "agent", read_only: true, model: "claude-haiku-4-5", prompt: "ping2", output_key: "g2" },
    ],
    edges: [
      { from: "START", to: "reader1" },
      { from: "reader1", to: "reader2" },
      { from: "reader2", to: "END" },
    ],
    max_steps: 10,
  };
}

/** The mining-shaped fan-out -> join topology (KTD-12): one dynamic fan-out source feeding a size-1-declared-source join. */
function fanOutJoinTopology() {
  return {
    nodes: [
      { id: "dispatch", kind: "set", update: { "batch.items": ["a", "b", "c", "d"] } },
      { id: "reader", kind: "agent", read_only: true, model: "claude-haiku-4-5", prompt: "read ${item}", output_key: "results" },
      { id: "collector", kind: "set", update: { collected: true } },
    ],
    edges: [
      { from: "START", to: "dispatch" },
      { from: "dispatch", for_each: "batch.items", as: "item", to: "reader" },
      { from: ["reader"], mode: "all", reducer: "dedup", into: "results", to: "collector" },
      { from: "collector", to: "END" },
    ],
    max_steps: 10,
  };
}

describe("cli: graph-bro (five verbs + detached process model)", () => {
  let home: string;
  let cwdA: string;
  let cwdB: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "graph-bro-cli-home-"));
    cwdA = gitRepo();
    cwdB = mkdtempSync(join(tmpdir(), "graph-bro-cli-cwdb-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwdA, { recursive: true, force: true });
    rmSync(cwdB, { recursive: true, force: true });
  });

  function baseEnv(mode: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GRAPH_BRO_HOME: home,
      GRAPH_BRO_WORKSPACES: join(home, "workspaces"),
      GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE,
      FAKE_CLAUDE_MODE: mode,
    };
  }

  it("start on a malformed topology fails loudly and produces NO run id", () => {
    const topologyPath = writeTopology(cwdA, { nodes: [], edges: [], max_steps: 1 });

    const result = runCliSync(["start", topologyPath], { cwd: cwdA, env: baseEnv("success") });

    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe(""); // AE5: no run id printed
    expect(result.stderr).toMatch(/not a valid topology/);
  });

  it("start on a topology with a typo'd prompt-token root fails loudly with NO run id (graph-bro#7)", () => {
    const topologyPath = writeTopology(cwdA, {
      nodes: [
        { id: "seed", kind: "set", update: { greeting: "hi" } },
        { id: "reader", kind: "agent", read_only: true, model: "claude-haiku-4-5", prompt: "say {{ greting }}", output_key: "out" },
      ],
      edges: [
        { from: "START", to: "seed" },
        { from: "seed", to: "reader" },
        { from: "reader", to: "END" },
      ],
      max_steps: 10,
    });

    const result = runCliSync(["start", topologyPath], { cwd: cwdA, env: baseEnv("success") });

    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe(""); // no run id printed, nothing spawned
    expect(result.stderr).toMatch(/unresolvable prompt tokens/);
    expect(result.stderr).toMatch(/greting/);
  });

  it("start accepts a prompt-token root supplied only via --input (graph-bro#7)", () => {
    const topologyPath = writeTopology(cwdA, {
      nodes: [
        { id: "reader", kind: "agent", read_only: true, model: "claude-haiku-4-5", prompt: "say {{ seeded }}", output_key: "out" },
      ],
      edges: [
        { from: "START", to: "reader" },
        { from: "reader", to: "END" },
      ],
      max_steps: 10,
    });
    const inputPath = join(cwdA, "input.json");
    writeFileSync(inputPath, JSON.stringify({ seeded: "hello" }));

    const result = runCliSync(["start", topologyPath, "--input", inputPath], { cwd: cwdA, env: baseEnv("success") });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/[0-9a-f-]{36}/);
  });

  it("start surfaces compile lint warnings on stderr while still starting the run", () => {
    // A join whose source is only conditionally reached — lintJoinDesync's case.
    const topologyPath = writeTopology(cwdA, {
      nodes: [
        { id: "router", kind: "set", update: { flag: true } },
        { id: "guarded", kind: "set", update: { a: 1 } },
        { id: "other", kind: "set", update: { b: 2 } },
        { id: "collector", kind: "set", update: { collected: true } },
      ],
      edges: [
        { from: "START", to: "router" },
        { from: "router", to: "guarded", when: { key: "flag", truthy: true } },
        { from: "router", to: "other" },
        { from: ["guarded", "other"], mode: "all", reducer: "merge", into: "joined", to: "collector" },
        { from: "collector", to: "END" },
      ],
      max_steps: 10,
    });

    const result = runCliSync(["start", topologyPath], { cwd: cwdA, env: baseEnv("success") });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/[0-9a-f-]{36}/); // warning is advisory, run still starts
    expect(result.stderr).toMatch(/warning: join 'collector' requires 'guarded'/);
  });

  it(
    "resume re-checks prompt tokens in the engine, failing the run on a topology edited since start (graph-bro#12)",
    async () => {
      // `resume` respawns straight from the recorded topology path, so the
      // `start`-time gate never saw this file. The engine's own re-check is the
      // only thing standing between an edited topology and an ungated run.
      const runId = "resume-bad-token-run";
      const topologyPath = writeTopology(cwdA, {
        nodes: [
          { id: "reader", kind: "agent", read_only: true, model: "claude-haiku-4-5", prompt: "say {{ greting }}", output_key: "out" },
        ],
        edges: [
          { from: "START", to: "reader" },
          { from: "reader", to: "END" },
        ],
        max_steps: 10,
      });
      const env = baseEnv("success");

      const workspace = seedWorkspaceForRun(cwdA, runId, join(home, "workspaces"));
      const db = openDb({ baseDir: home });
      createRun(db, runId, 999_999, topologyPath, workspace); // a dead owner pid, so resume self-heals
      writeCheckpoint(db, runId, {
        state: {},
        frontier: [{ nodeId: "reader", instanceId: "reader" }],
        barrier: {},
        step: 0,
      });
      db.close();

      const resume = runCliSync(["resume", runId], { cwd: cwdA, env });
      expect(resume.status).toBe(0); // the run id already exists; the gate is the engine's

      await waitForRunStatus(home, runId, "failed", 5000);

      const tail = runCliSync(["tail", runId], { cwd: cwdB, env });
      const events = tail.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const runError = events.find((e) => e.payload.type === "run_error");
      expect(runError.payload.error).toMatch(/greting/);
      // The gate fires before any node dispatches.
      expect(events.some((e) => e.payload.type === "node_start")).toBe(false);
    },
    10_000,
  );

  it("resume on a run id that was never started fails loudly with a clear error", () => {
    const result = runCliSync(["resume", "never-started-run-id"], { cwd: cwdA, env: baseEnv("success") });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no such run/);
  });

  it(
    "Covers R18 (KTD-14): resume refuses a pre-workspace-migration run row (null workspace columns) without claiming ownership, and a later resume of the repaired row still works",
    () => {
      const runId = "pre-upgrade-run";
      const topologyPath = writeTopology(cwdA, singleNodeTopology());
      const env = baseEnv("success");
      const deadPid = 999_999;

      const db = openDb({ baseDir: home });
      // No workspace fields: mirrors a run row written before the workspace
      // migration ever ran (or one migrated with a still-null legacy row).
      createRun(db, runId, deadPid, topologyPath);
      db.close();

      const refusal = runCliSync(["resume", runId], { cwd: cwdA, env });
      expect(refusal.status).not.toBe(0);
      expect(refusal.stderr).toMatch(/no recorded workspace/);

      // The refusal happened before the ownership CAS: the dead owner pid is
      // untouched, not left claimed by this (now-exited) resume invocation.
      const dbCheck = openDb({ baseDir: home });
      expect(getRunOwnerPid(dbCheck, runId)).toBe(deadPid);
      dbCheck.close();

      // Once the row is repaired (as a real migration/backfill would do),
      // resume works normally.
      const dbRepair = openDb({ baseDir: home });
      const workspace = seedWorkspaceForRun(cwdA, runId, join(home, "workspaces"));
      createRun(dbRepair, runId, deadPid, topologyPath, workspace);
      dbRepair.close();

      const heal = runCliSync(["resume", runId], { cwd: cwdA, env });
      expect(heal.status).toBe(0);
      expect(heal.stdout.trim()).toBe(runId);
    },
    10_000,
  );

  it("Covers R18: the missing-workspace error is distinguishable from the missing-topology-path error", () => {
    const noTopologyRunId = "no-topology-run";
    const noWorkspaceRunId = "no-workspace-run";
    const topologyPath = writeTopology(cwdA, singleNodeTopology());
    const env = baseEnv("success");

    const db = openDb({ baseDir: home });
    createRun(db, noTopologyRunId, 999_999); // no topology path, no workspace
    createRun(db, noWorkspaceRunId, 999_999, topologyPath); // topology path present, workspace absent
    db.close();

    const noTopology = runCliSync(["resume", noTopologyRunId], { cwd: cwdA, env });
    expect(noTopology.status).not.toBe(0);
    expect(noTopology.stderr).toMatch(/no recorded topology path/);
    expect(noTopology.stderr).not.toMatch(/no recorded workspace/);

    const noWorkspace = runCliSync(["resume", noWorkspaceRunId], { cwd: cwdA, env });
    expect(noWorkspace.status).not.toBe(0);
    expect(noWorkspace.stderr).toMatch(/no recorded workspace/);
    expect(noWorkspace.stderr).not.toMatch(/no recorded topology path/);
  });

  it("Covers AE5: start returns promptly with a run id while the engine continues detached", async () => {
    const topologyPath = writeTopology(cwdA, singleNodeTopology());
    const env = { ...baseEnv("slow"), FAKE_CLAUDE_SILENT_MS: "1500" };

    const startedAt = Date.now();
    const result = runCliSync(["start", topologyPath], { cwd: cwdA, env });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(0);
    expect(elapsedMs).toBeLessThan(1000); // well under the 1500ms node sleep
    const runId = result.stdout.trim();
    expect(runId).toMatch(/[0-9a-f-]{36}/);

    const immediateStatus = runCliSync(["status", runId], { cwd: cwdB, env });
    expect(JSON.parse(immediateStatus.stdout).status).toBe("running");

    await waitForRunStatus(home, runId, "completed", 5000);
  }, 10_000);

  it("status/tail/result read correct state when invoked from a different cwd than start ran", async () => {
    const topologyPath = writeTopology(cwdA, singleNodeTopology());
    const env = baseEnv("success");

    const start = runCliSync(["start", topologyPath], { cwd: cwdA, env });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "completed", 5000);

    const status = runCliSync(["status", runId], { cwd: cwdB, env });
    expect(JSON.parse(status.stdout)).toMatchObject({ runId, status: "completed" });

    const result = runCliSync(["result", runId], { cwd: cwdB, env });
    expect(JSON.parse(result.stdout)).toMatchObject({ runId, status: "completed", output: { greeting: "pong" } });

    const tail = runCliSync(["tail", runId], { cwd: cwdB, env });
    const events = tail.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.node === "reader" && e.payload.type === "node_complete")).toBe(true);
  }, 10_000);

  it("tail pages events incrementally by cursor", async () => {
    const topologyPath = writeTopology(cwdA, twoNodeTopology());
    const env = baseEnv("success");

    const start = runCliSync(["start", topologyPath], { cwd: cwdA, env });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "completed", 5000);

    const full = runCliSync(["tail", runId], { cwd: cwdB, env });
    const allEvents = full.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(allEvents.length).toBeGreaterThanOrEqual(4); // 2 nodes x (start, complete)

    // Page through 2 at a time and confirm no repeats / no gaps against the full read above.
    let cursor = 0;
    const paged: unknown[] = [];
    for (let i = 0; i < allEvents.length; i += 2) {
      const page = runCliSync(["tail", runId, "--cursor", String(cursor), "--limit", "2"], { cwd: cwdB, env });
      const events = page.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(events.length).toBeGreaterThan(0);
      paged.push(...events);
      cursor = events[events.length - 1].id;
    }
    expect(paged).toEqual(allEvents);
  }, 10_000);

  it(
    "resume <run_id> restores join-barrier state (KTD-12) and completes without re-executing already-completed fan-out branches",
    async () => {
      const runId = "resume-fanout-run";
      const topologyPath = writeTopology(cwdA, fanOutJoinTopology());
      const env = baseEnv("success");

      // Simulate a crash: 2 of the 4 fan-out branches already committed their
      // pending write; the checkpoint's frontier still lists all 4.
      const workspace = seedWorkspaceForRun(cwdA, runId, join(home, "workspaces"));
      const db = openDb({ baseDir: home });
      createRun(db, runId, 999_999, topologyPath, workspace); // a dead owner pid
      // items are plain strings (no `id` field), so deriveItemKey derives
      // "idx:${i}" for each — must match here for resume() to line up.
      writeCheckpoint(db, runId, {
        state: { batch: { items: ["a", "b", "c", "d"] } },
        frontier: [
          { nodeId: "reader", instanceId: "reader:idx:0", binding: { key: "item", value: "a" } },
          { nodeId: "reader", instanceId: "reader:idx:1", binding: { key: "item", value: "b" } },
          { nodeId: "reader", instanceId: "reader:idx:2", binding: { key: "item", value: "c" } },
          { nodeId: "reader", instanceId: "reader:idx:3", binding: { key: "item", value: "d" } },
        ],
        barrier: {},
        step: 0,
      });
      commitPendingWrite(db, {
        runId,
        node: "reader",
        step: 1,
        itemKey: "idx:0",
        triggers: [],
        writes: { results: "a" },
      });
      commitPendingWrite(db, {
        runId,
        node: "reader",
        step: 1,
        itemKey: "idx:1",
        triggers: [],
        writes: { results: "b" },
      });
      db.close();

      const resume = runCliSync(["resume", runId], { cwd: cwdA, env });
      expect(resume.status).toBe(0);
      expect(resume.stdout.trim()).toBe(runId);

      await waitForRunStatus(home, runId, "completed", 5000);

      const result = runCliSync(["result", runId], { cwd: cwdB, env });
      const output = JSON.parse(result.stdout);
      expect(output.status).toBe("completed");
      // "a"/"b" survive from the pre-crash pending writes; the fake CLI always
      // answers "pong" regardless of prompt, so both live-executed branches
      // (reader:2, reader:3) write the same value — dedup collapses them to one.
      expect(new Set(output.output.results)).toEqual(new Set(["a", "b", "pong"]));

      // Only the 2 not-yet-completed branches re-executed this resume run (not all 4).
      const tail = runCliSync(["tail", runId], { cwd: cwdB, env });
      const events = tail.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const readerStarts = events.filter((e) => e.node === "reader" && e.payload.type === "node_start");
      expect(readerStarts).toHaveLength(2);
    },
    10_000,
  );

  it(
    "Covers R9 (single-owner, KTD-14): resume refuses while the owner is alive, self-heals once the owner is dead",
    async () => {
      const topologyPath = writeTopology(cwdA, singleNodeTopology());
      const slowEnv = { ...baseEnv("slow"), FAKE_CLAUDE_SILENT_MS: "5000" };

      const start = runCliSync(["start", topologyPath], { cwd: cwdA, env: slowEnv });
      const runId = start.stdout.trim();

      const statusJson = JSON.parse(runCliSync(["status", runId], { cwd: cwdB, env: slowEnv }).stdout);
      const ownerPid: number = statusJson.ownerPid;

      const refusal = runCliSync(["resume", runId], { cwd: cwdA, env: slowEnv });
      expect(refusal.status).not.toBe(0);
      expect(refusal.stderr).toMatch(/still owned by live process/);

      // Wait for the node to actually be in flight (its pre-dispatch checkpoint
      // written) before killing — otherwise this races the engine's own
      // start-up work (workspace creation, U6's consumer-baseline capture)
      // against the kill, and a crash landing before the *first* checkpoint
      // ever exists resumes with an empty frontier instead of a genuine
      // mid-attempt crash (the scenario this test simulates). Mirrors
      // kill-reaping.test.ts's precedent of synchronizing on the node being
      // in flight rather than firing the kill on a fixed timing assumption.
      await waitFor(() => {
        const db = openDb({ baseDir: home });
        try {
          return db.prepare("select 1 from checkpoints where run_id = ?").get(runId) !== undefined;
        } finally {
          db.close();
        }
      }, 3000);

      // Simulate a hard crash (bypasses graceful shutdown/kill cascade entirely).
      process.kill(ownerPid, "SIGKILL");
      await waitFor(() => !isAlive(ownerPid), 3000);

      const successEnv = baseEnv("success");
      const heal = runCliSync(["resume", runId], { cwd: cwdA, env: successEnv });
      expect(heal.status).toBe(0);
      expect(heal.stdout.trim()).toBe(runId);

      await waitForRunStatus(home, runId, "completed", 5000);
    },
    15_000,
  );

  it(
    "Covers KTD-13: a run-kill (signal to the engine pid) cascades the group-kill to the in-flight node's PGID — no orphaned subprocess",
    async () => {
      const topologyPath = writeTopology(cwdA, singleNodeTopology());
      const env = { ...baseEnv("slow"), FAKE_CLAUDE_SILENT_MS: "8000" };

      const start = runCliSync(["start", topologyPath], { cwd: cwdA, env });
      const runId = start.stdout.trim();

      const statusJson = JSON.parse(runCliSync(["status", runId], { cwd: cwdB, env }).stdout);
      const ownerPid: number = statusJson.ownerPid;

      // Give the engine time to actually spawn the fake-claude subprocess, and
      // capture its pid — scoped to `pgrep -P ownerPid` (a child of THIS
      // test's own engine), not `pgrep -f fake-claude.mjs` (a global name
      // match that races against other test files' concurrently-running
      // fake-claude processes, e.g. kill-reaping.test.ts). Once known,
      // re-checks use isAlive directly rather than spawning pgrep again.
      let fakeClaudePid = "";
      await waitFor(() => {
        const pgrep = spawnSync("pgrep", ["-P", String(ownerPid)], { encoding: "utf-8" });
        fakeClaudePid = pgrep.stdout.trim().split("\n")[0] ?? "";
        return fakeClaudePid.length > 0;
      }, 3000);

      process.kill(ownerPid, "SIGTERM"); // KTD-13: the run-kill signal

      await waitFor(() => !isAlive(Number(fakeClaudePid)), 5000);
      await waitFor(() => !isAlive(ownerPid), 5000);
    },
    15_000,
  );
});

describe("cli: graph-bro result/status — trace and reporting (U9, R24/R25/R26)", () => {
  let home: string;
  let cwd: string;
  let counterDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "graph-bro-trace-home-"));
    cwd = gitRepo();
    counterDir = mkdtempSync(join(tmpdir(), "graph-bro-trace-counter-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(counterDir, { recursive: true, force: true });
  });

  function fixReviewEnv(passOnAttempt: number): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GRAPH_BRO_HOME: home,
      GRAPH_BRO_WORKSPACES: join(home, "workspaces"),
      GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE_FIX_REVIEW,
      FAKE_CLAUDE_COUNTER_DIR: counterDir,
      FAKE_CLAUDE_PASS_ON_ATTEMPT: String(passOnAttempt),
    };
  }

  function fixReviewLoopTopology(maxAttempts: number) {
    return {
      nodes: [
        {
          id: "writer",
          kind: "agent",
          read_only: false,
          model: "claude-haiku-4-5",
          prompt: JSON.stringify({ write: { path: "work.txt", content: "attempt" } }),
          output_key: "written",
        },
        {
          id: "review",
          kind: "agent",
          read_only: true,
          model: "claude-haiku-4-5",
          prompt: "review the work",
          output_key: "verdict",
          output_schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
          max_attempts: maxAttempts,
        },
      ],
      edges: [
        { from: "START", to: "writer" },
        { from: "writer", to: "review" },
        { from: "review", to: "writer", when: { key: "verdict.verdict", equals: "fail" } },
        { from: "review", to: "END", when: { key: "verdict.verdict", equals: "pass" } },
      ],
      max_steps: 20,
    };
  }

  /** Every `node_complete` event's cost, straight off the trace — independent of `aggregateAttempts`'s own grouping, so it's a fair thing to compare the per-attempt sum against (U12/R20). */
  function totalNodeCompleteCost(runId: string, env: NodeJS.ProcessEnv): number {
    const events = runCliSync(["tail", runId], { cwd, env })
      .stdout.trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return events
      .filter((e) => e.payload?.type === "node_complete")
      .reduce((sum: number, e: { costUsd?: number }) => sum + (e.costUsd ?? 0), 0);
  }

  it("Covers R26: a four-attempt run's result shows exactly four per-attempt attributions, each with tokens and USD", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(5));
    const start = runCliSync(["start", topologyPath], { cwd, env: fixReviewEnv(4) });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "completed", 10_000);

    const result = JSON.parse(runCliSync(["result", runId], { cwd, env: fixReviewEnv(4) }).stdout);
    expect(result.status).toBe("completed");
    expect(result.attempts).toHaveLength(4);
    expect(result.attempts.map((a: { attempt: number }) => a.attempt)).toEqual([1, 2, 3, 4]);
    for (const attempt of result.attempts) {
      expect(attempt.inputTokens).toBeGreaterThan(0);
      expect(attempt.outputTokens).toBeGreaterThan(0);
      expect(attempt.costUsd).toBeGreaterThan(0);
    }
    // U12/R20: the assertion that would have caught the dropped-attempt-zero
    // bucket — every node_complete's cost must land in some attempt, so the
    // per-attempt sum must equal the run's real total.
    const attemptedCost = result.attempts.reduce((sum: number, a: { costUsd: number }) => sum + a.costUsd, 0);
    expect(attemptedCost).toBeCloseTo(totalNodeCompleteCost(runId, fixReviewEnv(4)), 5);
  }, 20_000);

  it("Covers R20: a three-attempt loop's per-attempt costs sum to the run's total node-completion cost, with no invocation unattributed", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(5));
    const start = runCliSync(["start", topologyPath], { cwd, env: fixReviewEnv(3) });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "completed", 10_000);

    const result = JSON.parse(runCliSync(["result", runId], { cwd, env: fixReviewEnv(3) }).stdout);
    expect(result.status).toBe("completed");

    const attemptedCost = result.attempts.reduce((sum: number, a: { costUsd: number }) => sum + a.costUsd, 0);
    expect(attemptedCost).toBeCloseTo(totalNodeCompleteCost(runId, fixReviewEnv(3)), 5);

    // The dropped bucket was always the write node's *first* invocation,
    // stamped attempt 0 before the bounded node's own hook ever advanced the
    // shared counter. It must land in attempt one instead.
    const events = runCliSync(["tail", runId], { cwd, env: fixReviewEnv(3) })
      .stdout.trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const writerFirstComplete = events.find((e) => e.node === "writer" && e.payload?.type === "node_complete");
    expect(writerFirstComplete.step).toBe(1);
  }, 20_000);

  it(
    "Covers R20: a resumed run's attempt attribution continues from the recorded counts rather than restarting",
    async () => {
      const runId = "resume-attempt-attribution-run";
      const topologyPath = writeTopology(cwd, fixReviewLoopTopology(5));
      const env = fixReviewEnv(1); // the resumed review call is its counter's first real call — pass immediately

      // Simulate a crash after 2 attempts already completed (review's own
      // hook committed attempt 2), with the frontier back at the write node
      // for what would be attempt 3.
      const workspace = seedWorkspaceForRun(cwd, runId, join(home, "workspaces"));
      const db = openDb({ baseDir: home });
      createRun(db, runId, 999_999, topologyPath, workspace); // a dead owner pid, so resume self-heals
      writeCheckpoint(db, runId, {
        state: {},
        frontier: [{ nodeId: "writer", instanceId: "writer" }],
        barrier: {},
        step: 2,
        attempts: { review: 2 },
      });
      db.close();

      const resume = runCliSync(["resume", runId], { cwd, env });
      expect(resume.status).toBe(0);

      await waitForRunStatus(home, runId, "completed", 10_000);

      const events = runCliSync(["tail", runId], { cwd, env })
        .stdout.trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      // Continuing from the recorded count of 2, not restarting at 0 or 1:
      // the resumed writer picks up the seeded counter (attempt 2), and
      // review's own hook then advances it to 3.
      const writerComplete = events.find((e) => e.node === "writer" && e.payload?.type === "node_complete");
      const reviewComplete = events.find((e) => e.node === "review" && e.payload?.type === "node_complete");
      expect(writerComplete.step).toBe(2);
      expect(reviewComplete.step).toBe(3);
    },
    15_000,
  );

  it("Covers R25: the three stop reasons are distinguishable in result's output — converged, bound hit, and failed", async () => {
    const convergedCwd = gitRepo();
    const failedCwd = gitRepo();
    try {
      const convergedTopologyPath = writeTopology(convergedCwd, fixReviewLoopTopology(5));
      const convergedStart = runCliSync(["start", convergedTopologyPath], { cwd: convergedCwd, env: fixReviewEnv(1) });
      const convergedRunId = convergedStart.stdout.trim();
      await waitForRunStatus(home, convergedRunId, "completed", 10_000);
      const convergedResult = JSON.parse(runCliSync(["result", convergedRunId], { cwd: convergedCwd, env: fixReviewEnv(1) }).stdout);
      expect(convergedResult.status).toBe("completed");
      expect(convergedResult.error).toBeUndefined();

      const boundTopologyPath = writeTopology(cwd, fixReviewLoopTopology(2));
      const boundStart = runCliSync(["start", boundTopologyPath], { cwd, env: fixReviewEnv(99) });
      const boundRunId = boundStart.stdout.trim();
      await waitForRunStatus(home, boundRunId, "not_converged", 10_000);
      const boundResult = JSON.parse(runCliSync(["result", boundRunId], { cwd, env: fixReviewEnv(99) }).stdout);
      expect(boundResult.status).toBe("not_converged");
      expect(boundResult.error).toBeUndefined(); // not a failure — distinct from it

      // A real runtime failure (not the CLI's own start-time validation
      // gate): max_steps exceeded before the never-converging loop ever
      // reaches its attempt bound, so `result.error` carries a real message.
      const failedTopologyPath = writeTopology(failedCwd, { ...fixReviewLoopTopology(99), max_steps: 2 });
      const failedStart = runCliSync(["start", failedTopologyPath], { cwd: failedCwd, env: fixReviewEnv(99) });
      const failedRunId = failedStart.stdout.trim();
      await waitForRunStatus(home, failedRunId, "failed", 10_000);
      const failedResult = JSON.parse(runCliSync(["result", failedRunId], { cwd: failedCwd, env: fixReviewEnv(99) }).stdout);
      expect(failedResult.status).toBe("failed");
      expect(failedResult.error).toBeTruthy();
    } finally {
      rmSync(convergedCwd, { recursive: true, force: true });
      rmSync(failedCwd, { recursive: true, force: true });
    }
  }, 20_000);

  it("a slice-1-shaped read-only run's result/status output is unchanged — no attempts or error keys appear", async () => {
    const topologyPath = writeTopology(cwd, singleNodeTopology());
    const env = {
      ...process.env,
      GRAPH_BRO_HOME: home,
      GRAPH_BRO_WORKSPACES: join(home, "workspaces"),
      GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE,
      FAKE_CLAUDE_MODE: "success",
    };
    const start = runCliSync(["start", topologyPath], { cwd, env });
    const runId = start.stdout.trim();
    await waitForRunStatus(home, runId, "completed", 10_000);

    const result = JSON.parse(runCliSync(["result", runId], { cwd, env }).stdout);
    expect(Object.keys(result).sort()).toEqual(["output", "runId", "status"]);

    const status = JSON.parse(runCliSync(["status", runId], { cwd, env }).stdout);
    expect(Object.keys(status).sort()).toEqual(["createdAt", "ownerPid", "runId", "status"]);
  }, 15_000);

  it("Covers R24: a routing decision (rule, values read) and a node's structured output are both readable from the trace", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(5));
    const start = runCliSync(["start", topologyPath], { cwd, env: fixReviewEnv(1) });
    const runId = start.stdout.trim();
    await waitForRunStatus(home, runId, "completed", 10_000);

    const events = runCliSync(["tail", runId], { cwd, env: fixReviewEnv(1) })
      .stdout.trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const routing = events.find((e) => e.payload.type === "routing_decision" && e.payload.result === true);
    expect(routing).toBeDefined();
    expect(routing.payload.rule).toEqual({ key: "verdict.verdict", equals: "pass" });
    expect(routing.payload.reads).toBeDefined();

    const reviewComplete = events.find((e) => e.node === "review" && e.payload.type === "node_complete");
    expect(reviewComplete.payload.update.verdict).toEqual({ verdict: "pass" });
  }, 15_000);
});
