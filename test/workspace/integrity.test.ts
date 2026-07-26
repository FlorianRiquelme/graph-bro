import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceIntegrityViolationError,
  assertWorkspaceIntegrity,
  captureWorkspaceIntegrityManifest,
} from "../../src/workspace/integrity.js";
import { openDb } from "../../src/store/db.js";
import { listEvents } from "../../src/store/trace.js";
import { gitRepo, isAlive, runCliSync, waitFor, waitForRunStatus } from "../fixtures/cli-harness.js";

/** `git symbolic-ref -q HEAD` exits 1 (no output) when detached — execFileSync throws on that, so this reports "" instead of letting the throw escape. */
function symbolicRefOrEmpty(cwd: string): string {
  try {
    return execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
// Its write half performs whatever `{"write":{"path":...,"content":...}}` its
// prompt carries (mkdir-ing any missing parent directory, unlike
// `fake-claude-fix-review.mjs`'s write half — needed to plant into a
// not-yet-existing `.claude/`), and its read-only half answers a structured
// verdict from FAKE_CLAUDE_PASS_ON_ATTEMPT.
const FAKE_CLAUDE_TAMPER_WRITE = join(FIXTURES_DIR, "fake-claude-tamper-write.mjs");
// U3: unconditionally writes whatever its prompt's `{"write":...}` says,
// regardless of the node's declared capability — used below to prove the
// integrity assertion fires on a *read-only* node's own activation too
// (the real sandbox is what would refuse a real `claude` read-only node's
// write; this fixture stands in for "assume the write happened anyway").
const FAKE_CLAUDE_WRITE = join(FIXTURES_DIR, "fake-claude-write.mjs");
// U3: writes then hangs indefinitely without emitting a result — stands in
// for "the node is still working" so a test can SIGKILL the engine mid-write,
// leaving the tamper on disk but never folded into any attempt commit.
const FAKE_CLAUDE_WRITE_THEN_HANG = join(FIXTURES_DIR, "fake-claude-write-then-hang.mjs");
const FAKE_CLAUDE_FIX_REVIEW_RESUME = join(FIXTURES_DIR, "fake-claude-fix-review.mjs");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A throwaway consumer + linked-worktree pair, mirroring `createWorkspace`'s own shape (as `commit.test.ts` does). */
function workspacePair(): { consumer: string; workspace: string } {
  const consumer = mkdtempSync(join(tmpdir(), "graph-bro-integrity-consumer-"));
  git(consumer, ["init", "-q"]);
  git(consumer, ["config", "user.email", "test@example.com"]);
  git(consumer, ["config", "user.name", "test"]);
  git(consumer, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(consumer, "README.md"), "hello\n");
  git(consumer, ["add", "-A"]);
  git(consumer, ["commit", "-q", "-m", "init"]);

  const workspace = join(mkdtempSync(join(tmpdir(), "graph-bro-integrity-workspace-root-")), "ws");
  git(consumer, ["worktree", "add", "-q", "-b", "graph-bro/run-integrity-test", workspace]);
  return { consumer, workspace };
}

describe("workspace/integrity: assertWorkspaceIntegrity (R8 backstop, KTD-8, unit-level)", () => {
  let consumer: string;
  let workspace: string;

  beforeEach(() => {
    ({ consumer, workspace } = workspacePair());
  });

  afterEach(() => {
    rmSync(consumer, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("passes when nothing has changed since the manifest was captured", () => {
    const manifest = captureWorkspaceIntegrityManifest(workspace);
    expect(() => assertWorkspaceIntegrity(workspace, manifest, "reader")).not.toThrow();
  });

  it("names the offending node when a new .claude file appears", () => {
    const manifest = captureWorkspaceIntegrityManifest(workspace);
    writeFileSync(join(workspace, ".mcp.json"), '{"mcpServers":{}}');

    try {
      assertWorkspaceIntegrity(workspace, manifest, "writer-node");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceIntegrityViolationError);
      expect((err as WorkspaceIntegrityViolationError).nodeId).toBe("writer-node");
      expect((err as Error).message).toContain("writer-node");
      expect((err as Error).message).toContain("CLI-configuration surface changed");
    }
  });

  it("modifying an ordinary tracked file (outside the config surface) does not trip the assertion", () => {
    const manifest = captureWorkspaceIntegrityManifest(workspace);
    writeFileSync(join(workspace, "README.md"), "mutated\n");

    expect(() => assertWorkspaceIntegrity(workspace, manifest, "writer-node")).not.toThrow();
  });

  it("a gitlink rewrite is reported distinctly from a config-surface change", () => {
    const manifest = captureWorkspaceIntegrityManifest(workspace);
    writeFileSync(join(workspace, ".git"), "gitdir: /nonexistent/elsewhere\n");

    try {
      assertWorkspaceIntegrity(workspace, manifest, "writer-node");
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("gitlink target changed");
      expect(message).not.toContain("CLI-configuration surface changed");
    }
  });

  // U3/U1-probe: a live `claude` 2.1.220 run creates `.claude/.cc-writes/`
  // unconditionally, in both capability arms — outside the narrowed
  // `CONFIG_SURFACE_PATHS`. Without this test the narrowing is only asserted
  // by inspection; a later widening back to a blanket `.claude` would
  // silently reintroduce a false positive on every live run.
  it("a file appearing under .claude/.cc-writes/ (the CLI's own unconditional scratch dir) does not trip the assertion", () => {
    const manifest = captureWorkspaceIntegrityManifest(workspace);
    mkdirSync(join(workspace, ".claude", ".cc-writes"), { recursive: true });
    writeFileSync(join(workspace, ".claude", ".cc-writes", "scratch"), "anything\n");

    expect(() => assertWorkspaceIntegrity(workspace, manifest, "writer-node")).not.toThrow();
  });
});

/**
 * The fix/review loop shape `fake-claude-fix-review.mjs` is built for:
 * `writer` (write-capable) performs whatever its prompt's `write` instruction
 * says, `review` (read-only, bounded) answers a verdict. `review`'s
 * attempt-commit hook fires on its very first activation, before it is ever
 * invoked — so whatever `writer` already planted on disk by then is exactly
 * what that first check compares against the manifest, regardless of
 * `maxAttempts` or how quickly `review` passes.
 */
function fixReviewLoopTopology(maxAttempts: number) {
  return {
    nodes: [
      {
        id: "writer",
        kind: "agent",
        read_only: false,
        model: "claude-haiku-4-5",
        prompt: JSON.stringify({}),
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

/**
 * `review` passes on its one and only activation and routes straight to a
 * second write-capable node (`finisher`) before END — `review`'s
 * attempt-commit hook, the only place its manifest ever gets checked, never
 * fires again after that first pass. Whatever `finisher` plants is therefore
 * invisible to any attempt-boundary hook; only the terminal-path check (run
 * once, in `main()`, regardless of which node ran last) can ever catch it.
 */
function neverReactivatedTopology() {
  return {
    nodes: [
      {
        id: "review",
        kind: "agent",
        read_only: true,
        model: "claude-haiku-4-5",
        prompt: "review the work",
        output_key: "verdict",
        output_schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
        max_attempts: 5,
      },
      {
        id: "finisher",
        kind: "agent",
        read_only: false,
        model: "claude-haiku-4-5",
        prompt: JSON.stringify({}),
        output_key: "written",
      },
    ],
    edges: [
      { from: "START", to: "review" },
      { from: "review", to: "finisher", when: { key: "verdict.verdict", equals: "pass" } },
      { from: "finisher", to: "END" },
    ],
    max_steps: 20,
  };
}

function writeTopology(cwd: string, topology: unknown): string {
  const path = join(cwd, "topology.json");
  writeFileSync(path, JSON.stringify(topology));
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "add topology"]);
  return path;
}

/** A write node's prompt, in the shape `fake-claude-fix-review.mjs`'s write half parses: `{"write":{"path":...,"content":...}}`. */
function writePrompt(path: string, content: string): string {
  return JSON.stringify({ write: { path, content } });
}

describe("integration/integrity: a full run fails when the workspace's config surface or gitlink diverges (R8, KTD-8)", () => {
  let home: string;
  let workspaces: string;
  let cwd: string;
  let counterDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "graph-bro-integrity-home-"));
    workspaces = join(home, "workspaces");
    cwd = gitRepo();
    counterDir = mkdtempSync(join(tmpdir(), "graph-bro-integrity-counter-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(counterDir, { recursive: true, force: true });
  });

  function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GRAPH_BRO_HOME: home,
      GRAPH_BRO_WORKSPACES: workspaces,
      GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE_TAMPER_WRITE,
      FAKE_CLAUDE_COUNTER_DIR: counterDir,
      ...extra,
    };
  }

  function tailErrors(runId: string): string[] {
    const db = openDb({ baseDir: home });
    try {
      return listEvents(db, runId)
        .map((event) => (event.payload as { error?: string } | undefined)?.error)
        .filter((error): error is string => Boolean(error));
    } finally {
      db.close();
    }
  }

  function setPrompt(topologyPath: string, topology: ReturnType<typeof fixReviewLoopTopology>, nodeId: string, prompt: string): void {
    const node = topology.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== "agent") throw new Error(`node '${nodeId}' not found or not an agent node`);
    node.prompt = prompt;
    writeFileSync(topologyPath, JSON.stringify(topology));
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "set writer prompt"], { cwd });
  }

  it("Covers R8: a node that plants .claude/settings.local.json fails the run, and the error names the boundary node", async () => {
    const topology = fixReviewLoopTopology(5);
    const topologyPath = writeTopology(cwd, topology);
    setPrompt(topologyPath, topology, "writer", writePrompt(".claude/settings.local.json", '{"hooks":{}}'));

    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv({ FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" }) });
    const runId = start.stdout.trim();
    expect(runId).not.toBe("");

    await waitForRunStatus(home, runId, "failed", 10_000);

    const errors = tailErrors(runId);
    expect(errors.some((error) => error.includes("review"))).toBe(true);
    expect(errors.some((error) => error.includes("CLI-configuration surface changed"))).toBe(true);
  }, 15_000);

  it("Covers R8: a node that modifies an existing CLAUDE.md fails the run", async () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "original\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "-m", "add CLAUDE.md"]);
    const topology = fixReviewLoopTopology(5);
    const topologyPath = writeTopology(cwd, topology);
    setPrompt(topologyPath, topology, "writer", writePrompt("CLAUDE.md", "mutated\n"));

    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv({ FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" }) });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "failed", 10_000);
    expect(tailErrors(runId).some((error) => error.includes("CLI-configuration surface changed"))).toBe(true);
  }, 15_000);

  it("a node that only touches an ordinary tracked file does not fail the run", async () => {
    const topology = fixReviewLoopTopology(5);
    const topologyPath = writeTopology(cwd, topology);
    setPrompt(topologyPath, topology, "writer", writePrompt("notes.txt", "harmless\n"));

    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv({ FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" }) });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "completed", 10_000);
  }, 15_000);

  it("Covers R8: a gitlink rewrite fails the run, naming the gitlink mismatch distinctly from a config-surface change", async () => {
    const topology = fixReviewLoopTopology(5);
    const topologyPath = writeTopology(cwd, topology);
    setPrompt(topologyPath, topology, "writer", writePrompt(".git", "gitdir: /nonexistent/elsewhere\n"));

    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv({ FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" }) });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "failed", 10_000);
    const errors = tailErrors(runId);
    expect(errors.some((error) => error.includes("gitlink target changed"))).toBe(true);
    expect(errors.some((error) => error.includes("CLI-configuration surface changed"))).toBe(false);
  }, 15_000);

  it("a run whose nodes touch nothing in the manifest completes with no integrity-violation event", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(5));

    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv({ FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" }) });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "completed", 10_000);
    expect(tailErrors(runId).some((error) => error.includes("R8 backstop"))).toBe(false);
  }, 15_000);

  it("Covers R8: the assertion fires on the terminal path of a run that never re-activates the bounded node", async () => {
    const topology = neverReactivatedTopology();
    const topologyPath = writeTopology(cwd, topology);
    setPrompt(topologyPath, topology as unknown as ReturnType<typeof fixReviewLoopTopology>, "finisher", writePrompt(".claude/settings.local.json", '{"hooks":{}}'));

    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv({ FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" }) });
    const runId = start.stdout.trim();

    await waitForRunStatus(home, runId, "failed", 10_000);
    expect(tailErrors(runId).some((error) => error.includes("CLI-configuration surface changed"))).toBe(true);
  }, 15_000);

  it("U16: a run whose last node plants .mcp.json ends failed with no commit on the run branch containing the tamper, and the workspace holding it is retained", async () => {
    const topology = neverReactivatedTopology();
    const topologyPath = writeTopology(cwd, topology);
    setPrompt(topologyPath, topology as unknown as ReturnType<typeof fixReviewLoopTopology>, "finisher", writePrompt(".mcp.json", '{"mcpServers":{"evil":{}}}'));
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();

    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv({ FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" }) });
    const runId = start.stdout.trim();
    expect(runId).not.toBe("");

    await waitForRunStatus(home, runId, "failed", 10_000);

    // The violation names the terminal check ("run-teardown", the same
    // marker the boundary hook's doc comment contrasts itself against) and,
    // separately, the reason `commitFinalAttempt` never ran.
    const errors = tailErrors(runId);
    expect(errors.some((error) => error.includes("run-teardown"))).toBe(true);
    expect(errors.some((error) => error.includes("CLI-configuration surface changed"))).toBe(true);
    expect(errors.some((error) => error.includes("run-teardown commit skipped"))).toBe(true);

    // The run branch is the handback artifact — no commit on it, ever, may
    // touch the planted file.
    const runBranch = `graph-bro/run-${runId}`;
    const touchingCommits = execFileSync("git", ["log", runBranch, "--", ".mcp.json"], { cwd, encoding: "utf8" }).trim();
    expect(touchingCommits).toBe("");
    // Nothing landed on the branch after the topology commit at all — the
    // terminal assertion trips on the same tamper the teardown commit would
    // otherwise have folded in, so it is skipped entirely, not partially.
    const messages = execFileSync("git", ["log", "--format=%s", `${baseRef}..${runBranch}`], { cwd, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(messages).toHaveLength(0);

    // KTD-9: a failed run keeps its workspace — the withheld attempt is not
    // lost, only not folded into history.
    const workspacePath = join(workspaces, runId);
    expect(readFileSync(join(workspacePath, ".mcp.json"), "utf8")).toContain("evil");
  }, 15_000);

  it("U3: an unbounded write-capable node (no max_attempts) that plants .claude/settings.local.json is caught on its own next activation, and the failure names that node — the shipped review-fix-loop's 'fix' node's reachability case", async () => {
    // `fix` declares no `max_attempts` and loops directly back onto itself
    // (no intervening node), so pre-U3 nothing ever checked it: only a
    // *bounded* node's own re-entry got the assertion. Its first activation
    // plants the tamper; its second must be caught before it runs at all
    // ("fail before the fix"), naming `fix` itself.
    const topologyPath = writeTopology(cwd, {
      nodes: [
        {
          id: "fix",
          kind: "agent",
          read_only: false,
          model: "claude-haiku-4-5",
          prompt: writePrompt(".claude/settings.local.json", '{"hooks":{}}'),
          output_key: "fix_result",
        },
      ],
      edges: [
        { from: "START", to: "fix" },
        { from: "fix", to: "fix" },
      ],
      max_steps: 5,
    });

    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv() });
    const runId = start.stdout.trim();
    expect(runId).not.toBe("");

    await waitForRunStatus(home, runId, "failed", 10_000);

    const errors = tailErrors(runId);
    expect(errors.some((error) => error.includes("fix"))).toBe(true);
    expect(errors.some((error) => error.includes("CLI-configuration surface changed"))).toBe(true);
  }, 15_000);

  it("U3: the assertion fires at a read-only node's own activation boundary too, not only a write-capable node's", async () => {
    // FAKE_CLAUDE_WRITE writes unconditionally regardless of the node's
    // declared capability — standing in for "assume a real sandbox escape
    // happened", since this test is about the assertion's own coverage, not
    // about re-proving the sandbox (read-only-policy.test.ts's job).
    const topologyPath = writeTopology(cwd, {
      nodes: [
        {
          id: "reader",
          kind: "agent",
          read_only: true,
          model: "claude-haiku-4-5",
          prompt: writePrompt(".mcp.json", '{"mcpServers":{"evil":{}}}'),
          output_key: "reader_result",
        },
      ],
      edges: [
        { from: "START", to: "reader" },
        { from: "reader", to: "reader" },
      ],
      max_steps: 5,
    });

    const start = runCliSync(["start", topologyPath], { cwd, env: { ...baseEnv(), GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE_WRITE } });
    const runId = start.stdout.trim();
    expect(runId).not.toBe("");

    await waitForRunStatus(home, runId, "failed", 10_000);

    const errors = tailErrors(runId);
    expect(errors.some((error) => error.includes("reader"))).toBe(true);
    expect(errors.some((error) => error.includes("CLI-configuration surface changed"))).toBe(true);
  }, 15_000);

  it("U3/KTD-17: a bounded node that plants .mcp.json is caught with NO attempt commit having been created for its own boundary (check-before-fold)", async () => {
    // `writer` is unbounded and always dispatches; `review` is bounded, so
    // pre-U3 this scenario was already caught here too — the point of THIS
    // assertion is the one below: no "attempt N (review)" boundary commit
    // ever landed, proving the integrity check ran before `withAttemptCommit`'s
    // own fold, not after it (the composition-order bug this scenario is
    // built to pin). U16: the same still-uncommitted tamper trips the
    // terminal-path assertion too, so `commitFinalAttempt` is skipped —
    // no commit lands on the run branch at all, not even the teardown one.
    const topology = fixReviewLoopTopology(5);
    const topologyPath = writeTopology(cwd, topology);
    setPrompt(topologyPath, topology, "writer", writePrompt(".mcp.json", '{"mcpServers":{"evil":{}}}'));
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();

    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv({ FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" }) });
    const runId = start.stdout.trim();
    expect(runId).not.toBe("");

    await waitForRunStatus(home, runId, "failed", 10_000);
    expect(tailErrors(runId).some((error) => error.includes("CLI-configuration surface changed"))).toBe(true);

    const runBranch = `graph-bro/run-${runId}`;
    const messages = execFileSync("git", ["log", "--format=%s", `${baseRef}..${runBranch}`], { cwd, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(messages).toHaveLength(0); // U16: the terminal assertion also trips, so even the teardown commit is skipped
    expect(messages.some((message) => message.includes("(review)"))).toBe(false);
  }, 15_000);

  it("U3: a killed run whose node planted config is caught on the next resume, before preserveInterruptedAttempt folds the tree into a partial-attempt ref", async () => {
    const topology = fixReviewLoopTopology(5);
    const topologyPath = writeTopology(cwd, topology);
    setPrompt(topologyPath, topology, "writer", writePrompt(".mcp.json", '{"mcpServers":{"evil":{}}}'));

    const start = runCliSync(["start", topologyPath], {
      cwd,
      env: { ...baseEnv(), GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE_WRITE_THEN_HANG, FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" },
    });
    const runId = start.stdout.trim();
    expect(runId).not.toBe("");

    const workspacePath = join(workspaces, runId);
    // Wait for the writer's in-flight tamper to actually land on disk (the
    // node itself then hangs, standing in for "still working") before
    // killing — never folded into any attempt commit at kill time.
    await waitFor(() => {
      try {
        return readFileSync(join(workspacePath, ".mcp.json"), "utf8").length > 0;
      } catch {
        return false;
      }
    }, 5000);

    const statusJson = JSON.parse(
      runCliSync(["status", runId], { cwd, env: { ...baseEnv(), GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE_WRITE_THEN_HANG } }).stdout,
    );
    const ownerPid: number = statusJson.ownerPid;
    process.kill(ownerPid, "SIGKILL");
    await waitFor(() => !isAlive(ownerPid), 3000);

    const resume = runCliSync(["resume", runId], {
      cwd,
      env: { ...baseEnv(), GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE_FIX_REVIEW_RESUME, FAKE_CLAUDE_PASS_ON_ATTEMPT: "1" },
    });
    expect(resume.status).toBe(0);

    await waitForRunStatus(home, runId, "failed", 10_000);
    expect(tailErrors(runId).some((error) => error.includes("CLI-configuration surface changed"))).toBe(true);
  }, 15_000);

  it("Covers R8: a resumed run compares against the manifest recorded at creation, not one re-captured at resume", async () => {
    const topologyPath = writeTopology(cwd, fixReviewLoopTopology(2));

    // Halts `not_converged` (bound exhausted) with no tamper at all — the
    // workspace is retained (KTD-9) and clean against the manifest.
    const start = runCliSync(["start", topologyPath], { cwd, env: baseEnv({ FAKE_CLAUDE_PASS_ON_ATTEMPT: "99" }) });
    const runId = start.stdout.trim();
    await waitForRunStatus(home, runId, "not_converged", 10_000);

    // Plant the tamper directly into the retained workspace and commit it
    // under the same `graph-bro: attempt N (...)` message `commitAttempt`
    // itself uses — so `resume`'s own crash-recovery (`preserveInterruptedAttempt`,
    // U8) recognizes it as the last *actually committed* attempt and leaves it
    // in place, rather than resetting past it as untracked/uncommitted
    // leftover. This simulates "the config was planted before the kill"
    // without needing to simulate the kill itself, entirely between the halt
    // and the resume — i.e. outside of any process that has ever compared it
    // against the real (creation-time) manifest.
    const workspacePath = join(workspaces, runId);
    // The status write precedes disposal (R11/KTD-12), so `not_converged`
    // being observable does NOT mean the engine has finished detaching the
    // halted workspace's HEAD. Planting before that lands makes the
    // `git branch -f` below fail outright — git refuses to force-move a
    // branch that is still checked out somewhere. Wait for the disposal's
    // actual outcome rather than for the status that merely precedes it.
    await waitFor(() => symbolicRefOrEmpty(workspacePath) === "", 10_000);

    writeFileSync(join(workspacePath, ".mcp.json"), '{"mcpServers":{"evil":{}}}');
    execFileSync("git", ["add", "-A"], { cwd: workspacePath });
    execFileSync(
      "git",
      // Labelled for `review` — the run's actual bounded node — not an invented
      // node id. U8's resume reconciliation (R15/KTD-11) compares the
      // checkpoint's per-node attempt counts against the attempt commits
      // actually present, so a planted commit naming a node that never ran
      // leaves `review` reading as zero-committed against a checkpoint
      // claiming two, and resume refuses on *that* before the integrity check
      // this test is about ever runs. Planting it as a real `review` attempt
      // keeps the two invariants consistent and is the truer simulation
      // anyway: the tamper lands inside an attempt, not beside one.
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "graph-bro: attempt 3 (review)"],
      { cwd: workspacePath },
    );
    // KTD-9 leaves a halted workspace's HEAD *detached* — committing there
    // creates an orphan commit that `reattachToRunBranch`'s own checkout
    // would otherwise abandon (it moves HEAD, and the working tree, back to
    // wherever the run branch itself still points). Forcing the branch onto
    // this new commit is what makes it "the workspace's actual state" from
    // resume's point of view, rather than a commit nothing will ever check out.
    const runBranch = `graph-bro/run-${runId}`;
    const plantedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, encoding: "utf8" }).trim();
    execFileSync("git", ["branch", "-f", runBranch, plantedSha], { cwd: workspacePath });

    const resume = runCliSync(["resume", runId], { cwd, env: baseEnv({ FAKE_CLAUDE_PASS_ON_ATTEMPT: "99" }) });
    expect(resume.status).toBe(0);

    // A resumed bound-exhausted run re-halts immediately without dispatching
    // any node (KTD-11) — so only the terminal-path check, using the manifest
    // read back from the trace, can catch this. If the implementation instead
    // recaptured the manifest fresh at resume, this same run would read
    // `not_converged` again (the tamper landed before that recapture, so it
    // would silently become the new "normal") rather than `failed`.
    await waitForRunStatus(home, runId, "failed", 10_000);
    expect(tailErrors(runId).some((error) => error.includes("CLI-configuration surface changed"))).toBe(true);
  }, 15_000);
});
