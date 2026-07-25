import { execFileSync } from "node:child_process";

/**
 * KTD-11: the R12/R16/R17 backstop. The primary enforcement is the OS
 * boundary (KTD-3); this is what confirms it held, comparing against a
 * baseline captured once at run start rather than asserting the checkout is
 * *clean* — a clean-tree assertion would contradict AE7, which starts a run
 * from a deliberately dirty consumer on purpose. Lives in `src/workspace`,
 * not the executor (`src/executor/write-policy.ts`), which has no other
 * reason to know the consumer's path (U6 file list).
 */
export interface ConsumerBaseline {
  porcelain: string;
  /** Catches a further edit to a file that was *already* dirty at baseline capture — porcelain alone can't, since its status line ("M") doesn't change. */
  diff: string;
  /** `git for-each-ref` output with every `graph-bro/run-*` branch filtered out — a linked worktree commits into the consumer's real ref store on every attempt, which plain `git status` cannot see, and other concurrent runs' branches are not "the consumer's own" refs either (R15). */
  refs: string;
}

const RUN_BRANCH_REF_PREFIX = "refs/heads/graph-bro/run-";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function captureRefs(consumerRepoPath: string): string {
  const output = git(consumerRepoPath, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  return output
    .split("\n")
    .filter((line) => !line.startsWith(RUN_BRANCH_REF_PREFIX))
    .join("\n");
}

export function captureConsumerBaseline(consumerRepoPath: string): ConsumerBaseline {
  return {
    porcelain: git(consumerRepoPath, ["status", "--porcelain"]),
    diff: git(consumerRepoPath, ["diff", "HEAD"]),
    refs: captureRefs(consumerRepoPath),
  };
}

export class ConsumerBaselineViolationError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly details: string,
  ) {
    super(`node '${nodeId}' left the consumer checkout touched (R12/R16/R17 backstop):\n${details}`);
    this.name = "ConsumerBaselineViolationError";
  }
}

/** Raises `ConsumerBaselineViolationError` naming `nodeId` if the consumer checkout has diverged from `baseline` since run start. */
export function assertConsumerBaseline(consumerRepoPath: string, baseline: ConsumerBaseline, nodeId: string): void {
  const current = captureConsumerBaseline(consumerRepoPath);
  const violations: string[] = [];
  if (current.porcelain !== baseline.porcelain) {
    violations.push(`working tree/index changed (git status --porcelain):\n${current.porcelain}`);
  }
  if (current.diff !== baseline.diff) {
    violations.push(`tracked file content changed (git diff HEAD):\n${current.diff}`);
  }
  if (current.refs !== baseline.refs) {
    violations.push(`ref set changed outside the run branch (git for-each-ref):\n${current.refs}`);
  }
  if (violations.length > 0) {
    throw new ConsumerBaselineViolationError(nodeId, violations.join("\n\n"));
  }
}
