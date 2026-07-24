-- U6: persists the topology file path per run so `graph-bro resume <run_id>`
-- can recompile the same topology without the operator re-specifying it
-- (only the run id is passed to `resume`, per ADR-0004/KTD-14).
ALTER TABLE runs ADD COLUMN topology_path TEXT;
