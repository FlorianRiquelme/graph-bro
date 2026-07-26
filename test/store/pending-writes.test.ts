import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/store/db.js";
import { writeCheckpoint } from "../../src/store/checkpoints.js";
import {
  claimOwnership,
  commitPendingWrite,
  createRun,
  getRunOwnerPid,
  isProcessAlive,
  listPendingWrites,
  pendingWriteKey,
  resume,
} from "../../src/store/pending-writes.js";

describe("store: pending-writes crash core", () => {
  let baseDir: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "graph-bro-pending-writes-"));
    db = openDb({ baseDir });
  });

  afterEach(() => {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("is keyed by the deterministic hash including item_key; same-key re-delivery is idempotent (first wins)", () => {
    const parts = { runId: "run-1", node: "reader", step: 1, itemKey: "0", triggers: ["dispatch"] };

    const first = commitPendingWrite(db, { ...parts, writes: { result: "first" } });
    const second = commitPendingWrite(db, { ...parts, writes: { result: "second (should be dropped)" } });

    expect(first.key).toBe(pendingWriteKey(parts));
    expect(second.key).toBe(first.key);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false); // INSERT OR IGNORE: first write wins

    const rows = listPendingWrites(db, "run-1", { step: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].writes).toEqual({ result: "first" });
  });

  it("KTD-12 sibling non-collision: two instances of the same node at the same step with different item_keys produce two distinct rows", () => {
    commitPendingWrite(db, {
      runId: "run-1",
      node: "reader",
      step: 1,
      itemKey: "0",
      triggers: ["dispatch"],
      writes: { result: "item-0" },
    });
    commitPendingWrite(db, {
      runId: "run-1",
      node: "reader",
      step: 1,
      itemKey: "1",
      triggers: ["dispatch"],
      writes: { result: "item-1" },
    });

    const rows = listPendingWrites(db, "run-1", { step: 1 });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.writeKey)).size).toBe(2);
    expect(new Set(rows.map((r) => r.writes.result))).toEqual(new Set(["item-0", "item-1"]));
  });

  it("owner_pid is set on launch, and the liveness helper reports alive/dead correctly", () => {
    createRun(db, "run-owner", process.pid);
    expect(getRunOwnerPid(db, "run-owner")).toBe(process.pid);
    expect(isProcessAlive(process.pid)).toBe(true);

    // A pid that (almost certainly) doesn't exist.
    const deadPid = 999_999;
    expect(isProcessAlive(deadPid)).toBe(false);
  });

  it("claimOwnership is an atomic compare-and-swap: only one of two racing claims against the same dead pid wins", () => {
    createRun(db, "run-race", 999_999); // a dead owner pid

    const first = claimOwnership(db, "run-race", 999_999, 1001);
    const second = claimOwnership(db, "run-race", 999_999, 1002); // same expected old pid, racing

    expect(first).toBe(true);
    expect(second).toBe(false); // lost the race: owner_pid was already 1001 by the time this ran
    expect(getRunOwnerPid(db, "run-race")).toBe(1001); // the winner's pid, not the loser's
  });

  it("Covers AE2: resume replays 12 of 17 fan-out branch pending writes and does not re-execute them", () => {
    const runId = "run-fanout";
    const items = Array.from({ length: 17 }, (_, i) => `item-${i}`);

    // Checkpoint at step 0: the fan-out's dispatch already ran, the frontier
    // is the 17 reader branch instances about to run at step 1.
    writeCheckpoint(db, runId, {
      state: { batch: { items } },
      frontier: items.map((_, i) => ({ nodeId: "reader", instanceId: `reader:${i}` })),
      barrier: {},
      step: 0,
    });

    // 12 of the 17 branches complete before the crash.
    for (let i = 0; i < 12; i += 1) {
      commitPendingWrite(db, {
        runId,
        node: "reader",
        step: 1,
        itemKey: String(i),
        triggers: ["dispatch"],
        writes: { results: items[i] },
      });
    }

    // Simulated crash. Fresh resume:
    const readerCalls: string[] = [];
    const reducerForKey = (key: string) => (key === "results" ? ("dedup" as const) : undefined);
    const result = resume(db, runId, { reducerForKey });

    expect(result.completedInstanceIds.size).toBe(12);
    expect(result.frontier).toHaveLength(5); // 17 - 12 remaining, not re-executed
    expect((result.state.results as string[]).sort()).toEqual(items.slice(0, 12).sort());

    // This only proves the recomputed frontier excludes the 12 completed
    // instances (a frontier-shape assertion) — it does not itself invoke any
    // node function, so it is not a call-count proof. The actual call-count
    // proof that the 12 are never re-invoked lives in
    // test/engine/fanout.test.ts's "Crash mid-drain" test and
    // test/integration/crash-resume.test.ts, which run this frontier through
    // a real (stub) executor and assert on `stub.calls`.
    for (const activation of result.frontier) {
      readerCalls.push(activation.instanceId);
    }
    expect(readerCalls).toHaveLength(5);
    expect(new Set(readerCalls)).toEqual(
      new Set(Array.from({ length: 5 }, (_, i) => `reader:${i + 12}`)),
    );
  });

  it("atomicity: a crash between pending-writes and the coarse checkpoint loses only in-flight tasks", () => {
    const runId = "run-atomic";

    writeCheckpoint(db, runId, {
      state: {},
      frontier: [
        { nodeId: "reader", instanceId: "reader:0" },
        { nodeId: "reader", instanceId: "reader:1" },
      ],
      barrier: {},
      step: 0,
    });

    // Only reader:0 commits its write before the simulated crash; reader:1
    // never gets the chance.
    commitPendingWrite(db, {
      runId,
      node: "reader",
      step: 1,
      itemKey: "0",
      triggers: ["dispatch"],
      writes: { results: "item-0" },
    });

    const result = resume(db, runId, { reducerForKey: () => "dedup" });

    expect(result.completedInstanceIds).toEqual(new Set(["reader:0"]));
    expect(result.frontier).toEqual([{ nodeId: "reader", instanceId: "reader:1" }]); // re-runs
    expect(result.state.results).toEqual("item-0"); // committed write survives (single write, no fold needed)
  });

  it("ERROR control writes are not treated as completed on replay (a failed task re-runs)", () => {
    const runId = "run-error";

    writeCheckpoint(db, runId, {
      state: {},
      frontier: [{ nodeId: "reader", instanceId: "reader:0" }],
      barrier: {},
      step: 0,
    });

    commitPendingWrite(db, {
      runId,
      node: "reader",
      step: 1,
      itemKey: "0",
      triggers: ["dispatch"],
      writes: { error: "boom" },
      isError: true,
    });

    const result = resume(db, runId);

    expect(result.completedInstanceIds.size).toBe(0);
    expect(result.frontier).toEqual([{ nodeId: "reader", instanceId: "reader:0" }]); // forced re-run
  });

  it("ERROR writes occupy a distinct key space from regular writes at the same coordinates", () => {
    const parts = { runId: "run-key-space", node: "reader", step: 1, itemKey: "0", triggers: ["dispatch"] };

    expect(pendingWriteKey(parts, false)).not.toBe(pendingWriteKey(parts, true));
  });

  it("resume() on a run with no checkpoint yet returns the documented empty default rather than throwing", () => {
    createRun(db, "run-never-checkpointed", process.pid);

    const result = resume(db, "run-never-checkpointed");

    expect(result).toEqual({ step: 0, state: {}, frontier: [], completedInstanceIds: new Set(), attempts: {} });
  });

  it("two concurrent writer connections against one DB serialize under WAL + busy_timeout without SQLITE_BUSY", async () => {
    db.close(); // free the file so the child workers own it exclusively

    const dbPath = join(baseDir, "graph-bro.db");
    const workerScript = join(baseDir, "worker.cjs");
    writeFileSync(
      workerScript,
      `
      const Database = require(${JSON.stringify(join(process.cwd(), "node_modules", "better-sqlite3"))});
      const dbPath = process.argv[2];
      const workerId = process.argv[3];
      const db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      for (let i = 0; i < 25; i += 1) {
        db.prepare(
          "INSERT OR IGNORE INTO pending_writes (write_key, run_id, node, step, item_key, triggers, is_error, writes) VALUES (?,?,?,?,?,?,0,?)"
        ).run(\`\${workerId}-\${i}\`, "run-concurrent", "reader", 1, String(i), "[]", "{}");
      }
      db.close();
      `,
    );

    const runWorker = (workerId: string) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [workerScript, dbPath, workerId]);
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.on("close", (code) => resolve({ code, stderr }));
      });

    const [a, b] = await Promise.all([runWorker("a"), runWorker("b")]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stderr).not.toMatch(/SQLITE_BUSY/);
    expect(b.stderr).not.toMatch(/SQLITE_BUSY/);

    const verifyDb = openDb({ baseDir });
    const rows = listPendingWrites(verifyDb, "run-concurrent", { step: 1 });
    expect(rows).toHaveLength(50); // both workers' 25 writes landed, none dropped by contention
    verifyDb.close();
  });
});
