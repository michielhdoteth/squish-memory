import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ensureSqliteSchema } from '../../db/bootstrap.js';

describe('SQLite schema bootstrap rollback', () => {
  test('rolls back every schema and migration change on a late migration failure, then retries cleanly', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE trust_audit_log (
        id TEXT PRIMARY KEY,
        actor_hash TEXT NOT NULL,
        resource_hash TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL
      )`);
      sqlite.prepare(`INSERT INTO trust_audit_log
        (id, actor_hash, resource_hash, asset_type, decision, reason)
        VALUES (?, ?, ?, ?, ?, ?)`).run('preexisting', 'actor', 'resource', 'memory', 'deny', 'seed');

      await expect(ensureSqliteSchema(sqlite as never)).rejects.toThrow('no such column: created_at');
      expect(sqlite.inTransaction).toBe(false);
      expect((sqlite.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM trust_audit_log').get() as { count: number }).count).toBe(1);
      expect(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()).toBeNull();
      expect(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_schema_versions'").get()).toBeNull();
      expect(sqlite.prepare('PRAGMA table_info(trust_audit_log)').all().map((row) => row.name))
        .not.toContain('created_at');

      sqlite.exec('ALTER TABLE trust_audit_log ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
      await ensureSqliteSchema(sqlite as never);
      expect(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()).toBeDefined();
      expect(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_schema_versions'").get()).toBeDefined();
      const revision = 'sqlite-schema-2026-10-19-revision-1';
      expect(sqlite.prepare('SELECT 1 FROM _schema_versions WHERE version = ?').get(revision)).toBeDefined();
      expect(sqlite.inTransaction).toBe(false);

      sqlite.exec('DROP INDEX memory_private_session_scope_idx');
      await ensureSqliteSchema(sqlite as never);
      expect(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'memory_private_session_scope_idx'").get())
        .toBeNull();

      sqlite.prepare('DELETE FROM _schema_versions WHERE version = ?').run(revision);
      await ensureSqliteSchema(sqlite as never);
      expect(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'memory_private_session_scope_idx'").get())
        .toBeDefined();
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM trust_audit_log').get() as { count: number }).count).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  test('uses a savepoint inside a caller transaction without committing the caller transaction', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec('PRAGMA foreign_keys = ON');
      sqlite.exec('BEGIN IMMEDIATE');
      await ensureSqliteSchema(sqlite as never);
      expect(sqlite.inTransaction).toBe(true);
      expect(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()).toBeDefined();

      sqlite.exec('ROLLBACK');
      expect(sqlite.inTransaction).toBe(false);
      expect(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()).toBeNull();
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });
});
