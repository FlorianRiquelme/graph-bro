import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Applied in order; each id is tracked independently in `schema_migrations` (§8.8). */
const MIGRATION_IDS = ["001_init", "002_run_topology_path", "003_workspace"];

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

export interface RunMigrationsOptions {
  /**
   * Test seam only (never set by `openDb`): overrides where migration `.sql`
   * files are read from and/or which ids are applied, so the half-apply
   * failure mode (R17) can be forced with a real broken migration file
   * instead of mocking `db.exec`.
   */
  migrationsDir?: string;
  migrationIds?: string[];
}

/**
 * Idempotent migration runner (§8.8 minimal migration runner pattern): a
 * `schema_migrations` ledger tracks applied migration ids so re-running
 * `openDb`/`runMigrations` against an already-migrated file is a no-op.
 *
 * KTD-14: `db.exec()` is not transactional across the multiple statements a
 * migration file can hold — e.g. the workspace migration's three `ALTER
 * TABLE` statements. A mid-file failure (transient lock, disk error) would
 * otherwise leave the first statement committed while the ledger insert
 * never runs, so the next `openDb()` retries the same file from scratch and
 * throws `duplicate column name` on every future invocation. Wrapping each
 * migration's DDL and its ledger insert in one `db.transaction()` makes a
 * retry safe: either both land, or neither does.
 */
export function runMigrations(db: Database.Database, options: RunMigrationsOptions = {}): void {
  const dir = options.migrationsDir ?? migrationsDir();
  const ids = options.migrationIds ?? MIGRATION_IDS;
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY)`);
  for (const id of ids) {
    const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(id);
    if (applied) continue;
    const sql = readFileSync(join(dir, `${id}.sql`), "utf-8");
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(id);
    });
    applyMigration();
  }
}

/**
 * Opens (creating if absent) the one global SQLite DB (KTD-2), sets WAL mode
 * + a `busy_timeout` so concurrent writer processes serialize instead of
 * throwing `SQLITE_BUSY` (ADR-0003), and runs the idempotent migration.
 */
export function openDb(options: OpenDbOptions = {}): Database.Database {
  // GRAPH_BRO_HOME: overrides the default `~/.graph-bro` for the CLI/runtime's own
  // child processes under test, without requiring every call site to thread `baseDir`
  // through argv (the CLI itself never takes a `--home` flag — KTD-2 is one global DB).
  const baseDir = options.baseDir ?? process.env.GRAPH_BRO_HOME ?? defaultBaseDir();
  mkdirSync(baseDir, { recursive: true });
  const db = new Database(join(baseDir, "graph-bro.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  return db;
}
