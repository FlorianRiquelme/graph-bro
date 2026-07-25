#!/usr/bin/env node
// U8's dedicated fake CLI for simulating a kill mid-attempt: the write half
// performs its filesystem write (as fake-claude-fix-review.mjs's write half
// does — a distinct counter so content differs each attempt) and then hangs
// indefinitely without ever emitting a "result" event, standing in for "the
// node is still working" so a test can SIGKILL the engine while the write is
// already on disk but not yet folded into any attempt commit. The review
// half behaves exactly like fake-claude-fix-review.mjs's, so a topology can
// switch to a normal-completing binary (fake-claude-fix-review.mjs) on
// resume without changing anything else about the run.
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
    await sleep(60_000); // "still working" — never emits a result; the test kills the engine while this is in flight. Bounded, not indefinite, so a test that fails to clean up doesn't orphan this forever.
    return;
  }

  const counterPath = join(process.env.FAKE_CLAUDE_COUNTER_DIR ?? tmpdir(), "fake-claude-review-count");
  let count = 0;
  try {
    count = Number(readFileSync(counterPath, "utf8"));
  } catch {
    // No counter yet.
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
