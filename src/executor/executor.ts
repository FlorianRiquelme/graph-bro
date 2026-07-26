/**
 * The narrow executor seam (KTD-11): one interface, one real backend (Claude
 * Code, `claude-code.ts`) plus a deterministic stub for tests
 * (`test/fixtures/stub-executor.ts`). A second backend slots in later without
 * touching the engine core (ADR-0010).
 */

/** Token accounting for one node run (ADR-0009 cost capture). */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/** KTD-12: named capability discriminant, replacing the old `readOnly` boolean now that write nodes get their own enforcement (U6) rather than just the absence of one. */
export type NodeCapability = "read_only" | "write";

export interface RunOptions {
  cwd: string;
  /** The topology node id this run belongs to — attributes the KTD-10 read-only backstop's failure. */
  nodeId: string;
  capability: NodeCapability;
  model: string;
  /** Hard wall-clock timeout in ms; also the heartbeat hard-kill threshold. */
  timeout: number;
  /** Streaming callback: every parsed NDJSON event, plus synthetic `heartbeat` events. */
  onEvent?: (event: unknown) => void;
  /** KTD-8: a JSON Schema an agent node declares for its response, forwarded to the backend as a structured-output contract. */
  outputSchema?: Record<string, unknown>;
  /** KTD-3 layer 4/KTD-12: topology-declared domains a write node's Bash-tool network egress may reach; empty or undefined means none (R11). Ignored for a read-only node. */
  networkDomains?: string[];
  /**
   * R6/KTD-6/KTD-7: the consumer repo the workspace at `cwd` belongs to, so the
   * read-only backstop's own `git status` can be pinned the same way every
   * other engine git call is. Without it that call discovers its repository by
   * walking up from `cwd` — inside the agent-writable workspace — which both
   * honours a rewritten gitlink (pointing the cleanliness check at a
   * substitute repo that always looks clean) and honours `core.fsmonitor`,
   * which git *executes*. Optional so a unit test can construct a run against
   * a plain directory that is not a linked worktree of anything.
   */
  consumerRepoPath?: string;
}

export interface RunResult {
  text: string;
  isError: boolean;
  cost?: number;
  tokens?: TokenUsage;
  durationMs?: number;
  /** KTD-2: the parsed structured value — present only when the node declared an `outputSchema` and the backend returned one. */
  structuredOutput?: unknown;
}

export interface Executor {
  run(prompt: string, options: RunOptions): Promise<RunResult>;
}

/**
 * KTD-13: a spawned node's PID/PGID registers here on spawn and deregisters
 * on completion, so a run-level kill (installed by U6's runtime) can cascade
 * to every in-flight node process group, not only the per-node timeout path.
 */
export interface NodeRegistryEntry {
  pid: number;
  pgid: number;
}

export interface NodeRegistry {
  register(entry: NodeRegistryEntry): void;
  deregister(pid: number): void;
}

/** Simple in-memory `NodeRegistry` — sufficient for this unit; U6 wires the signal handler that consumes it. */
export class InMemoryNodeRegistry implements NodeRegistry {
  private readonly entries = new Map<number, NodeRegistryEntry>();

  register(entry: NodeRegistryEntry): void {
    this.entries.set(entry.pid, entry);
  }

  deregister(pid: number): void {
    this.entries.delete(pid);
  }

  list(): NodeRegistryEntry[] {
    return [...this.entries.values()];
  }
}
