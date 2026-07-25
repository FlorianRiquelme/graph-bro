import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/store/db.js";

/**
 * R17/KTD-14: proves the transaction wrapper around each migration's DDL +
 * ledger insert, using a real forced mid-file statement failure (a genuine
 * `duplicate column name` from sqlite) rather than a mocked `db.exec`.
 */
describe("store: db migrations (R17)", () => {
  let baseDir: string;
  let migrationsDir: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "graph-bro-store-"));
    migrationsDir = mkdtempSync(join(tmpdir(), "graph-bro-migrations-"));
    db = openDb({ baseDir }); // real 001/002/003 migrations applied; `runs` table exists.
  });

  afterEach(() => {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(migrationsDir, { recursive: true, force: true });
  });

  function writeHalfApplyMigration(): void {
    // Second statement is a genuine sqlite error (duplicate column), forcing
    // a real mid-file failure rather than a simulated one.
    writeFileSync(
      join(migrationsDir, "999_half_apply.sql"),
      `ALTER TABLE runs ADD COLUMN probe_col TEXT;\nALTER TABLE runs ADD COLUMN probe_col TEXT;\n`,
    );
  }

  it("a migration whose second statement fails leaves the schema unchanged and the ledger unwritten", () => {
    writeHalfApplyMigration();

    expect(() => runMigrations(db, { migrationsDir, migrationIds: ["999_half_apply"] })).toThrow(/duplicate column name/);

    const columns = (db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("probe_col"); // rolled back with the failed statement, not left half-applied

    const ledgerRow = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get("999_half_apply");
    expect(ledgerRow).toBeUndefined();
  });

  it("a subsequent open succeeds and re-applies the repaired migration cleanly", () => {
    writeHalfApplyMigration();
    expect(() => runMigrations(db, { migrationsDir, migrationIds: ["999_half_apply"] })).toThrow();

    // Repair the file in place (same id) and retry, as a real operator would
    // after fixing whatever caused the transient failure.
    writeFileSync(join(migrationsDir, "999_half_apply.sql"), `ALTER TABLE runs ADD COLUMN probe_col TEXT;\n`);

    expect(() => runMigrations(db, { migrationsDir, migrationIds: ["999_half_apply"] })).not.toThrow();

    const columns = (db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("probe_col");
    const ledgerRow = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get("999_half_apply");
    expect(ledgerRow).toBeDefined();

    // Re-running again is a no-op (already recorded in the ledger).
    expect(() => runMigrations(db, { migrationsDir, migrationIds: ["999_half_apply"] })).not.toThrow();
  });

  it("an already-migrated store opens as a no-op, unchanged from today", () => {
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
  });
});
