import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATION_ID = "001_init";

export interface OpenDbOptions {
  /**
   * Base directory holding `graph-bro.db`. Defaults to `~/.graph-bro`
   * (KTD-2); tests must override this with a temp dir rather than touching
   * the real home directory.
   */
  baseDir?: string;
}

function defaultBaseDir(): string {
  return join(homedir(), ".graph-bro");
}

function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "migrations");
}

/**
 * Idempotent migration runner (§8.8 minimal migration runner pattern): a
 * `schema_migrations` ledger tracks applied migration ids so re-running
 * `openDb`/`runMigrations` against an already-migrated file is a no-op.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY)`);
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(MIGRATION_ID);
  if (applied) return;
  const sql = readFileSync(join(migrationsDir(), "001_init.sql"), "utf-8");
  db.exec(sql);
  db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(MIGRATION_ID);
}

/**
 * Opens (creating if absent) the one global SQLite DB (KTD-2), sets WAL mode
 * + a `busy_timeout` so concurrent writer processes serialize instead of
 * throwing `SQLITE_BUSY` (ADR-0003), and runs the idempotent migration.
 */
export function openDb(options: OpenDbOptions = {}): Database.Database {
  const baseDir = options.baseDir ?? defaultBaseDir();
  mkdirSync(baseDir, { recursive: true });
  const db = new Database(join(baseDir, "graph-bro.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  return db;
}
