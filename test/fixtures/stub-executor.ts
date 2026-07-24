import type { Executor, RunOptions, RunResult } from "../../src/executor/executor.js";

export interface StubExecutorCall {
  prompt: string;
  options: RunOptions;
}

export type StubResponder = (prompt: string, options: RunOptions) => RunResult | Promise<RunResult>;

const DEFAULT_RESULT: RunResult = { text: "stub-response", isError: false, cost: 0, durationMs: 0 };

/**
 * Deterministic `Executor` test double (no subprocess, no LLM cost) for other
 * units'/this unit's tests. Configure with a queue of canned results (FIFO,
 * `enqueue`) or a `responder` function for conditional behavior; falls back
 * to `DEFAULT_RESULT` once the queue is empty. Records every call for
 * assertions.
 */
export class StubExecutor implements Executor {
  readonly calls: StubExecutorCall[] = [];
  private readonly queue: RunResult[] = [];

  constructor(private readonly responder?: StubResponder) {}

  enqueue(result: RunResult): void {
    this.queue.push(result);
  }

  async run(prompt: string, options: RunOptions): Promise<RunResult> {
    this.calls.push({ prompt, options });
    if (this.responder) return this.responder(prompt, options);
    return this.queue.shift() ?? DEFAULT_RESULT;
  }
}
