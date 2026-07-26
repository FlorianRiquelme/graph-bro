import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { EventRow } from "../store/trace.js";

/**
 * R8/KTD-8: the fail-closed backstop for the class of tamper the sandbox
 * cannot close. A write node is granted bare `Bash`, and the sandbox permits
 * writes anywhere under the workspace — `echo '{"hooks":...}' >
 * .claude/settings.local.json` is unimpeded, and the deny rule that closes
 * this for the file-editing tools does not bind Bash. Every node shares one
 * workspace and each node is a fresh process with cwd set to it, so a
 * planted project-scope settings file is read at the *next* node's startup;
 * a read-only node picking it up is worse, since it runs with the engine's
 * full inherited environment. This module cannot prevent the write (that is
 * the sandbox-scope narrowing KTD-8 defers); it only guarantees the run
 * cannot proceed past an attempt boundary or terminal path once one has
 * landed.
 *
 * Deliberately does not import anything from `src/engine` (KTD-10): this is
 * runtime-owned, called from `src/runtime/run.ts`.
 */

/**
 * The CLI-configuration surface tracked relative to the workspace root —
 * every path a node's own startup, or the next node's, reads project-scope
 * config from. U3/U1-probe: narrowed from a blanket `.claude` (its full
 * recursive tree) to just the real startup surface, live-probed against
 * `claude` 2.1.220 — a real run unconditionally creates
 * `.claude/.cc-writes/` (empty scratch, CLI-owned, present in both the
 * read-only and write arms) which a recursive `.claude` hash would trip on
 * every single run. `.claude/hooks` is a directory, handled by
 * `hashConfigPath`'s existing directory branch below.
 */
const CONFIG_SURFACE_PATHS = [".claude/settings.json", ".claude/settings.local.json", ".claude/hooks", ".mcp.json", "CLAUDE.md"];

export interface WorkspaceIntegrityManifest {
  /** Relative path -> sha256 content hash, or `null` when the path is absent. A directory entry (`.claude/hooks`) hashes its full recursive tree, not just its own presence, since a node can add a file under an already-present directory. */
  configHashes: Record<string, string | null>;
  /**
   * The gitlink file's (`<workspace>/.git`) recorded `gitdir: <path>` target,
   * read directly rather than via any git invocation against the
   * workspace — reading the pointer file is exactly the thing being
   * checked, whereas running git *from* the workspace is what `commit.ts`'s
   * `resolveWorkspaceGitTarget`/`runWorkspaceGit` exist to avoid trusting.
   */
  gitlinkTarget: string | null;
}

/** Deterministic content hash of every file under `dirPath`, keyed by its path relative to `baseDir` — order-independent (sorted) so two directories with the same content in a different read order hash identically. */
function hashDirectory(dirPath: string, baseDir: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dirPath);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(baseDir, file));
    hash.update("\0");
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

function hashConfigPath(workspacePath: string, relPath: string): string | null {
  const fullPath = join(workspacePath, relPath);
  if (!existsSync(fullPath)) return null;
  const stat = statSync(fullPath);
  return stat.isDirectory() ? hashDirectory(fullPath, fullPath) : createHash("sha256").update(readFileSync(fullPath)).digest("hex");
}

/** `null` when `.git` is a real directory (an unlinked repo, not a linked worktree) rather than the gitlink pointer file every graph-bro workspace is created as. */
function readGitlinkTarget(workspacePath: string): string | null {
  const gitFile = join(workspacePath, ".git");
  if (!existsSync(gitFile) || statSync(gitFile).isDirectory()) return null;
  return readFileSync(gitFile, "utf8").trim();
}

/** Captures the manifest fresh from whatever the workspace holds right now — the `start`-time baseline, and the comparison point every later call re-derives to diff against a manifest captured earlier. */
export function captureWorkspaceIntegrityManifest(workspacePath: string): WorkspaceIntegrityManifest {
  const configHashes: Record<string, string | null> = {};
  for (const relPath of CONFIG_SURFACE_PATHS) configHashes[relPath] = hashConfigPath(workspacePath, relPath);
  return { configHashes, gitlinkTarget: readGitlinkTarget(workspacePath) };
}

export class WorkspaceIntegrityViolationError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly details: string,
  ) {
    super(`node '${nodeId}' changed the workspace's CLI-configuration surface or gitlink since creation (R8 backstop):\n${details}`);
    this.name = "WorkspaceIntegrityViolationError";
  }
}

/**
 * Raises `WorkspaceIntegrityViolationError` naming `nodeId` if the
 * workspace's CLI-configuration surface or gitlink has diverged from
 * `manifest` — captured once, at workspace creation, and never re-derived
 * mid-run. Reports the two classes (config surface vs. gitlink) as distinct
 * violation lines rather than one combined message, so a gitlink rewrite is
 * never mistaken for a planted `.claude` file or vice versa.
 */
export function assertWorkspaceIntegrity(workspacePath: string, manifest: WorkspaceIntegrityManifest, nodeId: string): void {
  const current = captureWorkspaceIntegrityManifest(workspacePath);
  const violations: string[] = [];
  for (const relPath of CONFIG_SURFACE_PATHS) {
    if (current.configHashes[relPath] !== manifest.configHashes[relPath]) {
      violations.push(`CLI-configuration surface changed: '${relPath}' (was ${manifest.configHashes[relPath] ?? "absent"}, now ${current.configHashes[relPath] ?? "absent"})`);
    }
  }
  if (current.gitlinkTarget !== manifest.gitlinkTarget) {
    violations.push(`gitlink target changed: was '${manifest.gitlinkTarget ?? "absent"}', now '${current.gitlinkTarget ?? "absent"}'`);
  }
  if (violations.length > 0) {
    throw new WorkspaceIntegrityViolationError(nodeId, violations.join("\n"));
  }
}

/** The trace payload `type` a recorded manifest event carries — matched by `findRecordedManifest`, written by the runtime alongside every other `appendEvent` call it makes. */
export const WORKSPACE_INTEGRITY_MANIFEST_EVENT_TYPE = "workspace_integrity_manifest";

/**
 * Reads the manifest back out of the run's own trace rather than
 * re-capturing it — `resume` calls `reuseWorkspace`, not `createWorkspace`,
 * so re-capturing at resume would baseline a workspace that may already be
 * compromised and the assertion would pass forever after. The trace is
 * already the run's durable record (KTD-8), so this needs no new column and
 * no fourth migration. Returns the *first* matching event: a run resumed
 * more than once still compares against the manifest from its original
 * creation, never one from an intermediate resume (which never records one).
 */
export function findRecordedManifest(events: EventRow[]): WorkspaceIntegrityManifest | undefined {
  for (const event of events) {
    const payload = event.payload as { type?: string; manifest?: WorkspaceIntegrityManifest } | undefined;
    if (payload?.type === WORKSPACE_INTEGRITY_MANIFEST_EVENT_TYPE && payload.manifest) return payload.manifest;
  }
  return undefined;
}
