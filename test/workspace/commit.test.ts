import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAttempt } from "../../src/workspace/commit.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commitCount(cwd: string, ref = "HEAD"): number {
  return Number(git(cwd, ["rev-list", "--count", ref]).trim());
}

/** A throwaway workspace-shaped repo — mirrors what `createWorkspace` hands the runtime. */
function workspaceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "graph-bro-commit-workspace-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

describe("workspace/commit: commitAttempt (KTD-7, R20/R21, real git)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = workspaceRepo();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("a write node that changes nothing produces no empty attempt commit", () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    const before = commitCount(workspace);

    const result = commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(false);
    expect(result.head).toBe(priorHead);
    expect(commitCount(workspace)).toBe(before);
  });

  it("Covers AE8: a write node that creates three of its own commits still yields exactly one new commit on the branch", () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    const before = commitCount(workspace);

    for (let i = 0; i < 3; i++) {
      writeFileSync(join(workspace, `agent-commit-${i}.txt`), `content ${i}\n`);
      git(workspace, ["add", "-A"]);
      git(workspace, ["commit", "-q", "-m", `agent's own commit ${i}`]);
    }

    const result = commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    expect(commitCount(workspace)).toBe(before + 1); // three folded into one
    expect(readFileSync(join(workspace, "agent-commit-0.txt"), "utf8")).toBe("content 0\n");
    expect(readFileSync(join(workspace, "agent-commit-2.txt"), "utf8")).toBe("content 2\n");
  });

  it("a write node that leaves the tree dirty without committing is folded into exactly one attempt commit", () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    const before = commitCount(workspace);
    writeFileSync(join(workspace, "dirty.txt"), "left uncommitted\n");

    const result = commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    expect(commitCount(workspace)).toBe(before + 1);
    expect(git(workspace, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("a mix of the agent's own commits AND leftover dirty state still folds into exactly one commit", () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    const before = commitCount(workspace);

    writeFileSync(join(workspace, "agent-commit.txt"), "committed by agent\n");
    git(workspace, ["add", "-A"]);
    git(workspace, ["commit", "-q", "-m", "agent's own commit"]);
    writeFileSync(join(workspace, "leftover.txt"), "left dirty\n");

    const result = commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    expect(commitCount(workspace)).toBe(before + 1);
    expect(readFileSync(join(workspace, "agent-commit.txt"), "utf8")).toBe("committed by agent\n");
    expect(readFileSync(join(workspace, "leftover.txt"), "utf8")).toBe("left dirty\n");
  });

  it("Covers R21: a 'failing' attempt (state left as-is) is committed and remains reachable from the branch afterwards", () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "partial-work.txt"), "the node failed mid-write\n");

    const result = commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    // Reachable from the current branch — a failing attempt is not discarded.
    expect(git(workspace, ["branch", "--contains", result.head]).trim()).not.toBe("");
  });

  it("the commit message carries the attempt number", () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "x.txt"), "x\n");

    const result = commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 7, nodeId: "reviewer" });

    const message = git(workspace, ["log", "-1", "--format=%s", result.head]);
    expect(message).toContain("attempt 7");
    expect(message).toContain("reviewer");
  });

  it("two consecutive attempts produce two commits in order on the branch", () => {
    let priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    const before = commitCount(workspace);

    writeFileSync(join(workspace, "attempt-1.txt"), "1\n");
    const first = commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });
    expect(first.committed).toBe(true);
    priorHead = first.head;

    writeFileSync(join(workspace, "attempt-2.txt"), "2\n");
    const second = commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 2, nodeId: "reviewer" });
    expect(second.committed).toBe(true);

    expect(commitCount(workspace)).toBe(before + 2);
    const messages = git(workspace, ["log", "-2", "--format=%s"]).trim().split("\n");
    expect(messages[0]).toContain("attempt 2");
    expect(messages[1]).toContain("attempt 1");
  });

  it("Covers R17: a separate consumer repo's own branches and history are untouched — commitAttempt only ever operates on the workspace path it's given", () => {
    const consumer = mkdtempSync(join(tmpdir(), "graph-bro-commit-consumer-"));
    try {
      git(consumer, ["init", "-q"]);
      git(consumer, ["config", "user.email", "test@example.com"]);
      git(consumer, ["config", "user.name", "test"]);
      git(consumer, ["config", "commit.gpgsign", "false"]);
      writeFileSync(join(consumer, "README.md"), "consumer\n");
      git(consumer, ["add", "-A"]);
      git(consumer, ["commit", "-q", "-m", "init"]);
      const consumerHeadBefore = git(consumer, ["rev-parse", "HEAD"]).trim();

      const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
      writeFileSync(join(workspace, "x.txt"), "x\n");
      commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

      expect(git(consumer, ["rev-parse", "HEAD"]).trim()).toBe(consumerHeadBefore);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("the CLI's scratch directory is not present in any attempt commit", () => {
    // Mirrors createWorkspace's own exclude (U5) — .claude/ is untracked-ignored.
    const excludePath = git(workspace, ["rev-parse", "--git-path", "info/exclude"]).trim();
    writeFileSync(join(workspace, excludePath), "/.claude/\n");
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(join(workspace, ".claude", "settings.local.json"), "{}\n");

    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "x.txt"), "x\n");
    const result = commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    const files = git(workspace, ["show", "--stat", "--format=", result.head]);
    expect(files).not.toContain(".claude");
  });

  it("a consumer-supplied hooks path does not execute during an engine commit", () => {
    mkdirSync(join(workspace, "repo-hooks"), { recursive: true });
    const marker = join(workspace, "hook-ran.txt");
    writeFileSync(join(workspace, "repo-hooks", "pre-commit"), `#!/bin/sh\necho fired > "${marker}"\n`);
    writeFileSync(join(workspace, "repo-hooks", "post-commit"), `#!/bin/sh\necho fired >> "${marker}"\n`);
    execFileSync("chmod", ["+x", join(workspace, "repo-hooks", "pre-commit"), join(workspace, "repo-hooks", "post-commit")]);
    git(workspace, ["config", "core.hooksPath", "repo-hooks"]);

    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "x.txt"), "x\n");
    const result = commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("a detached background writer left behind is reported via a quiescence warning rather than silently absorbed", () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "x.txt"), "x\n");

    // Writes continuously from the moment it's spawned, rather than after a
    // fixed delay: `commitAttempt` is fully synchronous (a handful of
    // execFileSync calls), so there is no reliable fixed delay that lands a
    // single write inside that narrow window. A writer active throughout is
    // certain to still be dirtying the tree by the time commitAttempt's own
    // post-commit status check runs.
    const target = join(workspace, "straggler.txt");
    const straggler = spawn(
      process.execPath,
      ["-e", `let n = 0; setInterval(() => require('fs').writeFileSync(${JSON.stringify(target)}, String(n++)), 2);`],
      { stdio: "ignore" },
    );

    let result: ReturnType<typeof commitAttempt>;
    try {
      result = commitAttempt({ workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });
    } finally {
      straggler.kill("SIGKILL");
    }

    expect(result.committed).toBe(true);
    expect(result.quiescenceWarning).toContain("reviewer");
    expect(result.quiescenceWarning).toContain("not quiescent");
  });
});
