import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile } from "../../src/topology/compile.js";
import { REPO_ROOT, FAKE_CLAUDE, gitRepo, runCliSync, waitForRunStatus } from "../fixtures/cli-harness.js";

const EXAMPLE_TOPOLOGY_PATH = join(REPO_ROOT, "examples", "review-fix-loop", "topology.json");

describe("smoke: the shipped review-fix-loop example graph (U10, R27/AE11)", () => {
  let home: string;
  let cwd: string;
  let counterDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "graph-bro-smoke-fix-review-home-"));
    cwd = gitRepo();
    // Inside the test's own temp home, not shared across concurrent test files.
    counterDir = mkdtempSync(join(tmpdir(), "graph-bro-smoke-fix-review-counter-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(counterDir, { recursive: true, force: true });
  });

  function baseEnv(passOnAttempt: number): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GRAPH_BRO_HOME: home,
      GRAPH_BRO_WORKSPACES: join(home, "workspaces"),
      GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE,
      FAKE_CLAUDE_MODE: "fix-review-loop",
      FAKE_CLAUDE_COUNTER_DIR: counterDir,
      FAKE_CLAUDE_PASS_ON_ATTEMPT: String(passOnAttempt),
    };
  }

  it("Covers R13/AE11: the example topology validates via compile()", () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_TOPOLOGY_PATH, "utf-8"));
    const result = compile(raw);
    expect(result.ok).toBe(true);
  });

  it("the review node declares an attempt bound and a write-capable fix node precedes it", () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_TOPOLOGY_PATH, "utf-8"));
    const review = raw.nodes.find((node: { id: string }) => node.id === "review");
    const fix = raw.nodes.find((node: { id: string }) => node.id === "fix");
    expect(review).toMatchObject({ read_only: true, max_attempts: 3 });
    expect(fix).toMatchObject({ read_only: false });
  });

  it(
    "Covers AE11: runs end to end through the built CLI, reaches the converged status, and the loop ran more than one attempt — a first-attempt convergence would fail this test",
    async () => {
      const start = runCliSync(["start", EXAMPLE_TOPOLOGY_PATH], { cwd, env: baseEnv(2) });
      expect(start.status).toBe(0);
      const runId = start.stdout.trim();
      expect(runId).toMatch(/[0-9a-f-]{36}/);

      await waitForRunStatus(home, runId, "completed", 15_000);

      const result = JSON.parse(runCliSync(["result", runId], { cwd, env: baseEnv(2) }).stdout);
      expect(result.status).toBe("completed");

      // The example's declared output_schema validated every scripted review
      // response (an invalid one would have failed the run instead).
      expect(result.output.findings).toEqual({ verdict: "pass", notes: "looks complete" });

      // AE11: more than one attempt ran — review failed attempt 1, passed attempt 2.
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts.map((a: { attempt: number }) => a.attempt)).toEqual([1, 2]);
    },
    20_000,
  );

  it("the run branch carries exactly one commit per attempt", async () => {
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const start = runCliSync(["start", EXAMPLE_TOPOLOGY_PATH], { cwd, env: baseEnv(2) });
    const runId = start.stdout.trim();
    await waitForRunStatus(home, runId, "completed", 15_000);

    const runBranch = `graph-bro/run-${runId}`;
    const messages = execFileSync("git", ["log", "--format=%s", `${baseRef}..${runBranch}`], { cwd, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("attempt 2");
    expect(messages[1]).toContain("attempt 1");

    // The final revision is reachable from the run branch's own handback.
    expect(execFileSync("git", ["show", `${runBranch}:notes.txt`], { cwd, encoding: "utf8" })).toBe("draft 2\n");
  }, 20_000);
});
