#!/usr/bin/env node
// U4's dedicated fake CLI for a fix/review loop whose write half plants a
// file anywhere under the workspace — including inside a not-yet-existing
// directory like `.claude/`, which `fake-claude-fix-review.mjs`'s write half
// cannot do (a bare `writeFileSync` there throws `ENOENT`). Otherwise
// identical in shape to `fake-claude-fix-review.mjs`: distinguished by
// capability (`--strict-mcp-config` marks a write invocation), not by
// `FAKE_CLAUDE_MODE`, which a write node's stripped environment (KTD-4)
// doesn't preserve.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
      const target = join(process.cwd(), write.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, write.content);
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
