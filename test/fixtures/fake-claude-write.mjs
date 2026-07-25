#!/usr/bin/env node
// U7's dedicated fake CLI for a single write node with no bounded node above
// it: unlike test/fixtures/fake-claude.mjs, this has no FAKE_CLAUDE_MODE
// switch, because a write node's environment is stripped to a minimal
// allowlist (KTD-4) that does not include test-harness env vars — the only
// channel that reliably reaches a write node is the prompt itself (argv),
// so this script's one behavior is unconditional: parse the topology's own
// prompt as `{"write":{"path":...,"content":...}}` and write it into cwd
// (the workspace), proving the attempt-commit boundary against a real
// filesystem write, not a scripted no-op.
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
    subtype: "success",
    is_error: false,
    result: "wrote it",
    num_turns: 1,
    duration_ms: 30,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  process.exit(0);
}

main();
