import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/store/db.js";
import { writeCheckpoint } from "../../src/store/checkpoints.js";
import { createRun, getRun } from "../../src/store/pending-writes.js";
import { listEvents } from "../../src/store/trace.js";
import { workspacePathForRun } from "../../src/workspace/lifecycle.js";
import { FAKE_CLAUDE, gitRepo, isAlive, runCliSync, seedWorkspaceForRun, waitFor, waitForRunStatus } from "../fixtures/cli-harness.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const FAKE_CLAUDE_WRITE = join(FIXTURES_DIR, "fake-claude-write.mjs");
const FAKE_CLAUDE_WRITE_ERROR = join(FIXTURES_DIR, "fake-claude-write-error.mjs");
const FAKE_CLAUDE_FIX_REVIEW = join(FIXTURES_DIR, "fake-claude-fix-review.mjs");

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

  it("Covers R10: a full run leaves the consumer's own '.git/info/exclude' byte-identical, whether it pre-existed or not", async () => {
    const topologyPath = writeTopology(cwd, singleNodeTopology());
    const consumerExcludePath = join(cwd, ".git", "info", "exclude");
    const bytesBefore = existsSync(consumerExcludePath) ? readFileSync(consumerExcludePath) : null;
    const env = baseEnv("success");

    const start = runCliSync(["start", topologyPath], { cwd, env });
    expect(start.status).toBe(0);
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "completed", 10_000);

    if (bytesBefore === null) {
      expect(existsSync(consumerExcludePath)).toBe(false); // must not have been created by the run
    } else {
      expect(readFileSync(consumerExcludePath)).toEqual(bytesBefore); // byte-identical
    }
  }, 15_000);

  it("Covers R10: a full run leaves the consumer's own '.git/info/exclude' byte-identical when it did not exist beforehand", async () => {
    const topologyPath = writeTopology(cwd, singleNodeTopology());
    const consumerExcludePath = join(cwd, ".git", "info", "exclude");
    rmSync(consumerExcludePath, { force: true }); // simulate the file never having existed
    const env = baseEnv("success");

    const start = runCliSync(["start", topologyPath], { cwd, env });
    expect(start.status).toBe(0);
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "completed", 10_000);

    expect(existsSync(consumerExcludePath)).toBe(false); // must not have been created by the run
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

describe("integration/attempt-commits: the runtime's before-invocation hook and teardown commit (U7, KTD-7)", () => {
  let home: string;
  let workspaces: string;
  let cwd: string;
  let counterDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "graph-bro-attempt-commit-home-"));
    workspaces = join(home, "workspaces");
    cwd = gitRepo();
    // Outside the workspace: fake-claude-fix-review.mjs's review counter
    // must live somewhere a read-only node touching cwd wouldn't reach.
    counterDir = mkdtempSync(join(tmpdir(), "graph-bro-attempt-commit-counter-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(counterDir, { recursive: true, force: true });
  });

  // A write node's stripped environment (KTD-4) does not preserve
  // FAKE_CLAUDE_MODE, so these scenarios use their own dedicated fixture
  // binaries (behavior selected by capability, from argv) rather than the
  // shared fake-claude.mjs's env-driven mode switch.
  function baseEnv(binary: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GRAPH_BRO_HOME: home,
      GRAPH_BRO_WORKSPACES: workspaces,
      GRAPH_BRO_CLAUDE_BINARY: binary,
      FAKE_CLAUDE_COUNTER_DIR: counterDir,
    };
  }

  /** A single write node, no bounded node at all — the teardown commit is the only commit mechanism. */
  function singleWriteTopology() {
    return {
      nodes: [
        {
          id: "writer",
          kind: "agent",
          read_only: false,
          model: "claude-haiku-4-5",
          prompt: JSON.stringify({ write: { path: "out.txt", content: "v1" } }),
          output_key: "out",
        },
      ],
      edges: [
        { from: "START", to: "writer" },
        { from: "writer", to: "END" },
      ],
      max_steps: 10,
    };
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

  // Only commits made *after* the topology's own commit — a bare `git log
  // <runBranch>` would also include the consumer's pre-existing history.
  function runBranchLog(runBranch: string, baseRef: string): string[] {
    return execFileSync("git", ["log", "--format=%s", `${baseRef}..${runBranch}`], { cwd, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  }

  it("Covers R21: a run with no bounded node still gets exactly one attempt commit, via the teardown commit alone", async () => {
    const topologyPath = writeTopology(cwd, singleWriteTopology());
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv(FAKE_CLAUDE_WRITE) });
    const runId = start.stdout.trim();
    expect(runId).not.toBe("");

    await waitForRunStatus(home, runId, "completed", 10_000);

    const runBranch = `graph-bro/run-${runId}`;
    const messages = runBranchLog(runBranch, baseRef);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("attempt 1");

    const shownFile = execFileSync("git", ["show", `${runBranch}:out.txt`], { cwd, encoding: "utf8" });
    expect(shownFile).toBe("v1");
  }, 15_000);

  it("Covers AE8/R21: a review that converges on its very first pass still commits that attempt, via teardown (the boundary hook's only firing does the same no-op-safe commit)", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(5));
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" },
    });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "completed", 10_000);

    const runBranch = `graph-bro/run-${runId}`;
    const messages = runBranchLog(runBranch, baseRef);
    expect(messages).toHaveLength(1); // one attempt, converged immediately
    expect(execFileSync("git", ["show", `${runBranch}:work.txt`], { cwd, encoding: "utf8" })).toBe("attempt-1");
  }, 15_000);

  it("Covers AE8: two consecutive attempts (a review that fails once, then passes) produce exactly two commits in order", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(5));
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "2" },
    });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "completed", 10_000);

    const runBranch = `graph-bro/run-${runId}`;
    const messages = runBranchLog(runBranch, baseRef);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("attempt 2"); // most recent first
    expect(messages[1]).toContain("attempt 1");
  }, 15_000);

  it("Covers R21: a review that never converges (not_converged) still has every attempt committed and reachable", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(2));
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE_FIX_REVIEW), FAKE_CLAUDE_PASS_ON_ATTEMPT: "99" },
    });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "not_converged", 10_000);

    const runBranch = `graph-bro/run-${runId}`;
    const messages = runBranchLog(runBranch, baseRef);
    // maxAttempts(2) commits from the hook (review's activations 1 and 2),
    // plus one teardown commit: writer is unbounded and always dispatches,
    // so it writes a third time before the bound check refuses review's
    // *third* activation (KTD-5) — that trailing write never gets reviewed,
    // but R21 still requires it committed and reachable, which the teardown
    // commit (not the hook) is what catches.
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain("run-teardown");
    expect(messages[1]).toContain("attempt 2");
    expect(messages[2]).toContain("attempt 1");
  }, 15_000);

  it("Covers AE10/R18: nothing is pushed and no remote-tracking ref moves for a completed write run", async () => {
    const remote = gitRepo("graph-bro-attempt-commit-remote-");
    try {
      execFileSync("git", ["remote", "add", "origin", remote], { cwd });
      const remoteHeadBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: remote, encoding: "utf8" }).trim();

      const topologyPath = writeTopology(cwd, singleWriteTopology());
      const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv(FAKE_CLAUDE_WRITE) });
      const runId = start.stdout.trim();
      await waitForRunStatus(home, runId, "completed", 10_000);

      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: remote, encoding: "utf8" }).trim()).toBe(remoteHeadBefore);
      expect(execFileSync("git", ["for-each-ref", "refs/remotes"], { cwd, encoding: "utf8" }).trim()).toBe("");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("integration/terminal-status: the terminal write is decided by the loop, never rewritten by teardown (U7/KTD-12)", () => {
  let home: string;
  let workspaces: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "graph-bro-terminal-home-"));
    workspaces = join(home, "workspaces");
    cwd = gitRepo();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function baseEnv(binary: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GRAPH_BRO_HOME: home,
      GRAPH_BRO_WORKSPACES: workspaces,
      GRAPH_BRO_CLAUDE_BINARY: binary,
    };
  }

  function readOnlyPingTopology() {
    return {
      nodes: [{ id: "reader", kind: "agent", read_only: true, model: "claude-haiku-4-5", prompt: "ping", output_key: "greeting" }],
      edges: [
        { from: "START", to: "reader" },
        { from: "reader", to: "END" },
      ],
      max_steps: 10,
    };
  }

  /** A single write node, no bounded node — the teardown commit is the only commit mechanism (mirrors U7's other single-write fixtures above). */
  function singleWriteTopology(overrides: Record<string, unknown> = {}) {
    return {
      nodes: [
        {
          id: "writer",
          kind: "agent",
          read_only: false,
          model: "claude-haiku-4-5",
          prompt: JSON.stringify({ write: { path: "out.txt", content: "v1" } }),
          output_key: "out",
        },
      ],
      edges: [
        { from: "START", to: "writer" },
        { from: "writer", to: "END" },
      ],
      max_steps: 10,
      ...overrides,
    };
  }

  it("Covers R11: a converged run whose workspace disposal throws still records completed, with a workspace_finalize_error trace event", async () => {
    const topologyPath = writeTopology(cwd, readOnlyPingTopology());
    // "slow" (silent for FAKE_CLAUDE_SILENT_MS, then converges) rather than
    // the default "success" mode's ~30ms round trip — read-only env vars
    // survive KTD-4's write-node stripping untouched, so this widens the
    // window between workspace creation and convergence to a comfortable
    // margin, rather than racing a lock command against a fast node under
    // whatever load the rest of the suite happens to be under (R5's spirit).
    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(FAKE_CLAUDE), FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SILENT_MS: "500" },
    });
    const runId = start.stdout.trim();
    expect(runId).not.toBe("");

    // Workspace creation is the first thing `main()` does, synchronously,
    // before any node ever dispatches — so this settles well before the
    // read-only node's own scripted delay does.
    const workspacePath = workspacePathForRun(runId, workspaces);
    await waitFor(() => existsSync(workspacePath), 5000);
    // A locked worktree refuses `git worktree remove --force` (single
    // --force only overrides a dirty tree, not a lock) — a real git failure
    // standing in for "disposal throws", with no mock of git itself.
    execFileSync("git", ["worktree", "lock", workspacePath], { cwd });

    await waitForRunStatus(home, runId, "completed", 10_000);

    // R11 writes the status *before* disposing of the workspace (KTD-12) —
    // deliberately, so a slow/failing disposal never holds up the status an
    // operator or a resuming process reads. That means disposal itself is
    // only eventually observable here, not atomic with the status write.
    let financeError: ReturnType<typeof listEvents>[number] | undefined;
    await waitFor(() => {
      const db = openDb({ baseDir: home });
      try {
        financeError = listEvents(db, runId).find((e) => (e.payload as { type?: string } | undefined)?.type === "workspace_finalize_error");
        return financeError !== undefined;
      } finally {
        db.close();
      }
    }, 5000);
    expect(financeError).toBeDefined();
    expect(String((financeError?.payload as { error?: string } | undefined)?.error)).toMatch(/lock/i);

    execFileSync("git", ["worktree", "unlock", workspacePath], { cwd }); // let afterEach's rmSync succeed
  }, 15_000);

  it("Covers R11: a run whose teardown commit throws (a real git failure) still records failed, with the git error in its trace, and mints no second teardown commit", async () => {
    const topologyPath = writeTopology(cwd, singleWriteTopology());

    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv(FAKE_CLAUDE_WRITE_ERROR) });
    const runId = start.stdout.trim();
    expect(runId).not.toBe("");

    // U3/KTD-6 pins `commit.gpgsign=false` on every engine git call, which is
    // exactly the class of failure this test used to force (a real signing
    // failure) — that gap is now closed, so it can no longer stand in for "a
    // real git failure" here. A stale `index.lock` in the workspace's real
    // admin dir is a failure U3's helper does *not* neutralize (nothing
    // about a lock file is repo-supplied execution or signing config), and
    // it depends on no operator identity/global config the way an unset
    // user.name would. `singleWriteTopology` has no bounded node, so the
    // teardown commit is the only commit this run ever attempts — planting
    // the lock right after workspace creation guarantees it's still there
    // when that one commit runs.
    const workspacePath = workspacePathForRun(runId, workspaces);
    await waitFor(() => existsSync(workspacePath), 5000);
    const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
    const gitCommonDirAbs = gitCommonDir.startsWith("/") ? gitCommonDir : join(cwd, gitCommonDir);
    const adminDir = join(gitCommonDirAbs, "worktrees", runId);
    writeFileSync(join(adminDir, "index.lock"), "");

    await waitForRunStatus(home, runId, "failed", 10_000);

    const db = openDb({ baseDir: home });
    const events = listEvents(db, runId);
    db.close();
    const commitErrors = events.filter(
      (e) =>
        (e.payload as { type?: string } | undefined)?.type === "run_error" &&
        /index\.lock/i.test(String((e.payload as { error?: string } | undefined)?.error)),
    );
    // Exactly one — the old bug's catch path minted a *second* teardown
    // commit attempt (and a second trace event) on top of the first.
    expect(commitErrors).toHaveLength(1);

    // A failed run's workspace is retained (KTD-9).
    expect(existsSync(workspacePath)).toBe(true);

    rmSync(join(adminDir, "index.lock"), { force: true }); // let afterEach's rmSync succeed

    // Deliberately NOT asserting the detach here. The lock that breaks the
    // teardown commit is still in place when disposal runs, so `checkout
    // --detach` fails too — correctly, and by design: U7 isolates disposal so
    // it can only trace `workspace_finalize_error`. Whether this test's
    // cleanup above wins the race against the engine's disposal decides which
    // way it lands, which is exactly the spawned-process race R5 forbids in
    // the gate (it passed locally and failed every CI run). Detach-on-halt is
    // covered without fault injection in `workspace/lifecycle.test.ts`, which
    // proves it the stronger way — by checking the branch out elsewhere.
  }, 15_000);

  it("Covers R12: a run failing the prompt-token gate on resume (after workspace reuse) leaves no worktree on disk or in git's admin data, and its branch is checkable out elsewhere", async () => {
    // Hand-seeded rather than started + killed (test/cli/cli.test.ts's
    // "resume re-checks prompt tokens" does the same): a token whose root no
    // node writes and no input supplies trips resume's own gate on the very
    // first resume, deterministically — no race against a real node's timing.
    const runId = "resume-token-gate-disposal-run";
    const topologyPath = writeTopology(cwd, {
      nodes: [{ id: "reader", kind: "agent", read_only: true, model: "claude-haiku-4-5", prompt: "say {{ missing_root }}", output_key: "out" }],
      edges: [
        { from: "START", to: "reader" },
        { from: "reader", to: "END" },
      ],
      max_steps: 10,
    });

    const workspace = seedWorkspaceForRun(cwd, runId, workspaces);
    const db = openDb({ baseDir: home });
    createRun(db, runId, 999_999, topologyPath, workspace); // a dead owner pid, so resume self-heals
    writeCheckpoint(db, runId, { state: {}, frontier: [{ nodeId: "reader", instanceId: "reader" }], barrier: {}, step: 0 });
    db.close();

    const resume = runCliSync(["resume", runId], { cwd, env: baseEnv(FAKE_CLAUDE) });
    expect(resume.status).toBe(0); // `resume` only spawns the engine — the failure is inside it

    await waitForRunStatus(home, runId, "failed", 10_000);

    // R11 writes the status before disposing of the workspace (KTD-12), so
    // disposal is only eventually observable here, not atomic with the
    // status write `waitForRunStatus` just resolved on.
    await waitFor(() => !existsSync(workspace.workspacePath), 5000);
    expect(execFileSync("git", ["worktree", "list"], { cwd, encoding: "utf8" })).not.toContain(workspace.workspacePath);

    // The branch is reachable and checkable out elsewhere — not pinned by a leftover worktree.
    const elsewhere = mkdtempSync(join(tmpdir(), "graph-bro-terminal-elsewhere-"));
    try {
      execFileSync("git", ["worktree", "add", elsewhere, workspace.runBranch], { cwd });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 15_000);
});
