import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/store/db.js";
import { appendEvent, listEvents } from "../../src/store/trace.js";

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
