import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('SQLite deferred supersession transactions', () => {
  it('serializes opposite writes across independent handles after both read the same snapshot', () => {
    const directory = join(tmpdir(), `squish-supersession-lock-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'graph.db');
    const first = new Database(path);
    const second = new Database(path);
    const statements: Array<{ finalize: () => void }> = [];
    const prepare = (database: Database, sql: string) => {
      const statement = database.prepare(sql);
      statements.push(statement);
      return statement;
    };
    try {
      first.exec('PRAGMA busy_timeout = 0;');
      second.exec('PRAGMA busy_timeout = 0;');
      first.exec(`
        CREATE TABLE entities (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
        CREATE TABLE knowledge_edges (
          id TEXT PRIMARY KEY, from_id TEXT NOT NULL, from_kind TEXT NOT NULL,
          to_id TEXT NOT NULL, to_kind TEXT NOT NULL, edge_type TEXT NOT NULL,
          valid_from INTEGER NOT NULL, valid_to INTEGER,
          recorded_at INTEGER NOT NULL, recorded_to INTEGER
        );
        INSERT INTO entities (id, project_id) VALUES ('A', 'project'), ('B', 'project');
      `);

      const cycleExists = (database: Database, fromId: string, toId: string): boolean => {
        const now = Date.now();
        const row = prepare(database, `
          WITH RECURSIVE reachable(id) AS (
            SELECT ?
            UNION
            SELECT edge.to_id FROM knowledge_edges AS edge
            JOIN reachable ON edge.from_id = reachable.id
            JOIN entities AS destination ON destination.id = edge.to_id AND destination.project_id = 'project'
            WHERE edge.from_kind = 'entity' AND edge.to_kind = 'entity'
              AND edge.edge_type = 'supersedes_version'
              AND edge.valid_from <= ? AND (edge.valid_to IS NULL OR edge.valid_to > ?)
              AND edge.recorded_at <= ? AND (edge.recorded_to IS NULL OR edge.recorded_to > ?)
          )
          SELECT 1 AS cycle FROM reachable WHERE id = ? LIMIT 1
        `).get(toId, now, now, now, now, fromId) as { cycle?: number } | null;
        return row?.cycle === 1;
      };

      first.exec('BEGIN');
      second.exec('BEGIN');
      expect(cycleExists(first, 'A', 'B')).toBe(false);
      expect(cycleExists(second, 'B', 'A')).toBe(false);

      // This is the same first-write lock used by the production wrapper when
      // a caller supplied a deferred transaction.
      prepare(first, 'UPDATE knowledge_edges SET id = id WHERE 0').run();
      expect(() => prepare(second, 'UPDATE knowledge_edges SET id = id WHERE 0').run()).toThrow();
      second.exec('ROLLBACK');
      prepare(first, `INSERT INTO knowledge_edges
        (id, from_id, from_kind, to_id, to_kind, edge_type, valid_from, recorded_at)
        VALUES ('A-B', 'A', 'entity', 'B', 'entity', 'supersedes_version', ?, ?)`)
        .run(Date.now(), Date.now());
      first.exec('COMMIT');

      expect(prepare(first, 'SELECT COUNT(*) AS count FROM knowledge_edges').get()).toEqual({ count: 1 });
    } finally {
      if (first.inTransaction) first.exec('ROLLBACK');
      if (second.inTransaction) second.exec('ROLLBACK');
      for (const statement of statements) statement.finalize();
      first.clearQueryCache();
      second.clearQueryCache();
      second.close();
      first.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
