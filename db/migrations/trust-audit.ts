import type { Database } from 'better-sqlite3';

/** Create the minimized authorization-decision log on existing local databases. */
export async function runTrustAuditMigrations(sqlite: Database): Promise<void> {
  sqlite.exec(`
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
  `);
}
