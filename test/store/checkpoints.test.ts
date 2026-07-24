import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/store/db.js";
import { readCheckpoint, readLatestCheckpoint, writeCheckpoint, type CheckpointSnapshot } from "../../src/store/checkpoints.js";

describe("store: db + checkpoints", () => {
  let baseDir: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "graph-bro-store-"));
    db = openDb({ baseDir });
  });

  afterEach(() => {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("migration is idempotent (running it twice is a no-op) and WAL mode is set", () => {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("checkpoint round-trips: write -> read -> structurally identical", () => {
    const snapshot: CheckpointSnapshot = {
      state: { results: ["a", "b"], batch: { items: [1, 2, 3] } },
      frontier: [{ nodeId: "collector", instanceId: "collector" }],
      barrier: { "join-1": { expected: { reader: ["reader:0", "reader:1"] }, arrived: { reader: ["reader:0"] } } },
      step: 3,
      history: [{ step: 1 }, { step: 2 }],
    };

    writeCheckpoint(db, "run-1", snapshot);
    const read = readCheckpoint(db, "run-1", 3);

    expect(read).toEqual(snapshot);
  });

  it("readLatestCheckpoint returns the highest-step checkpoint for a run", () => {
    writeCheckpoint(db, "run-2", { state: { s: 1 }, frontier: [], barrier: {}, step: 1 });
    writeCheckpoint(db, "run-2", { state: { s: 2 }, frontier: [], barrier: {}, step: 2 });

    const latest = readLatestCheckpoint(db, "run-2");

    expect(latest?.step).toBe(2);
    expect(latest?.state).toEqual({ s: 2 });
  });

  it("returns undefined when no checkpoint exists for a run", () => {
    expect(readLatestCheckpoint(db, "no-such-run")).toBeUndefined();
  });
});
