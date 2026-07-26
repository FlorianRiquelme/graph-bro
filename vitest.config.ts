import { defineConfig } from "vitest/config";

// GitHub Actions runners have far fewer cores than a dev machine. The
// process-heavy CLI/integration/smoke suites each spawn a detached engine plus
// a per-fan-out-branch agent subprocess; letting vitest fan test files across
// every core on a small runner oversubscribes the CPU and starves those
// detached process trees past their status-poll deadlines — the #4 flake that
// two prior smoke-test timeout bumps (5s→15s) never cured. Cap the fork pool on
// CI so the spawned processes get scheduling headroom; leave local dev (many
// cores, no starvation) unconstrained.
const ci = !!process.env.CI;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/setup/build-once.ts"],
    setupFiles: ["test/setup/hermetic-git.ts"],
    ...(ci ? { poolOptions: { forks: { minForks: 1, maxForks: 2 } } } : {}),
  },
});
