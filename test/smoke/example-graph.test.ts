import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile } from "../../src/topology/compile.js";
import { openDb } from "../../src/store/db.js";
import { listEvents } from "../../src/store/trace.js";
import { REPO_ROOT, FAKE_CLAUDE, gitRepo, runCliSync, waitForRunStatus } from "../fixtures/cli-harness.js";

const EXAMPLE_TOPOLOGY_PATH = join(REPO_ROOT, "examples", "fanout-read-join", "topology.json");

describe("smoke: the shipped fanout-read-join example graph", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "graph-bro-smoke-home-"));
    cwd = gitRepo();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("the reader node declares read_only: true and a cheap model", () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_TOPOLOGY_PATH, "utf-8"));
    const reader = raw.nodes.find((node: { id: string }) => node.id === "reader");
    expect(reader).toMatchObject({
      kind: "agent",
      read_only: true,
      model: "claude-haiku-4-5",
    });
  });

  it("Covers R13: the example topology validates via compile()", () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_TOPOLOGY_PATH, "utf-8"));
    const result = compile(raw);
    expect(result.ok).toBe(true);
  });

  it(
    "Covers R13: runs end-to-end via the CLI to completion, and the dedup join collapses duplicate reader outputs",
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GRAPH_BRO_HOME: home,
        GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE,
        FAKE_CLAUDE_MODE: "success",
      };

      const start = runCliSync(["start", EXAMPLE_TOPOLOGY_PATH], { cwd, env });
      expect(start.status).toBe(0);
      const runId = start.stdout.trim();
      expect(runId).toMatch(/[0-9a-f-]{36}/);

      // 15s (not 5s): the smoke suite spawns a detached engine per run, and on
      // a 2-core CI runner the parallel process-heavy integration files
      // oversubscribe the CPU — an identical run that finishes in ~350ms locally
      // was starved past 5s in CI (#4). Keep a wide headroom under the per-test
      // timeout so a slow runner can't false-fail a correctness check.
      await waitForRunStatus(home, runId, "completed", 15_000);

      const result = runCliSync(["result", runId], { cwd, env });
      const output = JSON.parse(result.stdout);
      expect(output.status).toBe("completed");

      // The fake CLI answers the same "pong" text for every one of the 3
      // fan-out branches (one per `batch.items` entry) regardless of prompt,
      // so the dedup join must collapse all 3 duplicate outputs to one.
      expect(output.output.results).toEqual(["pong"]);
    },
    20_000,
  );

  it(
    "Covers ADR-0009: an agent node's cost/token/model/duration is captured on its trace event (regression: #3)",
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GRAPH_BRO_HOME: home,
        GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE,
        FAKE_CLAUDE_MODE: "success",
      };

      const start = runCliSync(["start", EXAMPLE_TOPOLOGY_PATH], { cwd, env });
      const runId = start.stdout.trim();
      // 15s wait / 20s test: see the R13 case above — CI CPU starvation, not
      // latency under test, is what timed this out at 5147ms in #4.
      await waitForRunStatus(home, runId, "completed", 15_000);

      const db = openDb({ baseDir: home });
      try {
        const events = listEvents(db, runId);
        // The `reader` node is the only `agent` kind — its completion events must
        // carry the executor's reported cost/usage, not NULL. The fake CLI's
        // success envelope reports total_cost_usd: 0.001, usage {input:10, output:5}.
        const readerCompletions = events.filter(
          (e) => e.node === "reader" && (e.payload as { type?: string } | undefined)?.type === "node_complete",
        );
        expect(readerCompletions).toHaveLength(3);
        for (const event of readerCompletions) {
          expect(event.costUsd).toBe(0.001);
          expect(event.inputTokens).toBe(10);
          expect(event.outputTokens).toBe(5);
          expect(event.model).toBe("claude-haiku-4-5");
          expect(event.durationMs).toBe(30);
        }
      } finally {
        db.close();
      }
    },
    20_000,
  );
});
