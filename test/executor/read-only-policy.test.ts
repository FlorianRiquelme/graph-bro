import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  describe("capturePorcelain sees the .claude config surface again (U4: fe51ff7's excludes pin blinded it)", () => {
    let consumer: string;
    let workspace: string;

    beforeEach(() => {
      consumer = mkdtempSync(join(tmpdir(), "graph-bro-ro-excludes-consumer-"));
      execFileSync("git", ["init", "-q"], { cwd: consumer });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: consumer });
      execFileSync("git", ["config", "user.name", "test"], { cwd: consumer });
      writeFileSync(join(consumer, "README.md"), "hello\n");
      execFileSync("git", ["add", "-A"], { cwd: consumer });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: consumer });
      workspace = join(mkdtempSync(join(tmpdir(), "graph-bro-ro-excludes-ws-")), "wt");
      execFileSync("git", ["worktree", "add", "-q", workspace, "-b", "ro-excludes-probe"], { cwd: consumer });
    });

    afterEach(() => {
      rmSync(consumer, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    });

    it("a read-only node planting .claude/settings.local.json raises the violation and names the path", () => {
      const baseline = capturePorcelain(workspace, consumer);
      mkdirSync(join(workspace, ".claude"), { recursive: true });
      writeFileSync(join(workspace, ".claude", "settings.local.json"), "{}\n");

      expect(() => assertRepoClean(workspace, "reader", baseline, consumer)).toThrow(ReadOnlyViolationError);
      try {
        assertRepoClean(workspace, "reader", baseline, consumer);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).toContain(".claude/settings.local.json");
      }
    });

    it("does not raise for the CLI's own scratch under .claude/.cc-writes/ (U1's probe)", () => {
      const baseline = capturePorcelain(workspace, consumer);
      mkdirSync(join(workspace, ".claude", ".cc-writes"), { recursive: true });
      writeFileSync(join(workspace, ".claude", ".cc-writes", "probe-file"), "scratch\n");

      expect(() => assertRepoClean(workspace, "reader", baseline, consumer)).not.toThrow();
    });

    it("still raises for an ordinary untracked file outside .claude", () => {
      const baseline = capturePorcelain(workspace, consumer);
      writeFileSync(join(workspace, "mutated.txt"), "oops\n");

      expect(() => assertRepoClean(workspace, "reader", baseline, consumer)).toThrow(ReadOnlyViolationError);
    });

    it("does not raise when a pre-existing .claude directory's stable content is present in both reads", () => {
      mkdirSync(join(workspace, ".claude"), { recursive: true });
      writeFileSync(join(workspace, ".claude", "settings.local.json"), "{}\n");
      const baseline = capturePorcelain(workspace, consumer);

      expect(() => assertRepoClean(workspace, "reader", baseline, consumer)).not.toThrow();
    });
  });

  describe("capturePorcelain vs. a consumer-committed .gitignore excluding .claude/ (U4)", () => {
    let consumer: string;
    let workspace: string;

    beforeEach(() => {
      consumer = mkdtempSync(join(tmpdir(), "graph-bro-ro-consumer-gitignore-"));
      execFileSync("git", ["init", "-q"], { cwd: consumer });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: consumer });
      execFileSync("git", ["config", "user.name", "test"], { cwd: consumer });
      // A widespread convention: the consumer repo itself commits a
      // `.gitignore` excluding `.claude/` — a separate ignore source from
      // `core.excludesFile`, which the pin alone does not neutralize.
      writeFileSync(join(consumer, ".gitignore"), ".claude/\n");
      writeFileSync(join(consumer, "README.md"), "hello\n");
      execFileSync("git", ["add", "-A"], { cwd: consumer });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: consumer });
      workspace = join(mkdtempSync(join(tmpdir(), "graph-bro-ro-ws-gitignore-")), "wt");
      execFileSync("git", ["worktree", "add", "-q", workspace, "-b", "ro-gitignore-probe"], { cwd: consumer });
    });

    afterEach(() => {
      rmSync(consumer, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    });

    it("still surfaces a planted .claude/settings.local.json via the pathspec-limited --ignored=traditional read", () => {
      const baseline = capturePorcelain(workspace, consumer);
      mkdirSync(join(workspace, ".claude"), { recursive: true });
      writeFileSync(join(workspace, ".claude", "settings.local.json"), "{}\n");

      // Asserted against the specific planted path, not merely that some
      // violation was raised: `--ignored=matching` collapses an entirely
      // ignored directory to a single `!! .claude/` entry, which is
      // identical whether the directory holds only the CLI's own benign
      // `.cc-writes/` scratch or a maliciously planted `settings.local.json`
      // — B and D are indistinguishable under it. `--ignored=traditional`
      // reports the ignored path itself, so the planted file is what
      // actually shows up here.
      const afterPlanting = capturePorcelain(workspace, consumer);
      expect(afterPlanting).toContain("!! .claude/settings.local.json");

      expect(() => assertRepoClean(workspace, "reader", baseline, consumer)).toThrow(ReadOnlyViolationError);
      try {
        assertRepoClean(workspace, "reader", baseline, consumer);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).toContain(".claude/settings.local.json");
      }
    });

    it("does not raise for the CLI's own benign .claude/.cc-writes/ scratch, empty or with a file inside", () => {
      // The failure mode --ignored=matching would introduce: the CLI
      // unconditionally creates `.claude/.cc-writes/` in every capability arm
      // (U1's probe). Under a consumer .gitignore excluding `.claude/`, an
      // entirely-ignored directory collapses to one `!! .claude/` entry
      // regardless of what's inside it, which `withoutCcWrites` cannot
      // subtract (it only recognizes paths starting with the literal
      // `.claude/.cc-writes/` prefix, not the collapsed parent). That would
      // fail every live read-only run against such a consumer.
      // --ignored=traditional reports file-level paths instead, so an empty
      // scratch directory produces nothing at all, and a file inside it
      // produces a `.claude/.cc-writes/...` path `withoutCcWrites` already
      // filters — this is the scenario that catches a regression back to
      // `matching`.
      const baselineEmpty = capturePorcelain(workspace, consumer);
      mkdirSync(join(workspace, ".claude", ".cc-writes"), { recursive: true });
      expect(() => assertRepoClean(workspace, "reader", baselineEmpty, consumer)).not.toThrow();

      const baselineWithFile = capturePorcelain(workspace, consumer);
      writeFileSync(join(workspace, ".claude", ".cc-writes", "tmp"), "scratch\n");
      expect(() => assertRepoClean(workspace, "reader", baselineWithFile, consumer)).not.toThrow();
    });
  });

  describe("capturePorcelain against a real global core.excludesFile (U4: the omit-vs-pin scenario)", () => {
    let consumer: string;
    let workspace: string;
    let globalConfigPath: string;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      consumer = mkdtempSync(join(tmpdir(), "graph-bro-ro-real-global-consumer-"));
      execFileSync("git", ["init", "-q"], { cwd: consumer });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: consumer });
      execFileSync("git", ["config", "user.name", "test"], { cwd: consumer });
      writeFileSync(join(consumer, "README.md"), "hello\n");
      execFileSync("git", ["add", "-A"], { cwd: consumer });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: consumer });
      workspace = join(mkdtempSync(join(tmpdir(), "graph-bro-ro-real-global-ws-")), "wt");
      execFileSync("git", ["worktree", "add", "-q", workspace, "-b", "ro-real-global-probe"], { cwd: consumer });

      // A real operator-machine global excludes file, set the same way an
      // actual operator's would be — not the hermetic injection
      // `test/setup/hermetic-git.ts` forces for the rest of the suite.
      // Cleared here so this test exercises production resolution instead of
      // the hermetic default, which would make an omit-vs-pin mistake look
      // identical to the fix (per hermetic-git.ts's own comment).
      const globalDir = mkdtempSync(join(tmpdir(), "graph-bro-real-global-"));
      const globalGitignore = join(globalDir, "gitignore_global");
      writeFileSync(globalGitignore, "/.claude/\n");
      globalConfigPath = join(globalDir, "gitconfig_global");
      writeFileSync(globalConfigPath, `[core]\n\texcludesFile = ${globalGitignore}\n`);

      savedEnv = {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
        GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
        GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      };
      process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(consumer, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    });

    it("a planted .claude/settings.local.json still appears in porcelain despite the operator's global excludesFile", () => {
      const baseline = capturePorcelain(workspace, consumer);
      mkdirSync(join(workspace, ".claude"), { recursive: true });
      writeFileSync(join(workspace, ".claude", "settings.local.json"), "{}\n");

      // Asserted directly against the tracked (`?? `) read, not just that
      // *some* violation is raised: the folded `--ignored=matching` read
      // would also catch this path once it is ignored by *any* mechanism
      // (including the operator's real global excludesFile itself), which
      // would let an implementation that omits the excludes override
      // entirely — rather than pinning it to `/dev/null` — pass this test
      // for the wrong reason. `?? .claude/settings.local.json` only appears
      // when the tracked read genuinely does not treat the path as ignored.
      const afterPlanting = capturePorcelain(workspace, consumer);
      expect(afterPlanting).toContain("?? .claude/settings.local.json");

      expect(() => assertRepoClean(workspace, "reader", baseline, consumer)).toThrow(ReadOnlyViolationError);
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
