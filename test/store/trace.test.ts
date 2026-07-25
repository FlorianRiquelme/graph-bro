import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/store/db.js";
import { aggregateAttempts, appendEvent, listEvents } from "../../src/store/trace.js";

describe("store: trace", () => {
  let baseDir: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "graph-bro-trace-"));
    db = openDb({ baseDir });
  });

  afterEach(() => {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("append/read round-trips an events row", () => {
    appendEvent(db, { runId: "run-1", node: "reader", step: 1, payload: { hello: "world" } });

    const rows = listEvents(db, "run-1");

    expect(rows).toHaveLength(1);
    expect(rows[0].node).toBe("reader");
    expect(rows[0].payload).toEqual({ hello: "world" });
  });

  it("events row carries model/token/cost_usd/duration_ms columns (schema-level; population deferred to U4)", () => {
    appendEvent(db, {
      runId: "run-1",
      node: "reader",
      step: 1,
      model: "claude-haiku",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 5,
      durationMs: 1234,
      costUsd: 0.012,
    });

    const [row] = listEvents(db, "run-1");

    expect(row).toMatchObject({
      model: "claude-haiku",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 5,
      durationMs: 1234,
      costUsd: 0.012,
    });
  });

  it("lists events for a run in insertion order", () => {
    appendEvent(db, { runId: "run-1", node: "A", step: 1 });
    appendEvent(db, { runId: "run-1", node: "B", step: 2 });
    appendEvent(db, { runId: "run-2", node: "C", step: 1 });

    const rows = listEvents(db, "run-1");

    expect(rows.map((r) => r.node)).toEqual(["A", "B"]);
  });
});

describe("store: trace — aggregateAttempts (U9, R26)", () => {
  function nodeComplete(step: number, tokens: { inputTokens: number; outputTokens: number; costUsd: number }) {
    return {
      runId: "run-1",
      node: "writer",
      step,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      costUsd: tokens.costUsd,
      payload: { type: "node_complete" as const, update: {} },
    };
  }

  it("Covers R26: sums token usage and cost per attempt, across every node that ran as part of it", () => {
    const db = openDb({ baseDir: mkdtempSync(join(tmpdir(), "graph-bro-trace-agg-")) });
    try {
      appendEvent(db, nodeComplete(1, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }));
      appendEvent(db, { ...nodeComplete(1, { inputTokens: 20, outputTokens: 8, costUsd: 0.02 }), node: "review" });
      appendEvent(db, nodeComplete(2, { inputTokens: 15, outputTokens: 6, costUsd: 0.015 }));

      const summary = aggregateAttempts(listEvents(db, "run-1"));

      expect(summary).toEqual([
        { attempt: 1, inputTokens: 30, outputTokens: 13, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: expect.closeTo(0.03, 5) },
        { attempt: 2, inputTokens: 15, outputTokens: 6, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.015 },
      ]);
    } finally {
      db.close();
    }
  });

  it("a four-attempt run shows four attributions", () => {
    const db = openDb({ baseDir: mkdtempSync(join(tmpdir(), "graph-bro-trace-agg-")) });
    try {
      for (let attempt = 1; attempt <= 4; attempt++) {
        appendEvent(db, nodeComplete(attempt, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }));
      }

      const summary = aggregateAttempts(listEvents(db, "run-1"));

      expect(summary).toHaveLength(4);
      expect(summary.map((s) => s.attempt)).toEqual([1, 2, 3, 4]);
    } finally {
      db.close();
    }
  });

  it("ignores non-node_complete events (node_start, routing_decision, etc.)", () => {
    const db = openDb({ baseDir: mkdtempSync(join(tmpdir(), "graph-bro-trace-agg-")) });
    try {
      appendEvent(db, { runId: "run-1", node: "writer", step: 1, payload: { type: "node_start" } });
      appendEvent(db, nodeComplete(1, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }));
      appendEvent(db, { runId: "run-1", node: "review", step: 1, payload: { type: "routing_decision", to: "END" } });

      const summary = aggregateAttempts(listEvents(db, "run-1"));

      expect(summary).toEqual([{ attempt: 1, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.01 }]);
    } finally {
      db.close();
    }
  });

  it("a slice-1-shaped read-only run (no bounded node, every event stamped 0) yields no attempt aggregation at all", () => {
    const db = openDb({ baseDir: mkdtempSync(join(tmpdir(), "graph-bro-trace-agg-")) });
    try {
      appendEvent(db, nodeComplete(0, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }));

      const summary = aggregateAttempts(listEvents(db, "run-1"));

      expect(summary).toEqual([]);
    } finally {
      db.close();
    }
  });
});
