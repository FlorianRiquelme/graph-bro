import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/store/db.js";
import { getRun } from "../../src/store/pending-writes.js";
import { FAKE_CLAUDE, gitRepo, isAlive, runCliSync, waitFor, waitForRunStatus } from "../fixtures/cli-harness.js";

function writeTopology(cwd: string, topology: unknown): string {
  const path = join(cwd, "topology.json");
  writeFileSync(path, JSON.stringify(topology));
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "add topology"], { cwd });
  return path;
}

function singleNodeTopology(overrides: Record<string, unknown> = {}) {
  return {
    nodes: [{ id: "reader", kind: "agent", read_only: true, model: "claude-haiku-4-5", prompt: "ping", output_key: "greeting" }],
    edges: [
      { from: "START", to: "reader" },
      { from: "reader", to: "END" },
    ],
    max_steps: 10,
    ...overrides,
  };
}

describe("integration/workspace-isolation: every run executes in its own worktree (U5, R13-R16/R19/AE7)", () => {
  let home: string;
  let workspaces: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "graph-bro-ws-home-"));
    workspaces = join(home, "workspaces");
    cwd = gitRepo();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function baseEnv(mode: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GRAPH_BRO_HOME: home,
      GRAPH_BRO_WORKSPACES: workspaces,
      GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE,
      FAKE_CLAUDE_MODE: mode,
    };
  }

  it("Covers R14: start reports the resolved base ref, and the workspace is created from that exact commit — not a moving branch tip", () => {
    const topologyPath = writeTopology(cwd, singleNodeTopology());
    const expectedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const env = baseEnv("success");

    const start = runCliSync(["start", topologyPath], { cwd, env });
    expect(start.status).toBe(0);
    expect(start.stderr).toContain(expectedSha);
    const runId = start.stdout.trim();

    const db = openDb({ baseDir: home });
    const run = getRun(db, runId);
    db.close();
    expect(run?.baseRef).toBe(expectedSha);
  });

  it("the workspace root is a sibling of the run store's own directory, never inside it — a write node cannot reach the store from its workspace", () => {
    // Unlike every other test in this file, this one does NOT nest
    // GRAPH_BRO_WORKSPACES under `home`: that nesting is a test-cleanup
    // convenience elsewhere, and would defeat the very property asserted here.
    const siblingWorkspaces = mkdtempSync(join(tmpdir(), "graph-bro-ws-sibling-"));
    try {
      const topologyPath = writeTopology(cwd, singleNodeTopology());
      const env = { ...baseEnv("success"), GRAPH_BRO_WORKSPACES: siblingWorkspaces };

      const start = runCliSync(["start", topologyPath], { cwd, env });
      expect(start.status).toBe(0);
      const runId = start.stdout.trim();

      const db = openDb({ baseDir: home });
      const run = getRun(db, runId);
      db.close();
      expect(run?.workspacePath?.startsWith(home)).toBe(false);
      expect(run?.workspacePath?.startsWith(siblingWorkspaces)).toBe(true);
    } finally {
      rmSync(siblingWorkspaces, { recursive: true, force: true });
    }
  });

  it("Covers R13/R16: a read-only node runs inside the workspace, not the consumer's checkout — the consumer stays byte-identical even with a dirty tree at start", async () => {
    const topologyPath = writeTopology(cwd, singleNodeTopology());
    writeFileSync(join(cwd, "dirty.txt"), "uncommitted\n"); // AE7: deliberately dirty at start
    const porcelainBefore = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    const env = baseEnv("success");

    const start = runCliSync(["start", topologyPath], { cwd, env });
    expect(start.status).toBe(0);
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "completed", 10_000);

    const porcelainAfter = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    expect(porcelainAfter).toBe(porcelainBefore);
    expect(readFileSync(join(cwd, "dirty.txt"), "utf8")).toBe("uncommitted\n");

    const result = runCliSync(["result", runId], { cwd, env });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", output: { greeting: "pong" } });
  }, 15_000);

  it("Covers R19: a killed run leaves the consumer's working tree and index untouched", async () => {
    const topologyPath = writeTopology(cwd, singleNodeTopology());
    const porcelainBefore = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    const env = { ...baseEnv("slow"), FAKE_CLAUDE_SILENT_MS: "60000" };

    const start = runCliSync(["start", topologyPath], { cwd, env });
    expect(start.status).toBe(0);
    const runId = start.stdout.trim();

    const statusJson = JSON.parse(runCliSync(["status", runId], { cwd, env }).stdout);
    const ownerPid: number = statusJson.ownerPid;

    process.kill(ownerPid, "SIGTERM");
    await waitFor(() => !isAlive(ownerPid), 6000);

    expect(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })).toBe(porcelainBefore);
  }, 15_000);

  it("a non-git consumer directory refuses to start with a clear error, no run id printed", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "graph-bro-not-a-repo-"));
    try {
      writeFileSync(join(notARepo, "topology.json"), JSON.stringify(singleNodeTopology()));
      const start = runCliSync(["start", "topology.json"], { cwd: notARepo, env: baseEnv("success") });
      expect(start.status).not.toBe(0);
      expect(start.stdout.trim()).toBe("");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("a declared base_ref that does not exist fails before a run id is minted", () => {
    const topologyPath = writeTopology(cwd, singleNodeTopology({ base_ref: "no-such-ref" }));
    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv("success") });
    expect(start.status).not.toBe(0);
    expect(start.stdout.trim()).toBe("");
  });
});
