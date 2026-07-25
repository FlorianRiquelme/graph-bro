import { defineConfig } from "vitest/config";

// GitHub Actions runners have far fewer cores than a dev machine. The
// process-heavy CLI/integration/smoke suites each spawn a detached engine plus
// a per-fan-out-branch agent subprocess; letting vitest fan test files across
// every core on a small runner oversubscribes the CPU and starves those
// detached process trees past their status-poll deadlines — the #4 flake that
// two prior smoke-test timeout bumps (5s→15s) never cured. Cap the fork pool on
// CI so the spawned processes get scheduling headroom; leave local dev (many
// cores, no starvation) unconstrained.
//
// U1: the cap is now 1, not 2. Installing bubblewrap/socat on the runner made
// the write-path suites (workspace-isolation, write-crash-resume, the
// review-fix-loop smoke) actually execute instead of failing the OS-boundary
// precheck, and their detached process trees pushed total load past what two
// forks absorbed — starving the read-only fan-out smoke test past the same 15s
// deadline. One fork per runner is the root-cause fix rather than a third
// timeout bump: each process-heavy file gets the whole runner while it runs.
const ci = !!process.env.CI;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/setup/build-once.ts"],
    ...(ci ? { poolOptions: { forks: { minForks: 1, maxForks: 1 } } } : {}),
  },
});
