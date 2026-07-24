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

export interface RunOptions {
  cwd: string;
  /** The topology node id this run belongs to — attributes the KTD-10 read-only backstop's failure. */
  nodeId: string;
  readOnly: boolean;
  model: string;
  /** Hard wall-clock timeout in ms; also the heartbeat hard-kill threshold. */
  timeout: number;
  /** Streaming callback: every parsed NDJSON event, plus synthetic `heartbeat` events. */
  onEvent?: (event: unknown) => void;
}

export interface RunResult {
  text: string;
  isError: boolean;
  cost?: number;
  tokens?: TokenUsage;
  durationMs?: number;
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
