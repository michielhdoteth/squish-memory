import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMemoryPlacesMigrations } from '../../db/migrations/memory-places.js';

function createLegacyDatabase(): Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE memories (id TEXT PRIMARY KEY);
    CREATE TABLE places (id TEXT PRIMARY KEY, place_type TEXT NOT NULL);
    CREATE TABLE memory_places (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      place_id TEXT NOT NULL REFERENCES places(id),
      created_at INTEGER NOT NULL
    );
    INSERT INTO memories VALUES ('memory-1');
    INSERT INTO places VALUES ('place-a', 'project'), ('place-b', 'project');
    INSERT INTO memory_places VALUES
      ('assignment-a', 'memory-1', 'place-a', 1700000000),
      ('assignment-b', 'memory-1', 'place-b', 1700000001);
  `);
  return sqlite;
}

describe('legacy memory_places migration recovery', () => {
  test('preserves the source table after a failed copy and succeeds on retry', async () => {
    const sqlite = createLegacyDatabase();
    try {
      await expect(runMemoryPlacesMigrations(sqlite as unknown as import('better-sqlite3').Database)).rejects.toThrow();

      expect(sqlite.prepare('SELECT id, place_id FROM memory_places ORDER BY id').all()).toEqual([
        { id: 'assignment-a', place_id: 'place-a' },
        { id: 'assignment-b', place_id: 'place-b' },
      ]);
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_places_new'").get()).toBeNull();

      sqlite.prepare("UPDATE places SET place_type='reference' WHERE id='place-b'").run();
      await runMemoryPlacesMigrations(sqlite as unknown as import('better-sqlite3').Database);

      expect(sqlite.prepare('SELECT id, place_type, source, created_at FROM memory_places ORDER BY id').all()).toEqual([
        { id: 'assignment-a', place_type: 'project', source: 'legacy', created_at: 1700000000 },
        { id: 'assignment-b', place_type: 'reference', source: 'legacy', created_at: 1700000001 },
      ]);
      expect(sqlite.prepare('PRAGMA table_info(memory_places)').all().map((column: { name: string }) => column.name)).toContain('place_sort_order');
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_tags'").get()).toBeDefined();
    } finally {
      sqlite.close();
    }
  });
});
