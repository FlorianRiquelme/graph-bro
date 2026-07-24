-- U3: durable store schema (§8.8 SQLite DDL pattern; ADR-0003/0008/0009).

-- One row per run; owner_pid backs the single-owner guard (KTD-14).
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Whole-state snapshot per super-step (coarse resume point). One opaque JSON
-- blob per row (§8.8) carrying {state, frontier, barrier, history}.
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (run_id, step)
);

-- Per-task pending writes (the crash core, §8.5). write_key is the
-- deterministic hash of (run_id, node, step, item_key, triggers) [+ kind for
-- ERROR control writes, which occupy a distinct key space] — the per-instance
-- item_key (KTD-12) is what keeps N fan-out siblings at one step from
-- collapsing to one row under INSERT OR IGNORE.
CREATE TABLE IF NOT EXISTS pending_writes (
  write_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node TEXT NOT NULL,
  step INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  triggers TEXT NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0,
  writes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Trace events (ADR-0009): model/token/cost/duration columns from inception,
-- populated starting in U4.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  node TEXT,
  step INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens INTEGER,
  duration_ms INTEGER,
  cost_usd REAL,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
