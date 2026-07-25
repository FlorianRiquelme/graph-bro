import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReadOnlyViolationError,
  assertRepoClean,
  buildReadOnlyArgs,
  buildReadOnlyPolicy,
  capturePorcelain,
} from "../../src/executor/read-only-policy.js";

describe("executor: read-only-policy", () => {
  it("builds the mutation-denying allowlist with no --dangerously-skip-permissions", () => {
    const args = buildReadOnlyArgs();

    expect(args[0]).toBe("--allowedTools");
    const allowlist = args[1];
    expect(allowlist).toContain("Read");
    expect(allowlist).toContain("Grep");
    expect(allowlist).toContain("Glob");
    expect(allowlist).toContain("Bash(git status *)");
    expect(allowlist).not.toContain("Edit");
    expect(allowlist).not.toContain("Write");
    expect(allowlist).not.toContain("NotebookEdit");
    expect(args.join(" ")).not.toContain("--dangerously-skip-permissions");
  });

  describe("buildReadOnlyPolicy (R9/KTD-9: the OS-sandbox layer)", () => {
    it("declares the sandbox enabled and failIfUnavailable, mirroring buildWritePolicy's shape", () => {
      const policy = buildReadOnlyPolicy();
      expect(policy.argv).toContain("--settings");
      const settings = JSON.parse(policy.argv[policy.argv.indexOf("--settings") + 1]);
      expect(settings.sandbox.enabled).toBe(true);
      expect(settings.sandbox.failIfUnavailable).toBe(true);
    });

    it("declares no writable paths — a read-only node has no legitimate write target", () => {
      const policy = buildReadOnlyPolicy();
      const settings = JSON.parse(policy.argv[policy.argv.indexOf("--settings") + 1]);
      expect(settings.sandbox.filesystem.allowWrite).toEqual([]);
    });

    it("declares no allowed network domains", () => {
      const policy = buildReadOnlyPolicy();
      const settings = JSON.parse(policy.argv[policy.argv.indexOf("--settings") + 1]);
      expect(settings.sandbox.network.allowedDomains).toEqual([]);
    });
  });

  describe("capturePorcelain pinning (R6/KTD-6: the backstop's own git is not the agent's)", () => {
    let consumer: string;
    let workspace: string;

    beforeEach(() => {
      consumer = mkdtempSync(join(tmpdir(), "graph-bro-ro-consumer-"));
      execFileSync("git", ["init", "-q"], { cwd: consumer });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: consumer });
      execFileSync("git", ["config", "user.name", "test"], { cwd: consumer });
      writeFileSync(join(consumer, "README.md"), "hello\n");
      execFileSync("git", ["add", "-A"], { cwd: consumer });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: consumer });
      workspace = join(mkdtempSync(join(tmpdir(), "graph-bro-ro-ws-")), "wt");
      execFileSync("git", ["worktree", "add", "-q", workspace, "-b", "ro-probe"], { cwd: consumer });
    });

    afterEach(() => {
      rmSync(consumer, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    });

    it("a rewritten .git gitlink cannot make a dirty workspace read as clean", () => {
      // #6's escape, aimed at the read-only backstop rather than the attempt
      // commit: the agent points `<workspace>/.git` at a repository it fully
      // controls, so an unpinned `git status` run from inside the workspace
      // reports that substitute's cleanliness instead of the real one. With
      // the consumer repo supplied, the admin dir is resolved from the
      // consumer's own worktree registry and the rewrite is inert.
      writeFileSync(join(workspace, "evidence.txt"), "a read-only node wrote this\n");

      // Build the substitute so it *already contains* the write, then point
      // the gitlink at it. Simply redirecting at an empty repo would make the
      // write show up as untracked and prove nothing — the escape only works
      // when the substitute's HEAD already matches the tampered tree, so its
      // `status` reports clean while the real repository still sees the file.
      const substitute = mkdtempSync(join(tmpdir(), "graph-bro-ro-substitute-"));
      const substituteGitDir = join(substitute, ".git");
      const asSubstitute = (args: string[]): void => {
        execFileSync("git", ["--git-dir", substituteGitDir, "--work-tree", workspace, ...args], { stdio: "ignore" });
      };
      execFileSync("git", ["init", "-q", substitute], { stdio: "ignore" });
      execFileSync("git", ["-C", substitute, "config", "user.email", "agent@example.com"], { stdio: "ignore" });
      execFileSync("git", ["-C", substitute, "config", "user.name", "agent"], { stdio: "ignore" });
      asSubstitute(["add", "-A"]);
      asSubstitute(["commit", "-q", "-m", "agent's own baseline"]);
      writeFileSync(join(workspace, ".git"), `gitdir: ${substituteGitDir}\n`);

      try {
        // The escape, demonstrated: discovering the repo from inside the
        // workspace consults the rewritten gitlink and reports clean.
        expect(capturePorcelain(workspace).trim()).toBe("");
        // Pinned from the consumer's worktree registry, the rewrite is inert.
        expect(capturePorcelain(workspace, consumer)).toContain("evidence.txt");
      } finally {
        rmSync(substitute, { recursive: true, force: true });
      }
    });
  });

  describe("assertRepoClean (KTD-10 backstop)", () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = mkdtempSync(join(tmpdir(), "graph-bro-read-only-"));
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir }); // throwaway /tmp repo; no signing agent dependency
      writeFileSync(join(repoDir, "committed.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
    });

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true });
    });

    it("passes silently when the cwd is unchanged since the baseline", () => {
      const baseline = capturePorcelain(repoDir);
      expect(() => assertRepoClean(repoDir, "reader", baseline)).not.toThrow();
    });

    it("passes when the baseline was already dirty and nothing changed since (U6's per-node rescoping)", () => {
      writeFileSync(join(repoDir, "already-dirty.txt"), "pre-existing\n");
      const baseline = capturePorcelain(repoDir);

      expect(() => assertRepoClean(repoDir, "reader", baseline)).not.toThrow();
    });

    it("raises a loud, node-attributed failure when the cwd changes after the baseline", () => {
      const baseline = capturePorcelain(repoDir);
      writeFileSync(join(repoDir, "mutated.txt"), "oops\n");

      expect(() => assertRepoClean(repoDir, "reader", baseline)).toThrow(ReadOnlyViolationError);
      try {
        assertRepoClean(repoDir, "reader", baseline);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ReadOnlyViolationError);
        expect((err as ReadOnlyViolationError).nodeId).toBe("reader");
        expect((err as Error).message).toContain("reader");
      }
    });
  });
});
