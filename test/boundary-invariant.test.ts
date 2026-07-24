import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The consumer name and consumer-domain terms, taken verbatim from
 * `CONTEXT.md`'s "Consumer" entry: graph-bro's slice-1 consumer/driver is
 * named "sensei", and its own workload is a "mining" workload (per the
 * plan's Goal Capsule). AE6: neither may appear in shipped src/ or examples/.
 */
const FORBIDDEN_TERMS = ["sensei", "mining"];

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

describe("boundary-invariant: no consumer name or consumer-domain term in shipped src/ or examples/", () => {
  it("Covers AE6: grep of shipped src/ + examples/ finds no consumer name or consumer-domain term", () => {
    const roots = [join(REPO_ROOT, "src"), join(REPO_ROOT, "examples")];
    const violations: { file: string; term: string }[] = [];

    for (const root of roots) {
      for (const file of listFiles(root)) {
        const contents = readFileSync(file, "utf-8").toLowerCase();
        for (const term of FORBIDDEN_TERMS) {
          if (contents.includes(term)) {
            violations.push({ file, term });
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
