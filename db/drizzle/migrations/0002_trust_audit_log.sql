-- Portable authorization audit schema used by local SQLite and PostgreSQL team mode.
CREATE TABLE IF NOT EXISTS trust_audit_log (
  id TEXT PRIMARY KEY,
  actor_hash TEXT NOT NULL,
  resource_hash TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS trust_audit_created_idx ON trust_audit_log(created_at);
CREATE INDEX IF NOT EXISTS trust_audit_resource_idx ON trust_audit_log(resource_hash, created_at);
