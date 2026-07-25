import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAttempt, partialAttemptRef, preserveInterruptedAttempt } from "../../src/workspace/commit.js";
import { reattachToRunBranch } from "../../src/workspace/lifecycle.js";
import { waitFor } from "../fixtures/cli-harness.js";

/** `git symbolic-ref -q HEAD` exits 1 (no output) when detached — execFileSync throws on that, so this reports "" instead of letting the throw escape. */
function symbolicRefOrEmpty(cwd: string): string {
  try {
    return git(cwd, ["symbolic-ref", "-q", "HEAD"]).trim();
  } catch {
    return "";
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commitCount(cwd: string, ref = "HEAD"): number {
  return Number(git(cwd, ["rev-list", "--count", ref]).trim());
}

/** Enumerates the refs preserved under a run's partial-attempt namespace — `partialAttemptRef` returns the namespace prefix, not a single ref, per KTD-13. */
function partialAttemptRefs(cwd: string, runId: string): { refname: string; sha: string }[] {
  const output = git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", partialAttemptRef(runId)]).trim();
  if (output === "") return [];
  return output.split("\n").map((line) => {
    const spaceIndex = line.indexOf(" ");
    return { refname: line.slice(0, spaceIndex), sha: line.slice(spaceIndex + 1) };
  });
}

/**
 * A throwaway consumer + linked-worktree pair — mirrors what `createWorkspace`
 * hands the runtime. KTD-7's resolution reads the consumer's own worktree
 * registry, so (unlike the pre-U3 suite) every test needs a *real* linked
 * worktree, not a standalone repo standing in for one.
 */
function workspacePair(): { consumer: string; workspace: string } {
  const consumer = mkdtempSync(join(tmpdir(), "graph-bro-commit-consumer-"));
  git(consumer, ["init", "-q"]);
  git(consumer, ["config", "user.email", "test@example.com"]);
  git(consumer, ["config", "user.name", "test"]);
  git(consumer, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(consumer, "README.md"), "hello\n");
  git(consumer, ["add", "-A"]);
  git(consumer, ["commit", "-q", "-m", "init"]);

  const workspace = join(mkdtempSync(join(tmpdir(), "graph-bro-commit-workspace-root-")), "ws");
  git(consumer, ["worktree", "add", "-q", "-b", "graph-bro/run-commit-test", workspace]);
  return { consumer, workspace };
}

describe("workspace/commit: commitAttempt (KTD-7, R20/R21, real git)", () => {
  let consumer: string;
  let workspace: string;

  beforeEach(() => {
    ({ consumer, workspace } = workspacePair());
  });

  afterEach(() => {
    rmSync(consumer, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("a write node that changes nothing produces no empty attempt commit", () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    const before = commitCount(workspace);

    const result = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

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

    const result = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    expect(commitCount(workspace)).toBe(before + 1); // three folded into one
    expect(readFileSync(join(workspace, "agent-commit-0.txt"), "utf8")).toBe("content 0\n");
    expect(readFileSync(join(workspace, "agent-commit-2.txt"), "utf8")).toBe("content 2\n");
  });

  it("a write node that leaves the tree dirty without committing is folded into exactly one attempt commit", () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    const before = commitCount(workspace);
    writeFileSync(join(workspace, "dirty.txt"), "left uncommitted\n");

    const result = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

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

    const result = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    expect(commitCount(workspace)).toBe(before + 1);
    expect(readFileSync(join(workspace, "agent-commit.txt"), "utf8")).toBe("committed by agent\n");
    expect(readFileSync(join(workspace, "leftover.txt"), "utf8")).toBe("left dirty\n");
  });

  it("Covers R21: a 'failing' attempt (state left as-is) is committed and remains reachable from the branch afterwards", () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "partial-work.txt"), "the node failed mid-write\n");

    const result = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    // Reachable from the current branch — a failing attempt is not discarded.
    expect(git(workspace, ["branch", "--contains", result.head]).trim()).not.toBe("");
  });

  it("the commit message carries the attempt number", () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "x.txt"), "x\n");

    const result = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 7, nodeId: "reviewer" });

    const message = git(workspace, ["log", "-1", "--format=%s", result.head]);
    expect(message).toContain("attempt 7");
    expect(message).toContain("reviewer");
  });

  it("two consecutive attempts produce two commits in order on the branch", () => {
    let priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    const before = commitCount(workspace);

    writeFileSync(join(workspace, "attempt-1.txt"), "1\n");
    const first = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });
    expect(first.committed).toBe(true);
    priorHead = first.head;

    writeFileSync(join(workspace, "attempt-2.txt"), "2\n");
    const second = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 2, nodeId: "reviewer" });
    expect(second.committed).toBe(true);

    expect(commitCount(workspace)).toBe(before + 2);
    const messages = git(workspace, ["log", "-2", "--format=%s"]).trim().split("\n");
    expect(messages[0]).toContain("attempt 2");
    expect(messages[1]).toContain("attempt 1");
  });

  it("Covers R17: a separate, unrelated consumer repo's own branches and history are untouched — commitAttempt only ever operates on the workspace it's given", () => {
    const unrelatedConsumer = mkdtempSync(join(tmpdir(), "graph-bro-commit-unrelated-consumer-"));
    try {
      git(unrelatedConsumer, ["init", "-q"]);
      git(unrelatedConsumer, ["config", "user.email", "test@example.com"]);
      git(unrelatedConsumer, ["config", "user.name", "test"]);
      git(unrelatedConsumer, ["config", "commit.gpgsign", "false"]);
      writeFileSync(join(unrelatedConsumer, "README.md"), "consumer\n");
      git(unrelatedConsumer, ["add", "-A"]);
      git(unrelatedConsumer, ["commit", "-q", "-m", "init"]);
      const unrelatedHeadBefore = git(unrelatedConsumer, ["rev-parse", "HEAD"]).trim();

      const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
      writeFileSync(join(workspace, "x.txt"), "x\n");
      commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

      expect(git(unrelatedConsumer, ["rev-parse", "HEAD"]).trim()).toBe(unrelatedHeadBefore);
    } finally {
      rmSync(unrelatedConsumer, { recursive: true, force: true });
    }
  });

  it("the CLI's scratch directory is not present in any attempt commit (KTD-6: core.excludesFile is pinned by the helper, not by anything written in the workspace)", () => {
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(join(workspace, ".claude", "settings.local.json"), "{}\n");

    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "x.txt"), "x\n");
    const result = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

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
    const result = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("Covers R7: an operator's signing config (commit.gpgsign true, a gpg program that would fail) does not stop the attempt commit, and the commit carries no signature", () => {
    // Every OTHER scratch repo in this suite sets commit.gpgsign false —
    // deliberately not done here, so this is the one test that can actually
    // observe the gap the rest of the suite structurally hides.
    git(workspace, ["config", "commit.gpgsign", "true"]);
    git(workspace, ["config", "gpg.format", "ssh"]);
    git(workspace, ["config", "gpg.ssh.program", "/nonexistent/ssh-keygen-that-does-not-exist"]);

    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "x.txt"), "x\n");

    const result = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    // %G? is empty for an unsigned commit, "N" for a signed-but-unverifiable
    // one — either is fine here, but a signature attempt with this program
    // would have thrown well before this line, per the RED evidence above.
    const signatureStatus = git(workspace, ["log", "-1", "--format=%G?", result.head]).trim();
    expect(signatureStatus === "" || signatureStatus === "N").toBe(true);
    const rawSignature = git(workspace, ["cat-file", "commit", result.head]);
    expect(rawSignature).not.toContain("gpgsig");
  });

  it("Covers R6: a filter.evil.clean driver planted via a rewritten gitlink does not run — commitAttempt resolves the real admin dir from the consumer, never the workspace's own (agent-writable) .git", () => {
    // The agent plants ordinary tracked content directly in the workspace
    // (fully within its write scope): a .gitattributes routing *.txt through
    // "evil", and the file it's meant to apply to.
    writeFileSync(join(workspace, ".gitattributes"), "*.txt filter=evil\n");
    writeFileSync(join(workspace, "data.txt"), "secret\n");

    // The agent also rewrites the workspace's own gitlink (#6) to point at a
    // substitute repo it fully controls, and defines the filter driver
    // there — the only place within the sandbox's write scope where a
    // filter.*.clean driver could ever be registered.
    const substituteAdminDir = join(workspace, ".fake-git");
    mkdirSync(substituteAdminDir, { recursive: true });
    const filterMarker = join(workspace, "filter-marker.txt");
    git(substituteAdminDir, ["init", "-q", "--bare"]);
    execFileSync("git", ["--git-dir", substituteAdminDir, "config", "filter.evil.clean", `sh -c 'echo FILTER_FIRED > ${filterMarker}; cat'`]);
    writeFileSync(join(workspace, ".git"), "gitdir: .fake-git\n");

    const priorHead = git(consumer, ["rev-parse", "graph-bro/run-commit-test"]).trim();
    const result = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });

    expect(result.committed).toBe(true);
    expect(existsSync(filterMarker)).toBe(false);
    // The commit landed on the real run branch, not inside the substitute repo.
    expect(git(consumer, ["log", "--format=%s", result.head])).toContain("attempt 1");
  });

  it("a detached background writer left behind is reported via a quiescence warning rather than silently absorbed", async () => {
    const priorHead = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "x.txt"), "x\n");

    // Writes continuously from the moment it's spawned, rather than after a
    // fixed delay: `commitAttempt` is fully synchronous (a handful of
    // execFileSync calls), so there is no reliable fixed delay that lands a
    // single write inside that narrow window. A writer active throughout is
    // certain to still be dirtying the tree by the time commitAttempt's own
    // post-commit status check runs.
    //
    // A tight loop, not a 2ms `setInterval`. `commitAttempt` is synchronous,
    // so nothing here can synchronise with the moment its post-commit status
    // check runs — the writer just has to be dirtying the tree throughout.
    // A timer-driven writer only needs to lose its scheduling slice for the
    // length of four git subprocesses to leave a clean tree, which is what
    // made this flake roughly one full-suite run in five. A runnable
    // tight-loop process would have to be starved of *every* core for that
    // whole window instead. That is mitigation, not a proof: the honest
    // deterministic fix is to make the post-commit dirt check injectable, and
    // that is deliberately not being done here to keep a test concern out of
    // production code.
    const target = join(workspace, "straggler.txt");
    const straggler = spawn(
      process.execPath,
      ["-e", `let n = 0; const fs = require('fs'); for (;;) fs.writeFileSync(${JSON.stringify(target)}, String(n++));`],
      { stdio: "ignore" },
    );

    // `spawn` returns before the child process has actually booted and run
    // its first write — on a heavily loaded (e.g. 2-fork CI) runner,
    // `commitAttempt` below can win that race and observe a clean tree.
    // Block on the straggler's first observable write instead of guessing a
    // delay, so the assertion no longer depends on which side wins a race.
    await waitFor(() => existsSync(target), 5000);

    let result: ReturnType<typeof commitAttempt>;
    try {
      result = commitAttempt({ consumerRepoPath: consumer, workspacePath: workspace, priorHead, attemptNumber: 1, nodeId: "reviewer" });
    } finally {
      straggler.kill("SIGKILL");
    }

    expect(result.committed).toBe(true);
    expect(result.quiescenceWarning).toContain("reviewer");
    expect(result.quiescenceWarning).toContain("not quiescent");
  });
});

describe("workspace/commit: preserveInterruptedAttempt (U8, F3/AE9, real git)", () => {
  let consumer: string;
  let workspace: string;

  beforeEach(() => {
    ({ consumer, workspace } = workspacePair());
  });

  afterEach(() => {
    rmSync(consumer, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("is a no-op when the workspace is already clean", () => {
    const headBefore = git(workspace, ["rev-parse", "HEAD"]).trim();

    const result = preserveInterruptedAttempt(consumer, workspace, "run-x", headBefore);

    expect(result.preserved).toBe(false);
    expect(git(workspace, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(partialAttemptRefs(workspace, "run-x")).toHaveLength(0);
  });

  it("Covers AE9: preserves a killed run's dirty tree — tracked and untracked — as a reachable side-ref commit, then hard-resets the workspace", () => {
    const headBefore = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "README.md"), "mid-edit\n"); // tracked file, modified
    writeFileSync(join(workspace, "new-file.txt"), "untracked\n"); // never committed anywhere

    const result = preserveInterruptedAttempt(consumer, workspace, "run-x", headBefore);

    expect(result.preserved).toBe(true);
    expect(result.sha).toBeTruthy();

    // The side ref is reachable and holds the interrupted state...
    const shownTracked = git(workspace, ["show", `${result.sha}:README.md`]);
    expect(shownTracked).toBe("mid-edit\n");
    const shownUntracked = git(workspace, ["show", `${result.sha}:new-file.txt`]);
    expect(shownUntracked).toBe("untracked\n");
    const refs = partialAttemptRefs(workspace, "run-x");
    expect(refs).toHaveLength(1);
    expect(refs[0].sha).toBe(result.sha);

    // ...but the run branch itself is untouched by it (never folded into an attempt commit)...
    expect(git(workspace, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);

    // ...and the workspace's working tree is back to exactly the last committed attempt.
    expect(git(workspace, ["status", "--porcelain"]).trim()).toBe("");
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(workspace, "new-file.txt"))).toBe(false);
  });

  it("preserves the agent's own commits too, not just the working tree, before resetting", () => {
    const headBefore = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "agent-commit.txt"), "committed mid-attempt\n");
    git(workspace, ["add", "-A"]);
    git(workspace, ["commit", "-q", "-m", "agent's own commit before the kill"]);

    const result = preserveInterruptedAttempt(consumer, workspace, "run-y", headBefore);

    expect(result.preserved).toBe(true);
    expect(git(workspace, ["show", `${result.sha}:agent-commit.txt`])).toBe("committed mid-attempt\n");
    expect(git(workspace, ["rev-parse", "HEAD"]).trim()).toBe(headBefore); // the agent's commit is gone from the branch
    expect(existsSync(join(workspace, "agent-commit.txt"))).toBe(false); // and from the working tree
  });

  it("Covers R16/KTD-13: two kill-and-resume cycles of one run leave two independently reachable preserved commits, both enumerable under the namespace", () => {
    const headBefore = git(workspace, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(workspace, "cycle-one.txt"), "first interrupted attempt\n");
    const first = preserveInterruptedAttempt(consumer, workspace, "run-z", headBefore);
    expect(first.preserved).toBe(true);

    // Second kill-and-resume cycle of the *same* run — a run-id-keyed ref
    // would silently replace the first cycle's ref here, and since it sits
    // outside refs/heads/, git keeps no reflog and the displaced commit
    // would be immediately gc-eligible.
    writeFileSync(join(workspace, "cycle-two.txt"), "second interrupted attempt\n");
    const second = preserveInterruptedAttempt(consumer, workspace, "run-z", headBefore);
    expect(second.preserved).toBe(true);

    const refs = partialAttemptRefs(workspace, "run-z");
    expect(refs).toHaveLength(2);
    const shas = refs.map((r) => r.sha).sort();
    expect(shas).toEqual([first.sha, second.sha].sort());

    // Both commits are independently reachable and hold their own distinct content.
    expect(git(workspace, ["show", `${first.sha}:cycle-one.txt`])).toBe("first interrupted attempt\n");
    expect(git(workspace, ["show", `${second.sha}:cycle-two.txt`])).toBe("second interrupted attempt\n");
  });
});

describe("workspace/lifecycle: reattachToRunBranch (U8, KTD-9, real git)", () => {
  let consumer: string;
  let workspace: string;
  const runBranch = "graph-bro/run-reattach-test";

  beforeEach(() => {
    consumer = mkdtempSync(join(tmpdir(), "graph-bro-reattach-consumer-"));
    git(consumer, ["init", "-q"]);
    git(consumer, ["config", "user.email", "test@example.com"]);
    git(consumer, ["config", "user.name", "test"]);
    git(consumer, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(consumer, "README.md"), "hello\n");
    git(consumer, ["add", "-A"]);
    git(consumer, ["commit", "-q", "-m", "init"]);

    workspace = join(mkdtempSync(join(tmpdir(), "graph-bro-reattach-ws-root-")), "ws");
    execFileSync("git", ["worktree", "add", "-b", runBranch, workspace], { cwd: consumer, encoding: "utf8" });
  });

  afterEach(() => {
    rmSync(consumer, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("re-attaches a retained workspace's detached HEAD back onto the run branch", () => {
    git(workspace, ["checkout", "--detach", "HEAD"]); // mirrors finalizeWorkspace's KTD-9 detach

    expect(symbolicRefOrEmpty(workspace)).toBe(""); // detached: no symbolic ref

    reattachToRunBranch(consumer, workspace, runBranch);

    expect(symbolicRefOrEmpty(workspace)).toBe(`refs/heads/${runBranch}`);
  });

  it("Covers: the run branch checked out in another worktree — reattach aborts naming the holding worktree, rather than proceeding detached", () => {
    git(workspace, ["checkout", "--detach", "HEAD"]);

    const elsewhere = join(mkdtempSync(join(tmpdir(), "graph-bro-reattach-elsewhere-")), "checkout");
    execFileSync("git", ["worktree", "add", elsewhere, runBranch], { cwd: consumer, encoding: "utf8" });
    try {
      expect(() => reattachToRunBranch(consumer, workspace, runBranch)).toThrow(new RegExp(runBranch.replace(/\//g, "\\/")));
      // Still detached — never left in a half-attached state.
      expect(symbolicRefOrEmpty(workspace)).toBe("");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("Covers KTD-7: a workspace whose .git gitlink has been replaced still resolves the real admin dir via the consumer, so reattach lands on the true worktree rather than erroring against a substitute repo", () => {
    const substituteAdminDir = join(workspace, ".fake-git");
    mkdirSync(substituteAdminDir, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", substituteAdminDir]);
    git(workspace, ["checkout", "--detach", "HEAD"]);
    writeFileSync(join(workspace, ".git"), "gitdir: .fake-git\n");

    reattachToRunBranch(consumer, workspace, runBranch);

    // Resolved and re-attached against the REAL admin dir — --git-dir/--work-tree
    // pinned there directly, so this must be read the same way, not through
    // the now-rewritten (and thus untrustworthy) workspace .git file.
    const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: consumer, encoding: "utf8" }).trim();
    const gitCommonDirAbs = gitCommonDir.startsWith("/") ? gitCommonDir : join(consumer, gitCommonDir);
    const adminDir = join(gitCommonDirAbs, "worktrees", "ws");
    const head = execFileSync("git", ["--git-dir", adminDir, "symbolic-ref", "-q", "HEAD"], { encoding: "utf8" }).trim();
    expect(head).toBe(`refs/heads/${runBranch}`);
  });
});
