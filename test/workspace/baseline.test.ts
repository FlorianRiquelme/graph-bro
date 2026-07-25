import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsumerBaselineViolationError, assertConsumerBaseline, captureConsumerBaseline } from "../../src/workspace/baseline.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function consumerRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "graph-bro-baseline-consumer-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "committed.txt"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

describe("workspace/baseline: assertConsumerBaseline (R12/R16/R17 backstop, KTD-11)", () => {
  let consumer: string;

  beforeEach(() => {
    consumer = consumerRepo();
  });

  afterEach(() => {
    rmSync(consumer, { recursive: true, force: true });
  });

  it("passes when nothing changed since the baseline", () => {
    const baseline = captureConsumerBaseline(consumer);
    expect(() => assertConsumerBaseline(consumer, baseline, "reader")).not.toThrow();
  });

  it("Covers AE7/R12: passes when the consumer was already dirty at baseline capture and stays exactly that dirty", () => {
    writeFileSync(join(consumer, "already-dirty.txt"), "pre-existing\n");
    const baseline = captureConsumerBaseline(consumer);

    expect(() => assertConsumerBaseline(consumer, baseline, "reader")).not.toThrow();
  });

  it("Covers R12: names the offending node when a new untracked file appears", () => {
    const baseline = captureConsumerBaseline(consumer);
    writeFileSync(join(consumer, "escaped.txt"), "oops\n");

    try {
      assertConsumerBaseline(consumer, baseline, "writer-node");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConsumerBaselineViolationError);
      expect((err as ConsumerBaselineViolationError).nodeId).toBe("writer-node");
      expect((err as Error).message).toContain("writer-node");
    }
  });

  it("Covers R12: names the offending node when tracked file content changes", () => {
    const baseline = captureConsumerBaseline(consumer);
    writeFileSync(join(consumer, "committed.txt"), "mutated\n");

    expect(() => assertConsumerBaseline(consumer, baseline, "writer-node")).toThrow(ConsumerBaselineViolationError);
  });

  it("Covers R12: catches a further edit to a file that was already dirty at baseline (porcelain status line alone wouldn't change)", () => {
    writeFileSync(join(consumer, "committed.txt"), "first edit\n");
    const baseline = captureConsumerBaseline(consumer);
    writeFileSync(join(consumer, "committed.txt"), "second edit\n");

    expect(() => assertConsumerBaseline(consumer, baseline, "writer-node")).toThrow(ConsumerBaselineViolationError);
  });

  it("Covers AE14: names the offending node when a consumer ref other than a run branch moves", () => {
    git(consumer, ["branch", "some-other-branch"]);
    const baseline = captureConsumerBaseline(consumer);
    writeFileSync(join(consumer, "committed.txt"), "advance\n");
    git(consumer, ["add", "-A"]);
    git(consumer, ["commit", "-q", "-m", "second"]);
    git(consumer, ["branch", "-f", "some-other-branch"]);

    expect(() => assertConsumerBaseline(consumer, baseline, "writer-node")).toThrow(ConsumerBaselineViolationError);
  });

  it("Covers AE14: names the offending node when a consumer ref other than a run branch is deleted", () => {
    git(consumer, ["branch", "disposable"]);
    const baseline = captureConsumerBaseline(consumer);
    git(consumer, ["branch", "-D", "disposable"]);

    expect(() => assertConsumerBaseline(consumer, baseline, "writer-node")).toThrow(ConsumerBaselineViolationError);
  });

  it("a graph-bro run branch appearing does not trip the assertion — it is the run's own declared footprint, not a consumer ref", () => {
    const baseline = captureConsumerBaseline(consumer);
    git(consumer, ["branch", "graph-bro/run-some-run-id"]);

    expect(() => assertConsumerBaseline(consumer, baseline, "reader")).not.toThrow();
  });
});
