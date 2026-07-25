import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspace,
  finalizeWorkspace,
  resolveBaseRef,
  runBranchForRun,
  workspacePathForRun,
} from "../../src/workspace/lifecycle.js";
import { resolveWorkspaceGitTarget, runWorkspaceGit } from "../../src/workspace/commit.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A throwaway consumer repo with one committed file, mirroring test/fixtures/cli-harness.ts's gitRepo(). */
function consumerRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "graph-bro-lifecycle-consumer-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

describe("workspace/lifecycle: resolveBaseRef (R14)", () => {
  let consumer: string;

  beforeEach(() => {
    consumer = consumerRepo();
  });

  afterEach(() => {
    rmSync(consumer, { recursive: true, force: true });
  });

  it("resolves the default (undeclared) ref to the current branch's tip", () => {
    const expected = git(consumer, ["rev-parse", "HEAD"]).trim();
    expect(resolveBaseRef(consumer)).toBe(expected);
  });

  it("resolves an explicitly declared ref, even on a different branch than the checkout's current one", () => {
    git(consumer, ["branch", "feature"]);
    writeFileSync(join(consumer, "on-main.txt"), "x\n");
    git(consumer, ["add", "-A"]);
    git(consumer, ["commit", "-q", "-m", "second commit on main"]);
    // consumer's checkout is now on main, one commit ahead of "feature"
    const featureSha = git(consumer, ["rev-parse", "feature"]).trim();

    expect(resolveBaseRef(consumer, "feature")).toBe(featureSha);
    expect(resolveBaseRef(consumer, "feature")).not.toBe(git(consumer, ["rev-parse", "HEAD"]).trim());
  });

  it("throws before a run id is minted when the declared ref does not exist", () => {
    expect(() => resolveBaseRef(consumer, "no-such-ref")).toThrow(/no-such-ref/);
  });

  it("throws with a clear message for a non-git consumer directory", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "graph-bro-not-a-repo-"));
    try {
      expect(() => resolveBaseRef(notARepo)).toThrow();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe("workspace/lifecycle: workspacePathForRun / runBranchForRun", () => {
  it("derives the workspace path from the run id, not from the topology or consumer repo", () => {
    const root = "/some/root";
    expect(workspacePathForRun("run-a", root)).toBe(join(root, "run-a"));
    expect(workspacePathForRun("run-b", root)).toBe(join(root, "run-b"));
  });

  it("derives a run branch namespaced by run id", () => {
    expect(runBranchForRun("abc-123")).toBe("graph-bro/run-abc-123");
  });
});

describe("workspace/lifecycle: createWorkspace / finalizeWorkspace (R13/R15/R16/R19/KTD-1/KTD-9, real git)", () => {
  let consumer: string;
  let workspacesRoot: string;

  beforeEach(() => {
    consumer = consumerRepo();
    workspacesRoot = mkdtempSync(join(tmpdir(), "graph-bro-lifecycle-workspaces-"));
  });

  afterEach(() => {
    rmSync(consumer, { recursive: true, force: true });
    rmSync(workspacesRoot, { recursive: true, force: true });
  });

  it("Covers AE7: the workspace contains exactly the base ref's committed content, and the consumer's tree/index are byte-identical afterwards", () => {
    // A dirty consumer on purpose (AE7's premise): an uncommitted change sits
    // in the working tree, which the workspace must NOT see.
    writeFileSync(join(consumer, "README.md"), "dirty uncommitted edit\n");
    const porcelainBefore = git(consumer, ["status", "--porcelain"]);
    const bytesBefore = readFileSync(join(consumer, "README.md"));

    const runId = "run-ae7";
    const baseRefSha = resolveBaseRef(consumer);
    const workspacePath = workspacePathForRun(runId, workspacesRoot);
    const runBranch = runBranchForRun(runId);
    createWorkspace({ consumerRepoPath: consumer, baseRefSha, workspacePath, runBranch });

    // The workspace sees the committed content only ("hello\n"), never the dirty edit.
    expect(readFileSync(join(workspacePath, "README.md"), "utf8")).toBe("hello\n");

    expect(git(consumer, ["status", "--porcelain"])).toBe(porcelainBefore);
    expect(readFileSync(join(consumer, "README.md"))).toEqual(bytesBefore);
  });

  it("Covers R15: two concurrent runs against one consumer repo each get their own workspace and branch, and neither sees the other's writes", () => {
    const baseRefSha = resolveBaseRef(consumer);
    const wsA = workspacePathForRun("run-a", workspacesRoot);
    const wsB = workspacePathForRun("run-b", workspacesRoot);
    createWorkspace({ consumerRepoPath: consumer, baseRefSha, workspacePath: wsA, runBranch: runBranchForRun("run-a") });
    createWorkspace({ consumerRepoPath: consumer, baseRefSha, workspacePath: wsB, runBranch: runBranchForRun("run-b") });

    writeFileSync(join(wsA, "only-in-a.txt"), "a\n");
    git(wsA, ["add", "-A"]);
    git(wsA, ["commit", "-q", "-m", "a's own commit"]);

    expect(existsSync(join(wsB, "only-in-a.txt"))).toBe(false);
    expect(git(wsB, ["log", "--oneline"]).trim().split("\n")).toHaveLength(1); // unaffected by A's commit
  });

  it("names the workspace directory by run id, with an admin entry prunable by that name", () => {
    const runId = "run-prune-check";
    const baseRefSha = resolveBaseRef(consumer);
    const workspacePath = workspacePathForRun(runId, workspacesRoot);
    createWorkspace({ consumerRepoPath: consumer, baseRefSha, workspacePath, runBranch: runBranchForRun(runId) });

    expect(workspacePath.endsWith(runId)).toBe(true);
    const worktreeList = git(consumer, ["worktree", "list", "--porcelain"]);
    expect(worktreeList).toContain(workspacePath);
  });

  it("the CLI's own scratch directory (.claude/) does not appear in the workspace's git status, as seen through the engine's own pinned git view", () => {
    // KTD-6/U5 (corrected): the exclusion is `-c core.excludesFile=<a
    // graph-bro-owned file>` on every engine invocation, not anything written
    // in the workspace or the consumer — so this is checked through
    // `runWorkspaceGit`, the same path `commitAttempt` uses, not a raw `git`
    // call (which would consult neither the workspace's real config nor this
    // override, and correctly show `.claude/` as untracked).
    const runId = "run-scratch-exclude";
    const baseRefSha = resolveBaseRef(consumer);
    const workspacePath = workspacePathForRun(runId, workspacesRoot);
    createWorkspace({ consumerRepoPath: consumer, baseRefSha, workspacePath, runBranch: runBranchForRun(runId) });

    mkdirSync(join(workspacePath, ".claude"), { recursive: true });
    writeFileSync(join(workspacePath, ".claude", "settings.local.json"), "{}\n");

    const target = resolveWorkspaceGitTarget(consumer, workspacePath);
    expect(runWorkspaceGit(target, ["status", "--porcelain"])).toBe("");
  });

  it("Covers R10: creating a workspace never touches the consumer's own '.git/info/exclude', even when that file did not exist beforehand", () => {
    const consumerExcludePath = join(consumer, ".git", "info", "exclude");
    rmSync(consumerExcludePath, { force: true }); // simulate the file never having existed

    const runId = "run-consumer-exclude";
    const baseRefSha = resolveBaseRef(consumer);
    const workspacePath = workspacePathForRun(runId, workspacesRoot);
    createWorkspace({ consumerRepoPath: consumer, baseRefSha, workspacePath, runBranch: runBranchForRun(runId) });

    expect(existsSync(consumerExcludePath)).toBe(false); // must not be created either
  });

  it("Covers R10: a second run against the same consumer repo also has its .claude/ hidden — the excludes override is shared and static, not per-workspace, so there is nothing to accumulate", () => {
    const runIdA = "run-exclude-dupe-a";
    const runIdB = "run-exclude-dupe-b";
    const baseRefSha = resolveBaseRef(consumer);
    const workspaceA = workspacePathForRun(runIdA, workspacesRoot);
    const workspaceB = workspacePathForRun(runIdB, workspacesRoot);
    createWorkspace({ consumerRepoPath: consumer, baseRefSha, workspacePath: workspaceA, runBranch: runBranchForRun(runIdA) });
    createWorkspace({ consumerRepoPath: consumer, baseRefSha, workspacePath: workspaceB, runBranch: runBranchForRun(runIdB) });

    mkdirSync(join(workspaceA, ".claude"), { recursive: true });
    writeFileSync(join(workspaceA, ".claude", "settings.local.json"), "{}\n");
    mkdirSync(join(workspaceB, ".claude"), { recursive: true });
    writeFileSync(join(workspaceB, ".claude", "settings.local.json"), "{}\n");

    const targetA = resolveWorkspaceGitTarget(consumer, workspaceA);
    const targetB = resolveWorkspaceGitTarget(consumer, workspaceB);
    expect(runWorkspaceGit(targetA, ["status", "--porcelain"])).toBe("");
    expect(runWorkspaceGit(targetB, ["status", "--porcelain"])).toBe("");
  });

  it("a converged run's worktree is removed and its branch survives, readable from the consumer", () => {
    const runId = "run-converged";
    const baseRefSha = resolveBaseRef(consumer);
    const workspacePath = workspacePathForRun(runId, workspacesRoot);
    const runBranch = runBranchForRun(runId);
    createWorkspace({ consumerRepoPath: consumer, baseRefSha, workspacePath, runBranch });

    finalizeWorkspace({ consumerRepoPath: consumer, workspacePath, converged: true });

    expect(existsSync(workspacePath)).toBe(false);
    expect(git(consumer, ["log", "--oneline", runBranch]).trim().length).toBeGreaterThan(0); // branch still readable
  });

  it("a halted run's worktree is retained, and the run branch can still be checked out elsewhere while it exists", () => {
    const runId = "run-halted";
    const baseRefSha = resolveBaseRef(consumer);
    const workspacePath = workspacePathForRun(runId, workspacesRoot);
    const runBranch = runBranchForRun(runId);
    createWorkspace({ consumerRepoPath: consumer, baseRefSha, workspacePath, runBranch });

    finalizeWorkspace({ consumerRepoPath: consumer, workspacePath, converged: false });

    expect(existsSync(workspacePath)).toBe(true); // retained (KTD-9)
    // HEAD is detached in the retained workspace, so the branch is free to
    // check out elsewhere — proven by actually doing so from a second worktree.
    const secondWorktree = join(workspacesRoot, "elsewhere");
    expect(() => git(consumer, ["worktree", "add", secondWorktree, runBranch])).not.toThrow();
  });

  it("Covers R6: a post-checkout hook planted via a rewritten gitlink does not fire when finalizeWorkspace detaches — the real admin dir is resolved from the consumer, never from the workspace's own (agent-writable) .git", () => {
    const runId = "run-hostile-detach";
    const baseRefSha = resolveBaseRef(consumer);
    const workspacePath = workspacePathForRun(runId, workspacesRoot);
    const runBranch = runBranchForRun(runId);
    createWorkspace({ consumerRepoPath: consumer, baseRefSha, workspacePath, runBranch });

    // The agent rewrites the gitlink (#6) to a substitute admin dir it fully
    // controls, and plants a hook there — the only place within the sandbox's
    // write scope a hook could ever be registered against the workspace.
    const substituteAdminDir = join(workspacePath, ".fake-git");
    mkdirSync(join(substituteAdminDir, "hooks"), { recursive: true });
    const hookMarker = join(workspacePath, "hook-fired.txt");
    writeFileSync(join(substituteAdminDir, "hooks", "post-checkout"), `#!/bin/sh\necho fired > "${hookMarker}"\n`);
    execFileSync("chmod", ["+x", join(substituteAdminDir, "hooks", "post-checkout")]);
    writeFileSync(join(workspacePath, ".git"), "gitdir: .fake-git\n");

    finalizeWorkspace({ consumerRepoPath: consumer, workspacePath, converged: false });

    expect(existsSync(hookMarker)).toBe(false);
    // The detach landed on the real admin dir, not the substitute — proven by
    // reading HEAD's symbolic-ness back from the real worktree registration.
    const gitCommonDir = git(consumer, ["rev-parse", "--git-common-dir"]).trim();
    const gitCommonDirAbs = gitCommonDir.startsWith("/") ? gitCommonDir : join(consumer, gitCommonDir);
    const adminDir = join(gitCommonDirAbs, "worktrees", runId);
    expect(() => execFileSync("git", ["--git-dir", adminDir, "symbolic-ref", "-q", "HEAD"], { encoding: "utf8" })).toThrow(); // detached: no symbolic ref
  });
});
