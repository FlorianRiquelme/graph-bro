import readline from "node:readline";
import type { Executor, NodeRegistry, RunOptions, RunResult, TokenUsage } from "./executor.js";
import { spawnDetached, killProcessGroup } from "./subprocess.js";
import { parseEnvelope, type ResultEnvelope } from "./envelope.js";
import { assertRepoClean, buildReadOnlyArgs } from "./read-only-policy.js";

/** The literal token a command template substitutes the prompt into, when present. */
export const PROMPT_TOKEN = "{prompt}";

/**
 * §13.4's compile-time prompt-delivery rule: if the command template
 * contains the literal `{prompt}` token, the prompt is substituted into argv
 * and stdin is closed; otherwise the whole prompt is piped on stdin and the
 * template gets no prompt argument.
 */
export function resolvePromptDelivery(
  commandTemplate: string[],
  prompt: string,
): { argv: string[]; stdin: string | null } {
  if (commandTemplate.includes(PROMPT_TOKEN)) {
    return { argv: commandTemplate.map((token) => (token === PROMPT_TOKEN ? prompt : token)), stdin: null };
  }
  return { argv: [...commandTemplate], stdin: prompt };
}

export interface ClaudeCodeOptions {
  /** Defaults to "claude"; overridable for tests (a scripted fake CLI, never a live one in this unit's tests). */
  binary?: string;
  /** Soft heartbeat threshold in ms — silence past this emits a `heartbeat` trace event without killing. */
  heartbeatSoftMs?: number;
  /** How often the heartbeat/timeout watchdog polls, in ms. */
  heartbeatPollMs?: number;
  /** Grace period between SIGTERM and SIGKILL on group-kill. */
  killGraceMs?: number;
  /** KTD-13: registers this node's PID/PGID on spawn, deregisters on completion. */
  registry?: NodeRegistry;
}

function extractTokens(envelope: ResultEnvelope): TokenUsage | undefined {
  const usage = envelope.usage as
    | { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
    | undefined;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
  };
}

/**
 * The one real `Executor` backend (ADR-0010): spawns `claude -p` detached in
 * its own process group, streams NDJSON over stdout, and honors the terminal
 * `type === "result"` envelope's `is_error` regardless of exit code (the
 * §13.4 non-zero-exit fix).
 */
export class ClaudeCodeExecutor implements Executor {
  constructor(private readonly opts: ClaudeCodeOptions = {}) {}

  async run(prompt: string, options: RunOptions): Promise<RunResult> {
    const binary = this.opts.binary ?? "claude";
    const heartbeatSoftMs = this.opts.heartbeatSoftMs ?? 15_000;
    const pollMs = this.opts.heartbeatPollMs ?? 250;

    // KTD-9/SDK #60: `--print --verbose --output-format stream-json` first, unconditionally.
    const template = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--model",
      options.model,
      ...(options.capability === "read_only" ? buildReadOnlyArgs() : []),
      // KTD-8: forwards the topology-declared output schema as the backend's
      // structured-output contract; the response's parsed value comes back
      // on the envelope's `structured_output` field (see envelope.ts).
      ...(options.outputSchema ? ["--json-schema", JSON.stringify(options.outputSchema)] : []),
      "-p",
      PROMPT_TOKEN,
    ];
    const { argv, stdin } = resolvePromptDelivery(template, prompt);

    const spawned = spawnDetached(binary, argv, {
      cwd: options.cwd,
      stdinMode: stdin === null ? "closed" : "piped",
    });
    this.opts.registry?.register({ pid: spawned.pid, pgid: spawned.pgid });

    if (stdin !== null) {
      spawned.child.stdin?.write(stdin);
      spawned.child.stdin?.end();
    }

    let lastLineAt = Date.now();
    let terminalEnvelope: ResultEnvelope | undefined;
    let timedOut = false;

    const rl = readline.createInterface({ input: spawned.child.stdout! });
    rl.on("line", (raw) => {
      lastLineAt = Date.now();
      const line = raw.trim();
      if (!line) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return; // tolerate stray non-JSON lines (§13.4)
      }
      options.onEvent?.(event);
      if (typeof event === "object" && event !== null && (event as { type?: unknown }).type === "result") {
        try {
          terminalEnvelope = parseEnvelope(event);
        } catch (err) {
          // A malformed terminal envelope must fail only this node, never
          // crash the whole engine process — an uncaught throw here would
          // propagate out of the readline 'line' event and take down every
          // other in-flight node in the run. Leave terminalEnvelope unset;
          // the existing "no terminal event before EOF" fallback below
          // already reports this as a synthetic isError result.
          options.onEvent?.({ type: "envelope_parse_error", error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    const startedAt = Date.now();
    const heartbeatTimer = setInterval(() => {
      const idleMs = Date.now() - lastLineAt;
      if (idleMs >= options.timeout) {
        if (!timedOut) {
          timedOut = true;
          options.onEvent?.({ type: "heartbeat", level: "hard", idleMs, pid: spawned.pid });
          void killProcessGroup(spawned.pgid, spawned.child, this.opts.killGraceMs);
        }
      } else if (idleMs >= heartbeatSoftMs) {
        options.onEvent?.({ type: "heartbeat", level: "soft", idleMs, pid: spawned.pid });
      }
    }, pollMs);

    try {
      await new Promise<void>((resolve, reject) => {
        spawned.child.once("exit", () => resolve());
        spawned.child.once("error", (err) => reject(err));
      });
    } finally {
      clearInterval(heartbeatTimer);
      rl.close();
      this.opts.registry?.deregister(spawned.pid);
      // §14.7: always group-kill in `finally`, even on the success path — reaps any child the CLI itself leaked.
      await killProcessGroup(spawned.pgid, spawned.child, this.opts.killGraceMs);
    }

    // KTD-10 backstop: per read-only node completion (not once after a whole fan-out
    // drains), so a permission-policy gap is attributed to the offending node. Folded
    // into the shared `run()` path rather than left for callers to remember.
    if (options.capability === "read_only") assertRepoClean(options.cwd, options.nodeId);

    if (terminalEnvelope) {
      return {
        text: terminalEnvelope.result,
        isError: terminalEnvelope.is_error,
        cost: terminalEnvelope.total_cost_usd,
        tokens: extractTokens(terminalEnvelope),
        durationMs: terminalEnvelope.duration_ms,
        structuredOutput: terminalEnvelope.structured_output,
      };
    }
    // Process exited with no terminal event before EOF — a real hang (hard-killed) or an
    // unexpected early exit either way; report a synthetic error rather than throw.
    return { text: "", isError: true, durationMs: Date.now() - startedAt };
  }
}
