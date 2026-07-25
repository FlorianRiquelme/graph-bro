#!/usr/bin/env node
// Proves the executor keeps reading stdout past the node process's own `exit`.
//
// The real failure this guards is timing-dependent and only shows on a loaded
// machine: a CLI writes its terminal `result` envelope and exits, `exit` is
// delivered to the parent while the tail of that write is still unread in the
// pipe, and a parent that stops reading there loses the envelope — reporting a
// successful node as failed with exit code 0, no signal and no stderr. A plain
// write-then-exit fixture cannot reproduce that on a fast machine, which drains
// the pipe first, so it would pass with or without the fix and prove nothing.
//
// Instead this makes the same ordering deterministic: a detached grandchild
// inherits stdout and writes the envelope *after* this process is already gone.
// Reading only until `exit` therefore always misses it; reading until the
// stream itself ends always finds it. Same contract, no race.
import { spawn } from "node:child_process";

const envelope = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "written after the parent exited",
  total_cost_usd: 0.001,
  duration_ms: 1,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const child = spawn(
  process.execPath,
  ["-e", `setTimeout(() => { process.stdout.write(${JSON.stringify(`${envelope}\n`)}); }, 150);`],
  { detached: true, stdio: ["ignore", "inherit", "ignore"] },
);
child.unref();
