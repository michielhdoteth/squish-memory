import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runFtsMigrations } from '../../db/migrations/fts.js';

describe('FTS migration rollback', () => {
  test('rebuilds inside bootstrap transaction without committing the caller transaction', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO memories (id, content) VALUES ('existing', 'rollbackmarker existing indexed text');
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content, tags, summary, content='memories', content_rowid='rowid'
        );
        INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, tags, summary)
          VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
        END;
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
          VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
        END;
        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
          VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
          INSERT INTO memories_fts(rowid, content, tags, summary)
          VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
        END;
        BEGIN IMMEDIATE;
      `);

      await runFtsMigrations(sqlite as never);
      expect(sqlite.inTransaction).toBe(true);
      const migratedSql = (sqlite.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'",
      ).get() as { sql: string }).sql.toLowerCase();
      expect(migratedSql).toContain("tokenize='porter unicode61'");
      sqlite.prepare('INSERT INTO memories (id, content) VALUES (?, ?)')
        .run('during-transaction', 'savepointtrigger searchable');
      expect((sqlite.prepare("SELECT count(*) AS count FROM memories_fts WHERE memories_fts MATCH 'savepointtrigger'")
        .get() as { count: number }).count).toBe(1);

      sqlite.exec('ROLLBACK');
      expect(sqlite.inTransaction).toBe(false);
      const restoredSql = (sqlite.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'",
      ).get() as { sql: string }).sql.toLowerCase();
      expect(restoredSql).not.toContain("tokenize='porter unicode61'");
      expect((sqlite.prepare("SELECT count(*) AS count FROM memories_fts WHERE memories_fts MATCH 'rollbackmarker'")
        .get() as { count: number }).count).toBe(1);
      expect(sqlite.prepare("SELECT 1 FROM memories WHERE id='during-transaction'").get()).toBeNull();
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });

  test('preserves the prior index and triggers when rebuilding fails', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO memories (id, content, tags, summary)
          VALUES ('existing', 'rollbackmarker existing indexed text', 'prior', 'old summary');
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content, tags, summary, content='memories', content_rowid='rowid'
        );
        INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, tags, summary)
          VALUES (new.rowid, new.content, COALESCE(new.tags, ''), '');
        END;
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
          VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), '');
        END;
        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
          VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), '');
          INSERT INTO memories_fts(rowid, content, tags, summary)
          VALUES (new.rowid, new.content, COALESCE(new.tags, ''), '');
        END;
      `);

      const priorFtsSql = (sqlite.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'",
      ).get() as { sql: string }).sql;
      sqlite.exec('ALTER TABLE memories RENAME TO memories_hold');

      await expect(runFtsMigrations(sqlite as never)).rejects.toThrow();

      const restoredFtsSql = (sqlite.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'",
      ).get() as { sql: string }).sql;
      expect(restoredFtsSql).toBe(priorFtsSql);
      const restoredTriggers = sqlite.prepare(`
        SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('memories_ai', 'memories_ad', 'memories_au')
      `).all() as Array<{ name: string }>;
      expect(restoredTriggers.map((trigger) => trigger.name).sort())
        .toEqual(['memories_ad', 'memories_ai', 'memories_au']);

      sqlite.exec('ALTER TABLE memories_hold RENAME TO memories');
      const priorMatch = sqlite.prepare(`
        SELECT count(*) AS count FROM memories_fts WHERE memories_fts MATCH 'rollbackmarker'
      `).get() as { count: number };
      sqlite.prepare('INSERT INTO memories (id, content, tags, summary) VALUES (?, ?, ?, ?)')
        .run('after-failure', 'rollbackmarker post failure indexed text', 'after', 'summary');
      const postFailureMatch = sqlite.prepare(`
        SELECT count(*) AS count FROM memories_fts WHERE memories_fts MATCH 'post'
      `).get() as { count: number };
      expect(priorMatch.count).toBe(1);
      expect(postFailureMatch.count).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
