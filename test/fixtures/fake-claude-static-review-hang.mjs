#!/usr/bin/env node
// U5's dedicated fake CLI for a bounded node whose attempt commits nothing:
// unlike fake-claude-fix-review.mjs's write half (whose content is
// counter-suffixed so it always differs), this write half writes the exact
// same static content every single time — so the workspace holds no diff
// between one activation of `review` (the bounded node) and the next, and
// `commitAttempt` returns `committed: false` on the attempt boundary that
// review's second entry fires. The review half counts its own invocations
// and hangs indefinitely (never emits a "result") on
// FAKE_CLAUDE_HANG_ON_ATTEMPT, standing in for "review is still working" so
// a test can SIGKILL the engine right after that attempt's boundary commit
// has already landed but before review itself ever completes — the review
// half otherwise behaves exactly like fake-claude-fix-review.mjs's.
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
    if (write) writeFileSync(join(process.cwd(), write.path), write.content); // same bytes every attempt
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

  const counterPath = join(process.env.FAKE_CLAUDE_COUNTER_DIR ?? tmpdir(), "fake-claude-review-count");
  let count = 0;
  try {
    count = Number(readFileSync(counterPath, "utf8"));
  } catch {
    // No counter yet — this is the first review.
  }
  count += 1;
  writeFileSync(counterPath, String(count));

  const hangOnAttempt = Number(process.env.FAKE_CLAUDE_HANG_ON_ATTEMPT ?? "0");
  if (count === hangOnAttempt) {
    await sleep(60_000); // "still working" — never emits a result; the test kills the engine while this is in flight.
    return;
  }

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
