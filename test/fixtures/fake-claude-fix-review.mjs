#!/usr/bin/env node
// U7's dedicated fake CLI for a fix/review loop: one script serving both
// halves of the topology, distinguished by capability — a write invocation
// carries U6's `--strict-mcp-config`, a read-only one doesn't — rather than
// by FAKE_CLAUDE_MODE, which a write node's stripped environment (KTD-4)
// does not preserve. The write half writes the topology's own prompt (as
// fake-claude-write.mjs does); the review half's environment is untouched
// (read-only nodes keep full inheritance), so FAKE_CLAUDE_PASS_ON_ATTEMPT
// still reaches it — its structured verdict flips from "fail" to "pass"
// once a file-backed counter reaches that value, simulating a
// self-correcting loop that takes more than one attempt to converge.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  emit({ type: "system", subtype: "init" });
  const isWriteInvocation = process.argv.includes("--strict-mcp-config");

  if (isWriteInvocation) {
    const promptIndex = process.argv.indexOf("-p");
    const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : "{}";
    const { write } = JSON.parse(prompt);
    if (write) {
      // A distinct counter from review's — content must differ each
      // attempt, or re-writing identical bytes leaves nothing for the next
      // attempt's commit to fold in (no diff at all).
      const writerCounterPath = join(process.cwd(), ".fake-claude-writer-count");
      let writerCount = 0;
      try {
        writerCount = Number(readFileSync(writerCounterPath, "utf8"));
      } catch {
        // First write.
      }
      writerCount += 1;
      writeFileSync(writerCounterPath, String(writerCount));
      writeFileSync(join(process.cwd(), write.path), `${write.content}-${writerCount}`);
    }
    await sleep(15);
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "wrote it",
      num_turns: 1,
      duration_ms: 30,
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    process.exit(0);
    return;
  }

  // Outside the workspace, unlike the writer's counter above: a read-only
  // node must not touch cwd at all, or the KTD-10 backstop (correctly)
  // fails the run for a mutation review was never allowed to make.
  const counterPath = join(process.env.FAKE_CLAUDE_COUNTER_DIR ?? tmpdir(), "fake-claude-review-count");
  let count = 0;
  try {
    count = Number(readFileSync(counterPath, "utf8"));
  } catch {
    // No counter yet — this is the first review.
  }
  count += 1;
  writeFileSync(counterPath, String(count));
  const passOnAttempt = Number(process.env.FAKE_CLAUDE_PASS_ON_ATTEMPT ?? "1");
  const parsed = { verdict: count >= passOnAttempt ? "pass" : "fail" };
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
}

main();
