/**
 * Memory places table migrations
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../core/logger.js';

export async function runMemoryPlacesMigrations(sqlite: Database): Promise<void> {
  const memoryPlacesTableCheck = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_places'"
  ).get() as { name: string } | undefined;

  if (!memoryPlacesTableCheck) return;

  const memoryPlacesInfo = sqlite.prepare("PRAGMA table_info(memory_places)").all() as Array<{ name: string; notnull: number }>;
  let existingMemoryPlacesColumns = new Set(memoryPlacesInfo.map(col => col.name));

  // v1.5.0: Check if place_id is NOT NULL - if so, we need to recreate the table
  // because the new schema uses place_type instead of place_id as the primary routing column
  const placeIdNotNull = memoryPlacesInfo.find(
    col => col.name === 'place_id' && col.notnull === 1
  );

  if (placeIdNotNull) {
    // Recreate memory_places atomically. A failed copy or index build must
    // leave the legacy source table intact so startup can be retried safely.
    logger.info('[Migration] Recreating memory_places table for v1.5.0 multi-place routing...');

    const migrate = sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE memory_places_new (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          place_type TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 1.0,
          reason TEXT,
          source TEXT NOT NULL DEFAULT 'heuristic',
          is_primary INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
          place_sort_order INTEGER DEFAULT 0
        )
      `);

      const sourceCount = (sqlite.prepare('SELECT COUNT(*) AS count FROM memory_places').get() as { count: number }).count;
      sqlite.exec(`
        INSERT INTO memory_places_new (id, memory_id, place_type, weight, source, is_primary, created_at)
        SELECT
          mp.id,
          mp.memory_id,
          COALESCE(p.place_type, 'inbox'),
          1.0,
          'legacy',
          1,
          mp.created_at
        FROM memory_places mp
        LEFT JOIN places p ON mp.place_id = p.id
      `);
      const copiedCount = (sqlite.prepare('SELECT COUNT(*) AS count FROM memory_places_new').get() as { count: number }).count;
      if (copiedCount !== sourceCount) {
        throw new Error(`Memory places migration count mismatch: ${sourceCount} source rows, ${copiedCount} copied rows`);
      }

      sqlite.exec('DROP TABLE memory_places');
      sqlite.exec('ALTER TABLE memory_places_new RENAME TO memory_places');

      sqlite.exec('CREATE INDEX memory_places_memory_idx ON memory_places(memory_id)');
      sqlite.exec('CREATE INDEX memory_places_place_type_idx ON memory_places(place_type)');
      sqlite.exec('CREATE INDEX memory_places_place_weight_idx ON memory_places(place_type, weight)');
      sqlite.exec('CREATE INDEX memory_places_memory_primary_idx ON memory_places(memory_id, is_primary)');
      sqlite.exec('CREATE UNIQUE INDEX memory_places_unique ON memory_places(memory_id, place_type, source)');
    });
    migrate.immediate();
    existingMemoryPlacesColumns = new Set(
      (sqlite.prepare('PRAGMA table_info(memory_places)').all() as Array<{ name: string }>).map((column) => column.name)
    );

    logger.info('[Migration] memory_places table recreated for v1.5.0');
  }

  // Standard column migrations for tables that already have the new schema
  const memoryPlacesMigrations = [
    { col: 'place_sort_order', sql: 'ALTER TABLE memory_places ADD COLUMN place_sort_order INTEGER DEFAULT 0' },
    // v1.5.0: Multi-place routing columns
    { col: 'place_type', sql: "ALTER TABLE memory_places ADD COLUMN place_type TEXT" },
    { col: 'weight', sql: 'ALTER TABLE memory_places ADD COLUMN weight REAL DEFAULT 1.0' },
    { col: 'reason', sql: 'ALTER TABLE memory_places ADD COLUMN reason TEXT' },
    { col: 'source', sql: "ALTER TABLE memory_places ADD COLUMN source TEXT DEFAULT 'heuristic'" },
    { col: 'is_primary', sql: 'ALTER TABLE memory_places ADD COLUMN is_primary INTEGER DEFAULT 0' },
  ];

  for (const migration of memoryPlacesMigrations) {
    if (!existingMemoryPlacesColumns.has(migration.col)) {
      try {
        sqlite.exec(migration.sql);
        logger.info(`Migration: Added column ${migration.col} to memory_places table`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes('duplicate column name')) {
          logger.warn(`Migration note for memory_places.${migration.col}: ${msg}`);
        }
      }
    }
  }

  // Create memory_tags table if it doesn't exist
  const memoryTagsTableCheck = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_tags'"
  ).get() as { name: string } | undefined;

  if (!memoryTagsTableCheck) {
    try {
      sqlite.exec(`
        CREATE TABLE memory_tags (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          tag TEXT NOT NULL,
          source TEXT DEFAULT 'heuristic',
          confidence REAL,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);
      sqlite.exec('CREATE INDEX IF NOT EXISTS memory_tags_tag_idx ON memory_tags(tag)');
      sqlite.exec('CREATE INDEX IF NOT EXISTS memory_tags_memory_idx ON memory_tags(memory_id)');
      sqlite.exec('CREATE INDEX IF NOT EXISTS memory_tags_tag_memory_idx ON memory_tags(tag, memory_id)');
      sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS memory_tags_unique ON memory_tags(memory_id, tag)');
      logger.info('Migration: Created memory_tags table');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.includes('already exists')) {
        logger.warn(`Migration note for memory_tags: ${msg}`);
      }
    }
  }
}
