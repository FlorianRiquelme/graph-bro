import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/store/db.js";
import { writeCheckpoint } from "../../src/store/checkpoints.js";
import { commitPendingWrite, createRun } from "../../src/store/pending-writes.js";
import { FAKE_CLAUDE, gitRepo, isAlive, runCliSync, waitFor, waitForRunStatus } from "../fixtures/cli-harness.js";

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

  it("resume on a run id that was never started fails loudly with a clear error", () => {
    const result = runCliSync(["resume", "never-started-run-id"], { cwd: cwdA, env: baseEnv("success") });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no such run/);
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
      const db = openDb({ baseDir: home });
      createRun(db, runId, 999_999, topologyPath); // a dead owner pid
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
