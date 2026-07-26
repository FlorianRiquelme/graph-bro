-- U5: records the resolved base ref, workspace path, and run branch on the
-- run row (KTD-1/R14) — computed once by the CLI at `start` (pure functions
-- of the run id, no race with the engine's own boot), and read back by
-- `status`/`result`/`resume`.
ALTER TABLE runs ADD COLUMN base_ref TEXT;
ALTER TABLE runs ADD COLUMN workspace_path TEXT;
ALTER TABLE runs ADD COLUMN run_branch TEXT;
