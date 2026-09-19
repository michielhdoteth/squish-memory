/**
 * Schema repair: auto-fix detected schema issues.
 *
 * This module contains fixSchemaIssues(), which probes the current schema
 * state and applies targeted repairs (missing tables, indexes, FTS, places,
 * graph entities). It never probes without repairing.
 */

import { getDb } from './index.js';
import { ensureSqliteSchema } from './bootstrap.js';
import { getRawClient } from './utils.js';
import { probeSchemaHealth, REQUIRED_INDEXES } from './schema-probe.js';
import { createSingleTable } from './schema-ddl.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RepairAction {
  type: 'create_table' | 'create_index' | 'add_column' | 'repair_fts' | 'init_places' | 'create_entities_table' | 'run_migration' | 'rebuild_schema';
  detail: string;
  target?: string;
}

export interface FixOptions {
  fixMissingTables?: boolean;
  fixMissingIndexes?: boolean;
  fixFts?: boolean;
  fixPlaces?: boolean;
  fixGraphEntities?: boolean;
  fixAll?: boolean;
  verbose?: boolean;
}

// ─── Repair ──────────────────────────────────────────────────────────────────

/**
 * Auto-repair detected schema issues.
 * Returns list of repair actions taken.
 */
export async function fixSchemaIssues(options: FixOptions = {}): Promise<RepairAction[]> {
  const actions: RepairAction[] = [];
  const fixAll = options.fixAll ?? false;
  const verbose = options.verbose ?? true;

  // Resolve which fixes to run
  const fixMissingTables = options.fixMissingTables ?? fixAll;
  const fixMissingIndexes = options.fixMissingIndexes ?? fixAll;
  const fixFts = options.fixFts ?? fixAll;
  const fixPlaces = options.fixPlaces ?? fixAll;
  const fixGraphEntities = options.fixGraphEntities ?? fixAll;

  try {
    const probe = await probeSchemaHealth();

    // Skip if database is unavailable (not just drifted)
    if (probe.status === 'unavailable') {
      if (verbose) console.error('Database unavailable - cannot fix schema');
      return actions;
    }

    const db = await getDb();
    const raw = getRawClient(db);

    if (!raw || typeof raw.prepare !== 'function') {
      if (verbose) console.error('Unsupported database driver for repair');
      return actions;
    }

    const isSqlite = true;

    // 1. Fix missing tables by running full schema bootstrap
    if (fixMissingTables && probe.missingTables.length > 0) {
      if (verbose) console.log(`Running schema migration to create missing tables (${probe.missingTables.length} missing)...`);
      try {
        // Run ensureSqliteSchema which handles both creation and migrations.
        // The second (non-tolerant) pass may throw on existing tables with
        // incomplete column sets, but the first pass already created new tables.
        await ensureSqliteSchema(raw).catch(() => {
          // Second pass failure is acceptable - tables from first pass committed
          if (verbose) console.log('  Schema bootstrap completed with deferred warnings (tables created)');
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (verbose) console.warn(`  First-pass schema bootstrap warning: ${msg}`);
      }

      // Check if any tables are still missing after the bootstrap
      const recheck = await probeSchemaHealth();
      if (recheck.missingTables.length > 0 && isSqlite) {
        // Create remaining missing tables individually (they were after the
        // failing statement in the schema SQL)
        for (const tableName of recheck.missingTables) {
          try {
            createSingleTable(raw, tableName);
            actions.push({ type: 'create_table', detail: `Created table ${tableName}` });
            if (verbose) console.log(`  Created table: ${tableName}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            actions.push({ type: 'create_table', detail: `Failed to create ${tableName}: ${msg}` });
            if (verbose) console.warn(`  Could not create table ${tableName}: ${msg}`);
          }
        }
      } else if (recheck.missingTables.length === 0) {
        const allMissing = probe.missingTables.join(', ');
        actions.push({ type: 'run_migration', detail: `Created missing tables: ${allMissing}` });
      }
    }

    // 1b. Fix missing columns by running schema migrations (column-level drift)
    if (fixMissingTables && probe.missingColumns.length > 0) {
      const colDesc = probe.missingColumns.map((c) => `${c.table}.${c.column}`).join(', ');
      if (verbose) console.log(`Running schema migration to add missing columns (${colDesc})...`);
      try {
        await ensureSqliteSchema(raw).catch(() => {
          if (verbose) console.log('  Column migration completed with deferred warnings');
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (verbose) console.warn(`  Column migration warning: ${msg}`);
      }

      // Verify columns were added
      const recheck = await probeSchemaHealth();
      if (recheck.missingColumns.length === 0) {
        actions.push({ type: 'add_column', detail: `Added missing columns: ${colDesc}` });
      } else {
        const stillMissing = recheck.missingColumns.map((c) => `${c.table}.${c.column}`).join(', ');
        actions.push({ type: 'add_column', detail: `Some columns still missing after migration: ${stillMissing}` });
        if (verbose) console.warn(`  Still missing columns: ${stillMissing}`);
      }
    }

    // 1c. Run v1.5.0 backfill if columns were just added (backfill memory_places and memory_tags)
    if (actions.some(a => a.type === 'add_column' && a.detail.includes('primary_place'))) {
      try {
        const { backfillV1_5_0 } = await import('./backfill-v1.5.0.js');
        const result = await backfillV1_5_0();
        actions.push({ type: 'run_migration', detail: `Backfilled ${result.memoriesUpdated} memories, ${result.placesCreated} places, ${result.tagsCreated} tags` });
        if (verbose) console.log(`  Backfilled ${result.memoriesUpdated} memories for v1.5.0`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (verbose) console.warn(`  Backfill warning: ${msg}`);
      }
    }

    // 2. Fix missing indexes
    if (fixMissingIndexes && isSqlite) {
      const existingIndexes = raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
      const existingNames = new Set(existingIndexes.map(i => i.name));

      for (const idx of REQUIRED_INDEXES) {
        if (!existingNames.has(idx.name)) {
          try {
            raw.exec(idx.sql);
            actions.push({ type: 'create_index', detail: `Created index ${idx.name} on ${idx.table}`, target: idx.table });
            if (verbose) console.log(`  Created index: ${idx.name}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (verbose) console.warn(`  Could not create index ${idx.name}: ${msg}`);
          }
        }
      }
    }

    // 3. Fix FTS schema
    if (fixFts && isSqlite) {
      const ftsTable = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get() as { name: string } | undefined;
      if (!ftsTable) {
        try {
          // Check if memories table exists first
          const memTable = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get() as { name: string } | undefined;
          if (memTable) {
            // Recreate FTS using the same SQL from bootstrap
            raw.exec('DROP TRIGGER IF EXISTS memories_ai');
            raw.exec('DROP TRIGGER IF EXISTS memories_ad');
            raw.exec('DROP TRIGGER IF EXISTS memories_au');

            raw.exec(`
              CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                content,
                tags,
                summary,
                content='memories',
                content_rowid='rowid'
              );

              CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid, content, tags, summary)
                VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
              END;

              CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
                VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
              END;

              CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
                VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
                INSERT INTO memories_fts(rowid, content, tags, summary)
                VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
              END;
            `);

            actions.push({ type: 'repair_fts', detail: 'Recreated memories_fts table and triggers' });
            if (verbose) console.log('  Repaired FTS: recreated memories_fts table');
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (verbose) console.warn(`  Could not repair FTS: ${msg}`);
        }
      }

      // Also check messages_fts
      const msgFtsTable = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get() as { name: string } | undefined;
      if (!msgFtsTable) {
        try {
          const memTable = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as { name: string } | undefined;
          if (memTable) {
            raw.exec('DROP TRIGGER IF EXISTS messages_ai');
            raw.exec('DROP TRIGGER IF EXISTS messages_ad');
            raw.exec('DROP TRIGGER IF EXISTS messages_au');

            raw.exec(`
              CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                content,
                content='messages',
                content_rowid='rowid'
              );

              CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, content)
                VALUES (new.rowid, new.content);
              END;

              CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content)
                VALUES ('delete', old.rowid, old.content);
              END;

              CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content)
                VALUES ('delete', old.rowid, old.content);
                INSERT INTO messages_fts(rowid, content)
                VALUES (new.rowid, new.content);
              END;
            `);

            actions.push({ type: 'repair_fts', detail: 'Recreated messages_fts table and triggers' });
            if (verbose) console.log('  Repaired FTS: recreated messages_fts table');
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (verbose) console.warn(`  Could not repair messages FTS: ${msg}`);
        }
      }
    }

    // 4. Initialize default places if missing
    if (fixPlaces && isSqlite) {
      const placesTable = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='places'").get() as { name: string } | undefined;
      if (placesTable) {
        const count = raw.prepare('SELECT COUNT(*) as count FROM places').get() as { count: number };
        if (count.count === 0) {
          try {
            // Use dynamic import to avoid circular dependency
            const { initializeDefaultPlaces } = await import('../core/places/places.js');
            await initializeDefaultPlaces();
            actions.push({ type: 'init_places', detail: 'Initialized 7 default places' });
            if (verbose) console.log('  Initialized 7 default places');
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            actions.push({ type: 'init_places', detail: `Failed to initialize places: ${msg}` });
            if (verbose) console.warn(`  Could not initialize places: ${msg}`);
          }
        } else if (count.count < 7) {
          try {
            const { initializeDefaultPlaces } = await import('../core/places/places.js');
            const created = await initializeDefaultPlaces();
            actions.push({ type: 'init_places', detail: `Initialized remaining ${created.length} places` });
            if (verbose) console.log(`  Initialized remaining ${created.length} places`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (verbose) console.warn(`  Could not initialize remaining places: ${msg}`);
          }
        }
      }
    }

    // 5. Fix graph entity tables if missing
    if (fixGraphEntities && isSqlite) {
      const entityRelationsTable = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_relations'").get() as { name: string } | undefined;
      if (!entityRelationsTable) {
        try {
          // entities table should already exist if schema was bootstrapped
          raw.exec(`
            CREATE TABLE IF NOT EXISTS entity_relations (
              id TEXT PRIMARY KEY,
              from_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
              to_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
              type TEXT NOT NULL,
              weight INTEGER DEFAULT 1,
              properties TEXT,
              created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
            );
          `);
          raw.exec('CREATE INDEX IF NOT EXISTS relations_from_idx ON entity_relations(from_entity_id)');
          raw.exec('CREATE INDEX IF NOT EXISTS relations_to_idx ON entity_relations(to_entity_id)');
          raw.exec('CREATE INDEX IF NOT EXISTS relations_type_idx ON entity_relations(type)');

          actions.push({ type: 'create_entities_table', detail: 'Created entity_relations table and indexes' });
          if (verbose) console.log('  Created entity_relations table');
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          actions.push({ type: 'create_entities_table', detail: `Failed: ${msg}` });
          if (verbose) console.warn(`  Could not create entity_relations: ${msg}`);
        }
      }
    }

    // Re-probe and emit summary
    const recheck = await probeSchemaHealth();
    if (actions.length > 0 && verbose) {
      const statusIcon = recheck.status === 'ok' ? 'OK' : 'ISSUES REMAINING';
      console.log(`\nSchema health after fix: ${statusIcon}`);
      if (recheck.status !== 'ok' && recheck.detail) {
        console.log(`  ${recheck.detail}`);
      }
    }

    return actions;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (verbose) console.error(`Fix failed: ${msg}`);
    return actions;
  }
}
