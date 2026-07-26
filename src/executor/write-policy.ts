import { execFileSync } from "node:child_process";

/**
 * KTD-3: the CLI's Bash-tool sandbox is what gives layers 2 and 3 any force
 * against shell egress, and it only exists on macOS (Seatbelt) and
 * Linux/WSL2 (bubblewrap + socat) — never native Windows. Checked without
 * spawning the CLI at all, so a write run can refuse to start before any
 * node dispatches, rather than discovering the gap mid-run.
 */
export interface OsBoundaryCheck {
  available: boolean;
  reason?: string;
}

function commandExists(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function checkOsBoundary(platform: NodeJS.Platform = process.platform): OsBoundaryCheck {
  if (platform === "darwin") return { available: true };
  if (platform === "linux") {
    const missing = ["bwrap", "socat"].filter((cmd) => !commandExists(cmd));
    if (missing.length === 0) return { available: true };
    return {
      available: false,
      reason: `OS sandbox unavailable: missing ${missing.join(", ")} (bubblewrap and socat are required for Bash-tool sandboxing on Linux/WSL2)`,
    };
  }
  return {
    available: false,
    reason: `OS sandbox unavailable on platform '${platform}': write nodes require macOS, Linux, or WSL2`,
  };
}

/**
 * KTD-3 layer 2: the file tools (Edit/Write/NotebookEdit) confined to the
 * workspace via a single path-scoped `Edit` rule — `Edit(path)` is what the
 * CLI's own permission checks match for every built-in file-writing tool,
 * not a per-tool-name rule. A single leading slash anchors the pattern to
 * the session's cwd, which is the (canonicalised) workspace root, so `/**`
 * covers the whole workspace and nothing outside it. A bare tool name
 * (`Edit`) carries no path scope at all — that is the exact defect an
 * earlier version of this design was falsified by probe over (KTD-3).
 */
const WRITE_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash", "Edit(/**)"] as const;

/**
 * KTD-3 layer 3: deny rules bind in every permission mode, which is why this
 * layer holds regardless of layer 1's mode choice. `Edit(/.claude/**)` closes
 * AE13 — the workspace is agent-writable by design and the CLI merges
 * configuration from the working directory during a live session, so without
 * this an agent could install its own out-of-sandbox hook. `WebFetch` and
 * `WebSearch` close the non-Bash network path R11 would otherwise leave open.
 */
const WRITE_DENIED_TOOLS = ["Edit(/.claude/**)", "WebFetch", "WebSearch"] as const;

/**
 * KTD-4: the subprocess gets a synthesized minimal environment, not the
 * engine's own — an opt-in allowlist rather than opt-out, so a secret
 * sitting in the engine's environment never reaches a write node. This list
 * is only what the CLI and its own subprocesses (git, node, shell) need to
 * run and authenticate via the operator's existing login.
 */
const PRESERVED_ENV_KEYS = ["PATH", "HOME", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TERM"] as const;

export function minimalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PRESERVED_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface WritePolicy {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * KTD-3's five layers, synthesized per write-node invocation:
 *   1. `--permission-mode dontAsk` — anything not explicitly allowed is
 *      refused without blocking the run (a probe confirmed a denied call
 *      does not abort a headless run).
 *   2/3. path-scoped allow rule plus the CLI-config/web-tool deny rules above.
 *   4. the OS sandbox, scoped to the workspace by default (the sandboxed
 *      Bash tool's default filesystem write scope is the cwd and its
 *      subdirectories, which is exactly the workspace here) plus the
 *      topology-declared network domains.
 *   5. `--strict-mcp-config` with no `--mcp-config` supplied, so zero MCP
 *      servers load regardless of what the operator's own machine declares.
 *
 * `canonicalWorkspacePath` must already be resolved through any symlinks —
 * this function does no filesystem I/O itself so it stays a pure, cheaply
 * testable unit; canonicalisation happens once at the call site, alongside
 * the cwd actually handed to the spawned process (a symlinked ancestor
 * would otherwise make every scope below silently match nothing).
 */
export function buildWritePolicy(canonicalWorkspacePath: string, networkDomains: string[] = []): WritePolicy {
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      // The sandboxed Bash tool already defaults its write scope to the cwd
      // and its subdirectories; this is stated explicitly rather than relied
      // on implicitly, anchored to the canonicalised path so a symlinked
      // ancestor can't make it silently diverge from what cwd resolves to.
      filesystem: { allowWrite: [canonicalWorkspacePath] },
      network: { allowedDomains: networkDomains },
    },
  };
  return {
    argv: [
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      WRITE_ALLOWED_TOOLS.join(" "),
      "--disallowedTools",
      WRITE_DENIED_TOOLS.join(" "),
      "--settings",
      JSON.stringify(settings),
      "--strict-mcp-config",
    ],
    env: minimalEnv(),
  };
}
