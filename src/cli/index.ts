#!/usr/bin/env node
import { startCommand } from "./start.js";
import { statusCommand } from "./status.js";
import { tailCommand } from "./tail.js";
import { resultCommand } from "./result.js";
import { resumeCommand } from "./resume.js";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "start":
      await startCommand(rest);
      break;
    case "status":
      await statusCommand(rest);
      break;
    case "tail":
      await tailCommand(rest);
      break;
    case "result":
      await resultCommand(rest);
      break;
    case "resume":
      await resumeCommand(rest);
      break;
    default:
      console.error("usage: graph-bro <start|status|tail|result|resume> ...");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
