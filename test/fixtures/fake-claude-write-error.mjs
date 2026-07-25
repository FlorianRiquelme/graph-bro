#!/usr/bin/env node
// U7's fixture for "the write landed but the agent itself failed": writes the
// prompt's declared file (so the terminal path has something dirty to fold
// into a teardown commit) then reports `is_error: true` with a non-zero
// exit — the write-node counterpart of fake-claude.mjs's "error" mode, which
// carries no file write at all. Exercises the terminal path's genuine
// `failed` LoopResult (not a thrown exception) alongside a real, uncommitted
// filesystem change.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  emit({ type: "system", subtype: "init" });
  const promptIndex = process.argv.indexOf("-p");
  const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : "{}";
  const { write } = JSON.parse(prompt);
  if (write) writeFileSync(join(process.cwd(), write.path), write.content);
  await sleep(15);
  emit({
    type: "result",
    subtype: "error",
    is_error: true,
    result: "simulated write-node failure",
    num_turns: 1,
    duration_ms: 30,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  process.exit(1);
}

main();
