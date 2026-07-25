import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("integration/kill-reaping: run-kill cascades through a forked grandchild (KTD-13 + R9 resume)", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "graph-bro-kill-reaping-home-"));
    cwd = gitRepo();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it(
    "a run-kill (signal to the engine pid) reaps BOTH the in-flight fake-claude node process AND its " +
      "SIGTERM-ignoring forked grandchild — then `resume` (with the mode switched to success) completes, " +
      "re-running only the previously-incomplete node, not twice",
    async () => {
      const topologyPath = writeTopology(cwd, singleNodeTopology());
      const grandchildEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GRAPH_BRO_HOME: home,
        GRAPH_BRO_WORKSPACES: join(home, "workspaces"),
        GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE,
        FAKE_CLAUDE_MODE: "grandchild-resist",
      };

      const start = runCliSync(["start", topologyPath], { cwd, env: grandchildEnv });
      expect(start.status).toBe(0);
      const runId = start.stdout.trim();

      const statusJson = JSON.parse(runCliSync(["status", runId], { cwd, env: grandchildEnv }).stdout);
      const ownerPid: number = statusJson.ownerPid;

      // Wait for the fake-claude node process to actually spawn, then find
      // its forked grandchild (spawned NOT detached, so it shares
      // fake-claude's own pgid — see test/fixtures/fake-claude.mjs's
      // "grandchild-resist" mode). Scoped to `pgrep -P ownerPid -f fake-claude`
      // (a child of THIS test's own engine, matched by command line) rather
      // than a bare `-P ownerPid`: U5's workspace creation (git worktree add,
      // etc.) spawns its own short-lived git subprocesses as children of the
      // same engine pid before the node ever dispatches, and a bare `-P`
      // match can transiently catch one of those instead of the node's own
      // long-lived process.
      let fakeClaudePid = "";
      await waitFor(() => {
        const pgrep = spawnSync("pgrep", ["-P", String(ownerPid), "-f", "fake-claude"], { encoding: "utf-8" });
        fakeClaudePid = pgrep.stdout.trim().split("\n")[0] ?? "";
        return fakeClaudePid.length > 0;
      }, 3000);

      let grandchildPid = "";
      await waitFor(() => {
        const pgrep = spawnSync("pgrep", ["-P", fakeClaudePid], { encoding: "utf-8" });
        grandchildPid = pgrep.stdout.trim().split("\n")[0] ?? "";
        return grandchildPid.length > 0;
      }, 3000);
      expect(Number(grandchildPid)).toBeGreaterThan(0);
      expect(isAlive(Number(grandchildPid))).toBe(true); // sanity: the grandchild is really alive before the kill

      process.kill(ownerPid, "SIGTERM"); // KTD-13: the run-kill signal, at RUN scope (the engine's own pid)

      // Both the node process and its grandchild must be gone — proves the
      // group-kill's SIGKILL escalation reaps the SIGTERM-ignoring grandchild
      // too, not just fake-claude.mjs itself.
      await waitFor(() => !isAlive(Number(fakeClaudePid)), 6000);
      await waitFor(() => !isAlive(Number(grandchildPid)), 6000);

      await waitFor(() => !isAlive(ownerPid), 6000); // the engine itself exits after the kill cascade

      // Resume with the mode switched to a normal-completing fake CLI: the
      // previously-incomplete `reader` node re-runs (R9), and the run
      // completes — not a second, still-billing orphan re-run.
      const successEnv: NodeJS.ProcessEnv = { ...grandchildEnv, FAKE_CLAUDE_MODE: "success" };
      const resume = runCliSync(["resume", runId], { cwd, env: successEnv });
      expect(resume.status).toBe(0);
      expect(resume.stdout.trim()).toBe(runId);

      await waitForRunStatus(home, runId, "completed", 5000);

      const result = runCliSync(["result", runId], { cwd, env: successEnv });
      expect(JSON.parse(result.stdout)).toMatchObject({ runId, status: "completed", output: { greeting: "pong" } });

      // Exactly one `node_start` from the pre-kill attempt (killed mid-flight,
      // never completed) and exactly one from the resume attempt that
      // actually finished — the node is re-run once on resume, not twice, and
      // no leftover process double-bills it.
      const tail = runCliSync(["tail", runId], { cwd, env: successEnv });
      const events = tail.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const readerStarts = events.filter((e) => e.node === "reader" && e.payload.type === "node_start");
      const readerCompletes = events.filter((e) => e.node === "reader" && e.payload.type === "node_complete");
      expect(readerStarts).toHaveLength(2); // pre-kill attempt + resume attempt
      expect(readerCompletes).toHaveLength(1); // only the resume attempt actually finished
    },
    20_000,
  );
});
