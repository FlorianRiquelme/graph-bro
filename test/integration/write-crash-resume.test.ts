import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/store/db.js";
import { readLatestCheckpoint, writeCheckpoint } from "../../src/store/checkpoints.js";
import { listEvents } from "../../src/store/trace.js";
import { ATTEMPT_BOUNDARY_EVENT_TYPE, partialAttemptRef } from "../../src/workspace/commit.js";
import { gitRepo, isAlive, runCliSync, waitFor, waitForRunStatus } from "../fixtures/cli-harness.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const FAKE_CLAUDE_WRITE_THEN_HANG = join(FIXTURES_DIR, "fake-claude-write-then-hang.mjs");
const FAKE_CLAUDE_FIX_REVIEW = join(FIXTURES_DIR, "fake-claude-fix-review.mjs");
const FAKE_CLAUDE_STATIC_REVIEW_HANG = join(FIXTURES_DIR, "fake-claude-static-review-hang.mjs");

function writeTopology(cwd: string, topology: unknown): string {
  const path = join(cwd, "topology.json");
  writeFileSync(path, JSON.stringify(topology));
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "add topology"], { cwd });
  return path;
}

/** A fix/review loop: `review` is bounded and re-enters `writer` until its verdict flips to "pass". */
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

describe("integration/write-crash-resume: a killed write run resumes from its last committed attempt (U8, R23/AE9)", () => {
  let home: string;
  let workspaces: string;
  let cwd: string;
  let counterDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "graph-bro-write-crash-home-"));
    workspaces = join(home, "workspaces");
    cwd = gitRepo();
    counterDir = mkdtempSync(join(tmpdir(), "graph-bro-write-crash-counter-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(counterDir, { recursive: true, force: true });
  });

  function baseEnv(binary: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GRAPH_BRO_HOME: home,
      GRAPH_BRO_WORKSPACES: workspaces,
      GRAPH_BRO_CLAUDE_BINARY: binary,
      FAKE_CLAUDE_COUNTER_DIR: counterDir,
    };
  }

  it("Covers AE9/R19: a run killed mid-first-attempt preserves the partial write as a side ref, leaves the consumer untouched, and resume converges from a clean workspace", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(5));
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const consumerPorcelainBefore = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });

    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_WRITE_THEN_HANG), FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" },
    });
    const runId = start.stdout.trim();
    expect(runId).not.toBe("");

    // Wait for the writer's in-flight file to actually land on disk (the
    // node itself then hangs, standing in for "still working") before
    // killing — otherwise this races the write against the kill.
    const workspacePath = join(workspaces, runId);
    await waitFor(() => {
      try {
        return readFileSync(join(workspacePath, "work.txt"), "utf8").length > 0;
      } catch {
        return false;
      }
    }, 5000);

    const statusJson = JSON.parse(runCliSync(["status", runId], { cwd, env: baseEnv(FAKE_CLAUDE_WRITE_THEN_HANG) }).stdout);
    const ownerPid: number = statusJson.ownerPid;
    process.kill(ownerPid, "SIGKILL");
    await waitFor(() => !isAlive(ownerPid), 3000);

    // Nothing committed yet (review's before-invocation hook never fired for
    // this, the very first, attempt) — the crash left the write only on disk.
    expect(
      execFileSync("git", ["log", "--format=%s", `${baseRef}..graph-bro/run-${runId}`], { cwd, encoding: "utf8" }).trim(),
    ).toBe("");

    const resume = runCliSync(["resume", runId], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" },
    });
    expect(resume.status).toBe(0);

    await waitForRunStatus(home, runId, "completed", 10_000);

    // The interrupted attempt is preserved and reachable, not silently discarded.
    // `partialAttemptRef` returns the run's namespace prefix, not a single ref
    // (KTD-13) — enumerate it, since only one kill-and-resume cycle happened here.
    const partialRefs = execFileSync(
      "git",
      ["for-each-ref", "--format=%(objectname)", partialAttemptRef(runId)],
      { cwd, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    expect(partialRefs).toHaveLength(1);
    const partialSha = partialRefs[0];
    expect(partialSha).toBeTruthy();
    expect(execFileSync("git", ["show", `${partialSha}:work.txt`], { cwd, encoding: "utf8" })).toBe("attempt-1");

    // The resumed run re-entered cleanly and converged on its (fresh) first attempt.
    const runBranch = `graph-bro/run-${runId}`;
    expect(execFileSync("git", ["show", `${runBranch}:work.txt`], { cwd, encoding: "utf8" })).toBe("attempt-1");
    expect(
      execFileSync("git", ["log", "--format=%s", `${baseRef}..${runBranch}`], { cwd, encoding: "utf8" }).trim().split("\n"),
    ).toHaveLength(1); // exactly one attempt commit — the killed attempt was discarded, not folded in twice

    // R19: the consumer's own tree/index never moved, across the kill and the resume.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })).toBe(consumerPorcelainBefore);
  }, 20_000);

  it("a run resumed after exhausting its attempts halts immediately in not_converged, spending no fresh attempts", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(2));
    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "99" },
    });
    const runId = start.stdout.trim();
    await waitForRunStatus(home, runId, "not_converged", 10_000);

    const runBranch = `graph-bro/run-${runId}`;
    const commitsBefore = execFileSync("git", ["rev-list", "--count", runBranch], { cwd, encoding: "utf8" }).trim();

    const resume = runCliSync(["resume", runId], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "99" },
    });
    expect(resume.status).toBe(0);
    await waitForRunStatus(home, runId, "not_converged", 5000);

    // Immediate: the bound check refuses the over-the-bound activation before
    // dispatching anything, so no new commit and no new node work occur.
    const commitsAfter = execFileSync("git", ["rev-list", "--count", runBranch], { cwd, encoding: "utf8" }).trim();
    expect(commitsAfter).toBe(commitsBefore);
  }, 15_000);

  it("Covers KTD-5: raising the attempt bound and resuming a bound-halted run lets it continue and converge", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(2));
    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "4" },
    });
    const runId = start.stdout.trim();
    await waitForRunStatus(home, runId, "not_converged", 10_000);

    // The sanctioned operator action for `not_converged`: raise the bound in
    // the topology on disk, then resume — `resume` re-reads the topology
    // path fresh rather than the compiled snapshot `start` validated against.
    writeFileSync(topologyPath, JSON.stringify(fixReviewLoopTopology(6)));
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "raise the attempt bound"], { cwd });

    const resume = runCliSync(["resume", runId], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "4" },
    });
    expect(resume.status).toBe(0);

    await waitForRunStatus(home, runId, "completed", 10_000);
  }, 15_000);

  it("Covers R15/KTD-11: a checkpoint claiming more attempts than are actually committed refuses the resume, naming the mismatch", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(2));
    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "99" },
    });
    const runId = start.stdout.trim();
    await waitForRunStatus(home, runId, "not_converged", 10_000);

    // Simulate the #17 crash window: the checkpoint claims one more attempt
    // than the workspace's git history actually holds committed for
    // "review" — exactly what a kill between the checkpoint write and the
    // attempt commit, followed by `preserveInterruptedAttempt`'s hard reset,
    // would leave behind.
    const db = openDb({ baseDir: home });
    const latest = readLatestCheckpoint(db, runId)!;
    writeCheckpoint(db, runId, { ...latest, attempts: { ...latest.attempts, review: (latest.attempts?.review ?? 0) + 1 } });
    db.close();

    const resume = runCliSync(["resume", runId], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "99" },
    });
    expect(resume.status).toBe(0); // `resume` itself only spawns the engine — the refusal is inside it

    await waitForRunStatus(home, runId, "failed", 5000);

    const verifyDb = openDb({ baseDir: home });
    try {
      const row = verifyDb.prepare("select payload from events where run_id = ? order by id desc limit 1").get(runId) as
        | { payload: string }
        | undefined;
      expect(row).toBeDefined();
      const payload = JSON.parse(row!.payload);
      expect(payload.error).toMatch(/attempt-count mismatch/);
      expect(payload.error).toMatch(/'review'/);
    } finally {
      verifyDb.close();
    }
  }, 15_000);

  /** Waits for the review fake CLI's own invocation counter (persisted under `counterDir`) to reach `count` — proof that the bounded node's `withAttemptCommit` hook (and its boundary-event append) already ran for that attempt, since the hook fires strictly before the node's own process is ever spawned. */
  function waitForReviewInvocation(count: number): Promise<void> {
    return waitFor(() => {
      try {
        return Number(readFileSync(join(counterDir, "fake-claude-review-count"), "utf8")) >= count;
      } catch {
        return false;
      }
    }, 5000);
  }

  function boundaryEventsFor(runId: string, nodeId: string): { attemptNumber: number; committed: boolean }[] {
    const db = openDb({ baseDir: home });
    try {
      return listEvents(db, runId)
        .map((event) => event.payload as { type?: string; nodeId?: string; attemptNumber?: number; committed?: boolean })
        .filter((payload) => payload?.type === ATTEMPT_BOUNDARY_EVENT_TYPE && payload.nodeId === nodeId)
        .map((payload) => ({ attemptNumber: payload.attemptNumber!, committed: payload.committed! }));
    } finally {
      db.close();
    }
  }

  it("Covers U5/R6/KTD-16: a bounded node whose attempt commits nothing (no diff to fold) still resumes cleanly, reconciling against the trace rather than git's commit messages", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(5));
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();

    // FAKE_CLAUDE_STATIC_REVIEW_HANG's write half emits byte-identical content
    // every attempt (unlike fake-claude-fix-review.mjs's counter-suffixed
    // one) — so `review`'s SECOND boundary hook, folding writer's second
    // (identical) write, finds nothing to commit. Its review half hangs on
    // its second invocation, standing in for "review is still working" right
    // after that diff-free boundary commit already landed.
    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_STATIC_REVIEW_HANG), FAKE_CLAUDE_HANG_ON_ATTEMPT: "2", FAKE_CLAUDE_PASS_ON_ATTEMPT: "3" },
    });
    const runId = start.stdout.trim();
    expect(runId).not.toBe("");

    await waitForReviewInvocation(2);

    const statusJson = JSON.parse(runCliSync(["status", runId], { cwd, env: baseEnv(FAKE_CLAUDE_STATIC_REVIEW_HANG) }).stdout);
    process.kill(statusJson.ownerPid, "SIGKILL");
    await waitFor(() => !isAlive(statusJson.ownerPid), 3000);

    // The boundary trace already shows both attempts, the second with no commit.
    const boundaryEvents = boundaryEventsFor(runId, "review");
    expect(boundaryEvents).toEqual([
      { attemptNumber: 1, committed: true },
      { attemptNumber: 2, committed: false },
    ]);

    const runBranch = `graph-bro/run-${runId}`;
    const commitsBeforeResume = execFileSync("git", ["rev-list", "--count", `${baseRef}..${runBranch}`], { cwd, encoding: "utf8" }).trim();
    expect(commitsBeforeResume).toBe("1"); // only attempt 1's diff ever landed a commit

    const resume = runCliSync(["resume", runId], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "3" },
    });
    expect(resume.status).toBe(0);

    await waitForRunStatus(home, runId, "completed", 10_000);

    // Resumed cleanly rather than refusing on an attempt-count mismatch —
    // the reconciliation read the boundary event for attempt 2, not git's
    // (empty) commit history for it.
    const db = openDb({ baseDir: home });
    try {
      const errorEvents = listEvents(db, runId).filter((event) => (event.payload as { type?: string })?.type === "run_error");
      expect(errorEvents).toHaveLength(0);
    } finally {
      db.close();
    }
  }, 20_000);

  it("Covers U5/R6: a run resumed twice, whose middle cycle committed nothing, still reconciles against the full boundary-event history", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(5));

    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_STATIC_REVIEW_HANG), FAKE_CLAUDE_HANG_ON_ATTEMPT: "2", FAKE_CLAUDE_PASS_ON_ATTEMPT: "99" },
    });
    const runId = start.stdout.trim();
    await waitForReviewInvocation(2);
    const status1 = JSON.parse(runCliSync(["status", runId], { cwd, env: baseEnv(FAKE_CLAUDE_STATIC_REVIEW_HANG) }).stdout);
    process.kill(status1.ownerPid, "SIGKILL");
    await waitFor(() => !isAlive(status1.ownerPid), 3000);

    // First resume: re-enters at review's attempt 3 (still no diff since
    // writer's content is still static), hangs on invocation 3, killed again.
    const resume1 = runCliSync(["resume", runId], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_STATIC_REVIEW_HANG), FAKE_CLAUDE_HANG_ON_ATTEMPT: "3", FAKE_CLAUDE_PASS_ON_ATTEMPT: "99" },
    });
    expect(resume1.status).toBe(0);
    await waitForReviewInvocation(3);
    const status2 = JSON.parse(runCliSync(["status", runId], { cwd, env: baseEnv(FAKE_CLAUDE_STATIC_REVIEW_HANG) }).stdout);
    process.kill(status2.ownerPid, "SIGKILL");
    await waitFor(() => !isAlive(status2.ownerPid), 3000);

    // Both cycles' boundary events are present, both attempts 2 and 3 diff-free.
    const boundaryEvents = boundaryEventsFor(runId, "review");
    expect(boundaryEvents).toEqual([
      { attemptNumber: 1, committed: true },
      { attemptNumber: 2, committed: false },
      { attemptNumber: 3, committed: false },
    ]);

    // Second resume: switches to a normal-completing binary and converges.
    const resume2 = runCliSync(["resume", runId], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "4" },
    });
    expect(resume2.status).toBe(0);
    await waitForRunStatus(home, runId, "completed", 10_000);

    // Neither resume refused on a mismatch — the reconciliation reads the
    // trace's whole history (the maximum per node across both cycles), not
    // only the latest cycle's boundary events.
    const db = openDb({ baseDir: home });
    try {
      const errorEvents = listEvents(db, runId).filter((event) => (event.payload as { type?: string })?.type === "run_error");
      expect(errorEvents).toHaveLength(0);
    } finally {
      db.close();
    }
  }, 25_000);

  it("resuming a run whose workspace was removed by hand fails with a clear message, rather than re-running from scratch", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(5));
    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_WRITE_THEN_HANG), FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" },
    });
    const runId = start.stdout.trim();
    const workspacePath = join(workspaces, runId);

    await waitFor(() => {
      try {
        return readFileSync(join(workspacePath, "work.txt"), "utf8").length > 0;
      } catch {
        return false;
      }
    }, 5000);

    const statusJson = JSON.parse(runCliSync(["status", runId], { cwd, env: baseEnv(FAKE_CLAUDE_WRITE_THEN_HANG) }).stdout);
    process.kill(statusJson.ownerPid, "SIGKILL");
    await waitFor(() => !isAlive(statusJson.ownerPid), 3000);

    rmSync(workspacePath, { recursive: true, force: true }); // simulate the operator removing it by hand

    const resume = runCliSync(["resume", runId], { cwd, env: baseEnv(FAKE_CLAUDE_FIX_REVIEW) });
    expect(resume.status).toBe(0); // `resume` itself only spawns the engine — the failure is inside it

    await waitForRunStatus(home, runId, "failed", 5000);

    const db = openDb({ baseDir: home });
    try {
      const row = db.prepare("select payload from events where run_id = ? order by id desc limit 1").get(runId) as
        | { payload: string }
        | undefined;
      expect(row).toBeDefined();
      const payload = JSON.parse(row!.payload);
      expect(payload.error).toMatch(/removed by hand/);
    } finally {
      db.close();
    }
  }, 15_000);
});
