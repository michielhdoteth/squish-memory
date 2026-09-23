/**
 * Migration Generator - Creates migrations from schema definitions
 * 
 * This utility generates ALTER TABLE statements from schema column definitions,
 * eliminating the need for inline column arrays in migration files.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../core/logger.js';

export interface ColumnDefinition {
  type: string;
  primary?: boolean;
  references?: string;
  default?: string;
  notNull?: boolean;
}

export interface IndexDefinition {
  name: string;
  columns: string[];
  using?: string;
  unique?: boolean;
}

export interface TableSchema {
  name: string;
  columns: Record<string, ColumnDefinition>;
  indexes?: IndexDefinition[];
}

/**
 * Whitelist of allowed table names in the Squish schema
 */
const ALLOWED_TABLE_NAMES = new Set([
  'users', 'projects', 'memories', 'places', 'place_rules',
  'memory_associations', 'memory_tags', 'embeddings', 'sessions',
  'session_signals', 'session_working_set', 'context_sessions',
  'context_paging', 'temporal_anchors', 'graph_nodes', 'graph_edges',
  'entities', 'entity_relations', 'beliefs', 'belief_edges',
  'belief_memory_sources', 'maintenance_jobs', 'maintenance_job_history',
  'telemetry_events', 'learnings', 'core_memory', 'conversations',
  'edit_proposals', 'merge_proposals', 'snapshots', 'summaries',
  'strategies', 'strategy_edges', 'strategy_belief_edges',
  'messages', 'namespaces', 'session_summaries',
  'knowledge', 'knowledge_edges',
  'teams', 'team_members', 'team_invitations', 'team_shares', 'team_memory',
  'agent_session_cache', 'agent_preferences',
]);

function sanitizeTableName(name: string): string {
  if (!ALLOWED_TABLE_NAMES.has(name)) {
    throw new Error(`Invalid table name: "${name}" (not in whitelist)`);
  }
  return name;
}

/**
 * Get existing columns for a table
 */
function getExistingColumns(sqlite: Database, tableName: string): Set<string> {
  try {
    const safeName = sanitizeTableName(tableName);
    const tableInfo = sqlite.prepare(`PRAGMA table_info(${safeName})`).all() as Array<{ name: string }>;
    return new Set(tableInfo.map(col => col.name));
  } catch {
    return new Set();
  }
}

/**
 * Get existing indexes for a table
 */
function getExistingIndexes(sqlite: Database, tableName: string): Set<string> {
  try {
    const indexes = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?"
    ).all(tableName) as Array<{ name: string }>;
    return new Set(indexes.map(idx => idx.name));
  } catch {
    return new Set();
  }
}

/**
 * Generate and run column migrations for a table schema
 */
export async function migrateTable(
  sqlite: Database,
  schema: TableSchema
): Promise<void> {
  const existingColumns = getExistingColumns(sqlite, schema.name);

  for (const [columnName, definition] of Object.entries(schema.columns)) {
    if (!existingColumns.has(columnName)) {
      const sql = generateAlterTable(schema.name, columnName, definition);
      try {
        sqlite.exec(sql);
        logger.info(`Migration: Added column ${columnName} to ${schema.name}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('duplicate column name')) {
          logger.debug(`Migration skipped for ${schema.name}.${columnName}: already exists`);
        } else {
          throw new Error(`Migration failed for ${schema.name}.${columnName}: ${msg}`);
        }
      }
    }
  }

  // Handle indexes
  if (schema.indexes) {
    await migrateIndexes(sqlite, schema.name, schema.indexes);
  }
}

/**
 * Generate and run index migrations
 */
export async function migrateIndexes(
  sqlite: Database,
  tableName: string,
  indexes: IndexDefinition[]
): Promise<void> {
  const existingIndexes = getExistingIndexes(sqlite, tableName);

  for (const indexDef of indexes) {
    if (!existingIndexes.has(indexDef.name)) {
      const sql = generateCreateIndex(tableName, indexDef);
      try {
        sqlite.exec(sql);
        logger.info(`Migration: Added index ${indexDef.name}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Index migration failed for ${indexDef.name}: ${msg}`);
      }
    }
  }
}

/**
 * Generate ALTER TABLE ADD COLUMN statement
 */
function generateAlterTable(
  tableName: string,
  columnName: string,
  definition: ColumnDefinition
): string {
  let sql = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition.type}`;

  if (definition.default) {
    sql += ` DEFAULT ${definition.default}`;
  }

  return sql;
}

/**
 * Generate CREATE INDEX statement
 */
function generateCreateIndex(
  tableName: string,
  indexDef: IndexDefinition
): string {
  const columns = indexDef.columns.join(', ');
  const unique = indexDef.unique ? 'UNIQUE ' : '';
  return `CREATE ${unique}INDEX IF NOT EXISTS ${indexDef.name} ON ${tableName}(${columns})`;
}

/**
 * Run all table migrations from schema list
 */
export async function runAllSchemaMigrations(
  sqlite: Database,
  schemas: TableSchema[]
): Promise<void> {
  for (const schema of schemas) {
    const tableCheck = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(schema.name) as { name: string } | undefined;

    if (tableCheck) {
      await migrateTable(sqlite, schema);
    }
  }
}