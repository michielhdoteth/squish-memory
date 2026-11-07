import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runKnowledgeMigrations } from '../../db/migrations/knowledge.js';

describe('SQLite knowledge migration nested transaction', () => {
  test('upgrades legacy edge uniqueness with a savepoint inside bootstrap transaction', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE knowledge_edges (
          id TEXT PRIMARY KEY,
          from_id TEXT NOT NULL,
          from_kind TEXT NOT NULL,
          to_id TEXT NOT NULL,
          to_kind TEXT NOT NULL,
          edge_type TEXT NOT NULL,
          weight REAL DEFAULT 1.0,
          metadata TEXT,
          created_at INTEGER DEFAULT 0 NOT NULL,
          UNIQUE(from_id, from_kind, to_id, to_kind, edge_type)
        );
        INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type)
          VALUES ('edge-1', 'a', 'memory', 'b', 'memory', 'relates_to');
        BEGIN IMMEDIATE;
      `);

      await runKnowledgeMigrations(sqlite as never);

      expect(sqlite.inTransaction).toBe(true);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges').get())
        .toEqual({ count: 1 });
      expect(sqlite.prepare('PRAGMA table_info(knowledge_edges)').all().map((column) => column.name))
        .toContain('recorded_to');
      const uniqueIndexes = sqlite.prepare('PRAGMA index_list(knowledge_edges)').all() as Array<{ name: string; unique: number }>;
      const temporalIndex = uniqueIndexes.find((index) => index.name === 'knowledge_edges_unique');
      expect(temporalIndex?.unique).toBe(1);
      expect(sqlite.prepare(`PRAGMA index_info("${temporalIndex?.name}")`).all().map((column) => column.name))
        .toEqual(['from_id', 'from_kind', 'to_id', 'to_kind', 'edge_type', 'valid_from', 'recorded_at']);

      sqlite.exec('ROLLBACK');
      expect(sqlite.inTransaction).toBe(false);
      expect(sqlite.prepare('PRAGMA table_info(knowledge_edges)').all().map((column) => column.name))
        .not.toContain('recorded_to');
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges').get() as { count: number }).count)
        .toBe(1);
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });
});
