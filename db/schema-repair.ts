/**
 * Schema repair: auto-fix detected schema issues.
 *
 * This module contains fixSchemaIssues(), which probes the current schema
 * state and applies targeted repairs (missing tables, indexes, FTS, places).
 * It never probes without repairing.
 */

import { getDb } from './index.js';
import { config } from '../config.js';
import { ensureSqliteSchema } from './bootstrap.js';
import { getRawClient, normalizeIndexSql } from './utils.js';
import { probeSchemaHealth, REQUIRED_INDEXES } from './schema-probe.js';
import { createSingleTable } from './schema-ddl.js';
import { runKnowledgeMigrations } from './migrations/knowledge.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RepairAction {
  type: 'create_table' | 'create_index' | 'add_column' | 'repair_fts' | 'repair_projection' | 'init_places' | 'run_migration' | 'rebuild_schema';
  detail: string;
  target?: string;
}

export interface FixOptions {
  fixMissingTables?: boolean;
  fixMissingIndexes?: boolean;
  fixFts?: boolean;
  fixProjections?: boolean;
  fixPlaces?: boolean;
  fixAll?: boolean;
  verbose?: boolean;
}

interface FtsTriggerDefinition {
  name: string;
  sql: string;
}

const MEMORY_FTS_TRIGGERS: readonly FtsTriggerDefinition[] = [
  {
    name: 'memories_ai',
    sql: `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags, summary)
      VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
    END;`,
  },
  {
    name: 'memories_ad',
    sql: `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
      VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
    END;`,
  },
  {
    name: 'memories_au',
    sql: `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
      VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
      INSERT INTO memories_fts(rowid, content, tags, summary)
      VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
    END;`,
  },
];

const MESSAGE_FTS_TRIGGERS: readonly FtsTriggerDefinition[] = [
  {
    name: 'messages_ai',
    sql: `CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;`,
  },
  {
    name: 'messages_ad',
    sql: `CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;`,
  },
  {
    name: 'messages_au',
    sql: `CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;`,
  },
];

function ensureFtsTriggers(
  raw: { prepare: (sql: string) => { all: (...parameters: unknown[]) => unknown[]; get: (...parameters: unknown[]) => unknown }; exec: (sql: string) => void },
  sourceTable: string,
  ftsTable: string,
  required: readonly FtsTriggerDefinition[],
): string[] {
  const tableExists = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  if (!tableExists.get(sourceTable) || !tableExists.get(ftsTable)) return [];
  const existing = new Map((raw.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?",
  ).all(sourceTable) as Array<{ name: string; sql: string | null }>).map((trigger) => [trigger.name, trigger.sql ?? '']));
  const normalizeSql = (sql: string): string => sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/i, '')
    .replace(/["`\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .replace(/;+$/, '')
    .trim()
    .toLowerCase();
  const repairs = required.filter((trigger) => {
    const installedSql = existing.get(trigger.name);
    return installedSql === undefined || normalizeSql(installedSql) !== normalizeSql(trigger.sql);
  });
  if (repairs.length === 0) return [];

  raw.exec('SAVEPOINT repair_fts_triggers');
  try {
    for (const trigger of repairs) {
      if (existing.has(trigger.name)) raw.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      raw.exec(trigger.sql);
    }
    raw.exec('RELEASE SAVEPOINT repair_fts_triggers');
  } catch (error) {
    raw.exec('ROLLBACK TO SAVEPOINT repair_fts_triggers');
    raw.exec('RELEASE SAVEPOINT repair_fts_triggers');
    throw error;
  }
  return repairs.map((trigger) => trigger.name);
}

function countMemoriesWithoutProjection(raw: { prepare: (sql: string) => { get: (...parameters: unknown[]) => unknown } }): number {
  const result = raw.prepare(`
    SELECT COUNT(*) AS count FROM memories m
    WHERE NOT EXISTS (
      SELECT 1 FROM knowledge k
      WHERE k.id = m.id
         OR json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.sourceMemoryId') = m.id
         OR (
           json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey') IS NOT NULL
           AND json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey')
               = json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey')
         )
    )
  `).get() as { count: number } | undefined;
  return Number(result?.count ?? 0);
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
  const fixProjections = options.fixProjections ?? fixAll;
  const fixPlaces = options.fixPlaces ?? fixAll;

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

    const isSqlite = config.isLocalMode && typeof raw.prepare === 'function';

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

    // 1c. Run v1.5.0 backfill if columns were just added (canonical place edges and memory_tags)
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

    // A schema can be healthy while a source memory has lost its canonical
    // knowledge projection (for example, after restoring an older database).
    // The idempotent knowledge migration reconstructs only missing projections
    // and also reapplies the encrypted-derivative scrub boundary.
    if (fixProjections && isSqlite
      && raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get()
      && raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge'").get()) {
      const missing = countMemoriesWithoutProjection(raw);
      if (missing > 0) {
        try {
          await runKnowledgeMigrations(raw as unknown as import('better-sqlite3').Database);
          const remaining = countMemoriesWithoutProjection(raw);
          if (remaining > 0) throw new Error(`Knowledge migration left ${remaining} memories without a canonical projection`);
          actions.push({ type: 'repair_projection', detail: `Rebuilt missing canonical projections for ${missing} source memories` });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          actions.push({ type: 'repair_projection', detail: `Failed to rebuild missing canonical projections: ${msg}` });
          if (verbose) console.warn(`  Could not repair memory projections: ${msg}`);
        }
      }
    }

    // 2. Fix missing indexes
    if (fixMissingIndexes && isSqlite) {
      const existingIndexes = raw.prepare(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index'",
      ).all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
      const existingByName = new Map(existingIndexes.map((index) => [index.name, index]));

      for (const idx of REQUIRED_INDEXES) {
        const installed = existingByName.get(idx.name);
        const isCorrect = installed?.tbl_name === idx.table
          && typeof installed.sql === 'string'
          && normalizeIndexSql(installed.sql) === normalizeIndexSql(idx.sql);
        if (!isCorrect) {
          const repairSavepoint = `repair_required_index_${idx.name}`;
          try {
            raw.exec(`SAVEPOINT ${repairSavepoint}`);
            if (installed) raw.exec(`DROP INDEX ${idx.name}`);
            raw.exec(idx.sql);
            raw.exec(`RELEASE SAVEPOINT ${repairSavepoint}`);
            actions.push({
              type: 'create_index',
              detail: `${installed ? 'Repaired' : 'Created'} index ${idx.name} on ${idx.table}`,
              target: idx.table,
            });
            if (verbose) console.log(`  ${installed ? 'Repaired' : 'Created'} index: ${idx.name}`);
          } catch (error) {
            try {
              raw.exec(`ROLLBACK TO SAVEPOINT ${repairSavepoint}`);
              raw.exec(`RELEASE SAVEPOINT ${repairSavepoint}`);
            } catch {
              // Preserve the original repair error if rollback itself fails.
            }
            const msg = error instanceof Error ? error.message : String(error);
            if (verbose) console.warn(`  Could not repair index ${idx.name}: ${msg}`);
          }
        }
      }
    }

    // 3. Fix and rebuild FTS content index. External-content FTS can have a
    // healthy schema and broken postings after interrupted/manual writes.
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
                content_rowid='rowid',
                tokenize='porter unicode61'
              );
              INSERT INTO memories_fts(memories_fts, rank) VALUES('rank', 'bm25(1.0, 2.0, 3.0)');

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

      const missingMemoryTriggers = ensureFtsTriggers(raw, 'memories', 'memories_fts', MEMORY_FTS_TRIGGERS);
      if (missingMemoryTriggers.length > 0) {
        actions.push({ type: 'repair_fts', detail: `Restored missing memories FTS triggers: ${missingMemoryTriggers.join(', ')}` });
        if (verbose) console.log(`  Repaired memories FTS triggers: ${missingMemoryTriggers.join(', ')}`);
      }

      const missingMessageTriggers = ensureFtsTriggers(raw, 'messages', 'messages_fts', MESSAGE_FTS_TRIGGERS);
      if (missingMessageTriggers.length > 0) {
        actions.push({ type: 'repair_fts', detail: `Restored missing messages FTS triggers: ${missingMessageTriggers.join(', ')}` });
        if (verbose) console.log(`  Repaired messages FTS triggers: ${missingMessageTriggers.join(', ')}`);
      }

      const ftsHealthy = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
      if (ftsHealthy) {
        let postingsValid = false;
        try {
          // rank=1 asks FTS5 to compare external-content rows to its postings.
          raw.exec("INSERT INTO memories_fts(memories_fts, rank) VALUES('integrity-check', 1)");
          postingsValid = true;
        } catch {
          postingsValid = false;
        }
        if (!postingsValid) {
          try {
            raw.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
            actions.push({ type: 'repair_fts', detail: 'Rebuilt memories_fts postings from canonical memories rows' });
            if (verbose) console.log('  Rebuilt memories_fts postings');
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            actions.push({ type: 'repair_fts', detail: `Failed to rebuild memories_fts: ${msg}` });
            if (verbose) console.warn(`  Could not rebuild memories FTS postings: ${msg}`);
          }
        }
      }

      const messagesFtsHealthy = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get();
      if (messagesFtsHealthy) {
        let postingsValid = false;
        try {
          raw.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
          postingsValid = true;
        } catch {
          postingsValid = false;
        }
        if (!postingsValid) {
          try {
            raw.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
            actions.push({ type: 'repair_fts', detail: 'Rebuilt messages_fts postings from canonical message rows' });
            if (verbose) console.log('  Rebuilt messages FTS postings');
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            actions.push({ type: 'repair_fts', detail: `Failed to rebuild messages_fts: ${msg}` });
            if (verbose) console.warn(`  Could not rebuild messages FTS postings: ${msg}`);
          }
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
