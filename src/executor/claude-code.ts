import readline from "node:readline";
import { realpathSync } from "node:fs";
import type { Executor, NodeRegistry, RunOptions, RunResult, TokenUsage } from "./executor.js";
import { spawnDetached, killProcessGroup } from "./subprocess.js";
import { parseEnvelope, type ResultEnvelope } from "./envelope.js";
import { assertRepoClean, buildReadOnlyArgs, capturePorcelain } from "./read-only-policy.js";
import { buildWritePolicy } from "./write-policy.js";

/** The literal token a command template substitutes the prompt into, when present. */
export const PROMPT_TOKEN = "{prompt}";

/**
 * How long to keep reading stdout after the node process has exited, before
 * concluding the stream will never end. Only ever spent when a forked
 * grandchild inherited stdout and outlived its parent; an ordinary drain
 * completes in an event-loop turn.
 */
const STDOUT_DRAIN_GRACE_MS = 2000;

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

    // U6/KTD-3: a write node's cwd is canonicalised before it feeds any
    // scope or deny rule — a symlinked ancestor would otherwise make the
    // sandbox's cwd-scoped write access silently diverge from what the
    // synthesized settings declare.
    const cwd = options.capability === "write" ? realpathSync(options.cwd) : options.cwd;
    const writePolicy = options.capability === "write" ? buildWritePolicy(cwd, options.networkDomains ?? []) : undefined;
    // U6/KTD-7: the rescoped read-only backstop compares against a baseline
    // captured before this node ran, not against emptiness — every node now
    // shares one workspace, so a prior write node's uncommitted work must
    // not false-fail a read-only node that touched nothing.
    const baselinePorcelain = options.capability === "read_only" ? capturePorcelain(cwd) : undefined;

    // KTD-9/SDK #60: `--print --verbose --output-format stream-json` first, unconditionally.
    const template = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--model",
      options.model,
      ...(options.capability === "read_only" ? buildReadOnlyArgs() : []),
      ...(writePolicy?.argv ?? []),
      // KTD-8: forwards the topology-declared output schema as the backend's
      // structured-output contract; the response's parsed value comes back
      // on the envelope's `structured_output` field (see envelope.ts).
      ...(options.outputSchema ? ["--json-schema", JSON.stringify(options.outputSchema)] : []),
      "-p",
      PROMPT_TOKEN,
    ];
    const { argv, stdin } = resolvePromptDelivery(template, prompt);

    const spawned = spawnDetached(binary, argv, {
      cwd,
      stdinMode: stdin === null ? "closed" : "piped",
      env: writePolicy?.env,
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

    // Captured in the exit handler, not read off the child afterwards: the
    // `finally` below group-kills unconditionally, which can overwrite
    // `signalCode` and erase how the process actually ended.
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    try {
      // Waits for the process to exit AND its stdout to drain, not just the
      // former. `exit` fires when the process ends, while whatever it wrote
      // last can still be sitting unread in the pipe — so resolving on `exit`
      // alone and closing the reader (below) discards the terminal envelope
      // of any CLI that writes it and exits promptly. That loses a
      // *successful* node to a synthetic "no terminal envelope" error, and it
      // is load-dependent: invisible on a fast machine that drains the pipe
      // before `exit` is delivered, roughly a coin flip per node on a busy
      // CI runner.
      await new Promise<void>((resolve, reject) => {
        let exited = false;
        let drained = false;
        let drainTimer: NodeJS.Timeout | undefined;
        const settle = (): void => {
          if (!exited || !drained) return;
          if (drainTimer) clearTimeout(drainTimer);
          resolve();
        };
        // readline closes when its input stream ends — i.e. once every
        // buffered line has been emitted.
        rl.once("close", () => {
          drained = true;
          settle();
        });
        spawned.child.once("exit", (code, signal) => {
          exitCode = code;
          exitSignal = signal;
          exited = true;
          // Bounded, because stdout is inherited: a grandchild the CLI forked
          // and left running holds the pipe open indefinitely after the CLI
          // itself is gone. Draining a pipe takes an event-loop turn, so this
          // grace is never spent on a healthy node — only on that leak, where
          // giving up beats hanging the run.
          drainTimer ??= setTimeout(() => {
            drained = true;
            settle();
          }, STDOUT_DRAIN_GRACE_MS);
          settle();
        });
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
    if (options.capability === "read_only") assertRepoClean(cwd, options.nodeId, baselinePorcelain!);

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
    // The cause has to be spelled out here: this text is all the caller gets
    // (`runLoop` wraps it as "agent node '<id>' failed: <text>"), and an empty
    // string leaves an operator — or a CI log — with a failed run and no reason.
    const stderr = spawned.stderrTail().trim();
    const cause = timedOut
      ? `hard heartbeat timeout after ${options.timeout}ms of silence`
      : `exited without a terminal result envelope (exit code ${exitCode ?? "none"}, signal ${exitSignal ?? "none"})`;
    return {
      text: `node process ${cause}${stderr ? `; stderr tail: ${stderr}` : "; no stderr output"}`,
      isError: true,
      durationMs: Date.now() - startedAt,
    };
  }
}
