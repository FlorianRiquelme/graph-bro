import { describe, expect, it } from "vitest";
import { buildWritePolicy, checkOsBoundary, minimalEnv } from "../../src/executor/write-policy.js";

describe("executor: write-policy — checkOsBoundary (KTD-3)", () => {
  it("is available on darwin (Seatbelt ships with the OS)", () => {
    expect(checkOsBoundary("darwin")).toEqual({ available: true });
  });

  it("is unavailable on win32, naming the reason", () => {
    const result = checkOsBoundary("win32");
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/win32/);
    expect(result.reason).toMatch(/macOS, Linux, or WSL2/);
  });

  it("on linux, availability depends on bubblewrap and socat being on PATH", () => {
    // Doesn't assert a specific outcome (depends on the CI/dev machine's own
    // packages) — just that the check runs and reports consistently with reality.
    const result = checkOsBoundary("linux");
    expect(typeof result.available).toBe("boolean");
    if (!result.available) {
      expect(result.reason).toMatch(/bubblewrap|socat/);
    }
  });
});

describe("executor: write-policy — buildWritePolicy (KTD-3's five layers)", () => {
  it("layer 1: dontAsk permission mode", () => {
    const policy = buildWritePolicy("/workspace/run-a");
    expect(policy.argv).toContain("--permission-mode");
    expect(policy.argv[policy.argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });

  it("layer 2: the file-tool allow rule is path-scoped to the workspace, not a bare tool name", () => {
    const policy = buildWritePolicy("/workspace/run-a");
    const allowlist = policy.argv[policy.argv.indexOf("--allowedTools") + 1];
    expect(allowlist).toContain("Edit(/**)");
    expect(allowlist).toContain("Read");
    expect(allowlist).toContain("Bash");
    // The exact defect the earlier design was falsified by probe over: a bare
    // "Edit" token (no path scope) must never appear on its own.
    expect(allowlist.split(" ")).not.toContain("Edit");
  });

  it("layer 3: CLI-config paths and the built-in web tools are denied regardless of mode", () => {
    const policy = buildWritePolicy("/workspace/run-a");
    const denylist = policy.argv[policy.argv.indexOf("--disallowedTools") + 1];
    expect(denylist).toContain("Edit(/.claude/**)");
    expect(denylist).toContain("WebFetch");
    expect(denylist).toContain("WebSearch");
  });

  it("layer 4: sandbox settings declare enabled/failIfUnavailable and the canonical workspace as the write scope", () => {
    const policy = buildWritePolicy("/canonical/workspace/run-a", ["github.com"]);
    const settingsArg = policy.argv[policy.argv.indexOf("--settings") + 1];
    const settings = JSON.parse(settingsArg);
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.filesystem.allowWrite).toEqual(["/canonical/workspace/run-a"]);
    expect(settings.sandbox.network.allowedDomains).toEqual(["github.com"]);
  });

  it("layer 4: no declared domains means an empty allowlist, not omitted network config", () => {
    const policy = buildWritePolicy("/workspace/run-a");
    const settings = JSON.parse(policy.argv[policy.argv.indexOf("--settings") + 1]);
    expect(settings.sandbox.network.allowedDomains).toEqual([]);
  });

  it("layer 5: strict MCP config with no --mcp-config supplied, so zero servers load", () => {
    const policy = buildWritePolicy("/workspace/run-a");
    expect(policy.argv).toContain("--strict-mcp-config");
    expect(policy.argv).not.toContain("--mcp-config");
  });

  it("KTD-4: the environment is a minimal allowlist, not an inherited copy — nothing outside the preserved keys survives", () => {
    const allowlist = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TERM"]);
    const policy = buildWritePolicy("/workspace/run-a");
    for (const key of Object.keys(policy.env)) expect(allowlist.has(key)).toBe(true);
  });
});

describe("executor: write-policy — minimalEnv (KTD-4)", () => {
  it("keeps only the preserved keys, dropping everything else including secrets", () => {
    const env = minimalEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      SECRET_API_KEY: "sk-super-secret",
      ANTHROPIC_API_KEY: "leaked-if-inherited",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.SECRET_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("omits a preserved key entirely when the source doesn't have it, rather than setting it to undefined", () => {
    const env = minimalEnv({ PATH: "/usr/bin" });
    expect("HOME" in env).toBe(false);
  });
});
