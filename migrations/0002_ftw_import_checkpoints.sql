CREATE TABLE IF NOT EXISTS ftw_import_checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','applied','restored')),
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  restored_at INTEGER,
  restore_reason TEXT
);

-- Deliberately empty outside a D1 batch. A failed compare-and-swap violates
-- CHECK(ok=1), aborting the entire batch before any content can be committed.
CREATE TABLE IF NOT EXISTS ftw_import_guard_assertions (
  assertion_id TEXT PRIMARY KEY NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1)
);
