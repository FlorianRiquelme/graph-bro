#!/usr/bin/env node
// Scripted fake `claude`-shaped CLI for U4's real-subprocess tests (streaming,
// error-path, heartbeat, group-kill). Never invokes the real `claude` binary.
// Behavior is selected via FAKE_CLAUDE_MODE, not argv, so it tolerates
// whatever flags ClaudeCodeExecutor builds around it — except for a write
// invocation, whose environment is stripped to a minimal allowlist (KTD-4)
// that does not preserve FAKE_CLAUDE_MODE at all, so mode-based dispatch can
// never reach it. `isWriteInvocation` (U6's `--strict-mcp-config`, present
// only on a write node's argv) is checked first, before `mode` is read, so
// that one case doesn't have to fight the same env-loss every other mode
// is naturally immune to (they're all exercised via read-only nodes, whose
// environment is untouched).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
const isWriteInvocation = process.argv.includes("--strict-mcp-config");

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * U10: the write half of the review-fix-loop showcase's fix/review cycle —
 * the only write-capability behavior any test currently needs from this
 * shared fixture (everything else exercises write nodes via a dedicated,
 * single-purpose fixture script instead, which needs no capability check at
 * all). The invocation counter lives in `cwd` (the workspace) itself, not an
 * env-supplied path: a write node's stripped environment (KTD-4) loses any
 * custom env var, including one meant to point at a counter file, but a
 * write-capable node can always write into its own workspace — and since
 * every run gets a fresh workspace, the counter resets on its own with no
 * env dependency at all. It naturally gets folded into the attempt commit,
 * same as the fix's own real edit.
 */
async function runFixReviewWrite() {
  const counterPath = join(process.cwd(), ".fake-claude-fix-count");
  let count = 0;
  try {
    count = Number(readFileSync(counterPath, "utf8"));
  } catch {
    // First invocation.
  }
  count += 1;
  writeFileSync(counterPath, String(count));

  emit({ type: "system", subtype: "init" });
  writeFileSync(join(process.cwd(), "notes.txt"), `draft ${count}\n`);
  await sleep(15);
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "updated notes.txt",
    num_turns: 1,
    duration_ms: 30,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  process.exit(0);
}

async function main() {
  if (isWriteInvocation) {
    await runFixReviewWrite();
    return;
  }
  switch (mode) {
    case "success": {
      emit({ type: "system", subtype: "init", argv: process.argv.slice(2) });
      await sleep(15);
      emit({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
      await sleep(15);
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "pong",
        num_turns: 1,
        duration_ms: 30,
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      process.exit(0);
      break;
    }
    case "error": {
      // §13.4: a valid `is_error: true` envelope on stdout, but a non-zero exit.
      emit({ type: "system", subtype: "init" });
      emit({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "permission denied",
        num_turns: 1,
        duration_ms: 12,
        total_cost_usd: 0.0005,
        usage: { input_tokens: 8, output_tokens: 2 },
      });
      process.exit(1);
      break;
    }
    case "structured": {
      // KTD-2 shape: `result` stays a JSON string; `structured_output` carries
      // the parsed object alongside it. Nested, to prove it crosses the seam intact.
      emit({ type: "system", subtype: "init", argv: process.argv.slice(2) });
      await sleep(15);
      const parsed = { verdict: "pass", findings: [{ note: "looks good", nested: { depth: 2 } }] };
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify(parsed),
        structured_output: parsed,
        num_turns: 1,
        duration_ms: 30,
        total_cost_usd: 0.002,
        usage: { input_tokens: 12, output_tokens: 6 },
      });
      process.exit(0);
      break;
    }
    case "mutate-cwd": {
      // Simulates an allowlist gap: something slips through and mutates cwd
      // during the node's run (U6's rescoped read-only backstop must catch
      // this even though the baseline is captured before this process spawns).
      emit({ type: "system", subtype: "init" });
      writeFileSync(join(process.cwd(), "mutated-by-slipped-bash.txt"), "oops\n");
      await sleep(15);
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "pong",
        num_turns: 1,
        duration_ms: 30,
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      process.exit(0);
      break;
    }
    case "fix-review-loop": {
      // U10: the review (read-only) half of the review-fix-loop showcase's
      // fix/review cycle — the write half is `runFixReviewWrite` above,
      // reached before this switch since a write node's env can't carry
      // FAKE_CLAUDE_MODE. FAKE_CLAUDE_COUNTER_DIR (a path inside the test's
      // own temp home, never shared across concurrent tests) backs a small
      // invocation counter, so the verdict flips from "fail" to "pass" once
      // FAKE_CLAUDE_PASS_ON_ATTEMPT is reached, rather than converging on
      // the very first attempt.
      const counterDir = process.env.FAKE_CLAUDE_COUNTER_DIR ?? tmpdir();
      const counterPath = join(counterDir, "fake-claude-review-count");
      let count = 0;
      try {
        count = Number(readFileSync(counterPath, "utf8"));
      } catch {
        // First invocation.
      }
      count += 1;
      writeFileSync(counterPath, String(count));

      emit({ type: "system", subtype: "init" });
      const passOnAttempt = Number(process.env.FAKE_CLAUDE_PASS_ON_ATTEMPT ?? "2");
      const parsed =
        count >= passOnAttempt ? { verdict: "pass", notes: "looks complete" } : { verdict: "fail", notes: "needs the word done" };
      await sleep(15);
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify(parsed),
        structured_output: parsed,
        num_turns: 1,
        duration_ms: 30,
        total_cost_usd: 0.002,
        usage: { input_tokens: 12, output_tokens: 6 },
      });
      process.exit(0);
      break;
    }
    case "slow": {
      // Silent for FAKE_CLAUDE_SILENT_MS then completes — for the "soft heartbeat, not hard-killed" scenario.
      const silentMs = Number(process.env.FAKE_CLAUDE_SILENT_MS ?? "300");
      emit({ type: "system", subtype: "init" });
      await sleep(silentMs);
      emit({
        type: "result",
        is_error: false,
        result: "done",
        duration_ms: silentMs,
        total_cost_usd: 0,
        usage: {},
      });
      process.exit(0);
      break;
    }
    case "grandchild-resist": {
      // Parent and grandchild both ignore SIGTERM, to prove group-kill's SIGKILL escalation reaps both (§14.7).
      process.on("SIGTERM", () => {});
      const grandchild = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        { stdio: "ignore" },
      );
      emit({ type: "grandchild_pid", pid: grandchild.pid });
      setInterval(() => {}, 1000); // keep the parent alive too
      break;
    }
    default:
      throw new Error(`unknown FAKE_CLAUDE_MODE '${mode}'`);
  }
}

main();
