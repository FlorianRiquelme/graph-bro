import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compile } from "../../src/topology/compile.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
const FAKE_CLAUDE = join(REPO_ROOT, "test", "fixtures", "fake-claude.mjs");
const EXAMPLE_TOPOLOGY_PATH = join(REPO_ROOT, "examples", "fanout-read-join", "topology.json");

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "graph-bro-smoke-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

function runCliSync(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf-8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 100): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

describe("smoke: the shipped fanout-read-join example graph", () => {
  let home: string;
  let cwd: string;

  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  }, 30_000);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "graph-bro-smoke-home-"));
    cwd = gitRepo();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("the reader node declares read_only: true and a cheap model", () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_TOPOLOGY_PATH, "utf-8"));
    const reader = raw.nodes.find((node: { id: string }) => node.id === "reader");
    expect(reader).toMatchObject({
      kind: "agent",
      read_only: true,
      model: "claude-haiku-4-5",
    });
  });

  it("Covers R13: the example topology validates via compile()", () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_TOPOLOGY_PATH, "utf-8"));
    const result = compile(raw);
    expect(result.ok).toBe(true);
  });

  it(
    "Covers R13: runs end-to-end via the CLI to completion, and the dedup join collapses duplicate reader outputs",
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GRAPH_BRO_HOME: home,
        GRAPH_BRO_CLAUDE_BINARY: FAKE_CLAUDE,
        FAKE_CLAUDE_MODE: "success",
      };

      const start = runCliSync(["start", EXAMPLE_TOPOLOGY_PATH], { cwd, env });
      expect(start.status).toBe(0);
      const runId = start.stdout.trim();
      expect(runId).toMatch(/[0-9a-f-]{36}/);

      await waitFor(() => {
        const status = runCliSync(["status", runId], { cwd, env });
        return JSON.parse(status.stdout).status === "completed";
      }, 5000);

      const result = runCliSync(["result", runId], { cwd, env });
      const output = JSON.parse(result.stdout);
      expect(output.status).toBe("completed");

      // The fake CLI answers the same "pong" text for every one of the 3
      // fan-out branches (one per `batch.items` entry) regardless of prompt,
      // so the dedup join must collapse all 3 duplicate outputs to one.
      expect(output.output.results).toEqual(["pong"]);
    },
    10_000,
  );
});
