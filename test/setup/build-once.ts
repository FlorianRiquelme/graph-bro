import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Vitest `globalSetup`: runs `npm run build` exactly once, in the main
 * process, before any test file starts. Several subprocess-driven test files
 * (`cli/cli.test.ts`, `smoke/example-graph.test.ts`,
 * `integration/kill-reaping.test.ts`) exercise the built `dist/cli/index.js`
 * CLI and each used to run their own `beforeAll(() => npm run build)` — with
 * vitest's default parallel-file execution, 3+ concurrent `tsc` invocations
 * writing the same `dist/` output raced and produced flaky hangs. Centralizing
 * the build here removes the race.
 */
export default function setup(): void {
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
}
