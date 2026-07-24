import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadOnlyViolationError, assertRepoClean, buildReadOnlyArgs } from "../../src/executor/read-only-policy.js";

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

    it("passes silently when the cwd is clean", () => {
      expect(() => assertRepoClean(repoDir, "reader")).not.toThrow();
    });

    it("raises a loud, node-attributed failure when the cwd is left dirty", () => {
      writeFileSync(join(repoDir, "mutated.txt"), "oops\n");

      expect(() => assertRepoClean(repoDir, "reader")).toThrow(ReadOnlyViolationError);
      try {
        assertRepoClean(repoDir, "reader");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ReadOnlyViolationError);
        expect((err as ReadOnlyViolationError).nodeId).toBe("reader");
        expect((err as Error).message).toContain("reader");
      }
    });
  });
});
