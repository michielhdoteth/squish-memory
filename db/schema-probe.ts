/**
 * Schema probing: health checks, drift detection, and diagnostic queries.
 *
 * This module inspects the database to determine whether required tables,
 * columns, and indexes exist. It never mutates schema state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../config.js';
import { getDb } from './index.js';
import { getRawClient, quoteIdent } from './utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const REQUIRED_TABLES = [
  'memories',
  'learnings',
  'projects',
  'users',
  'conversations',
  'messages',
  'entities',
  'entity_relations',
  'core_memory',
  'context_sessions',
  'memory_associations',
  'namespaces',
  'maintenance_jobs',
  'places',
  'memory_places',
  'place_rules',
  'session_summaries',
  'beliefs',
  'belief_memory_sources',
  'belief_edges',
  'knowledge',
  'knowledge_edges',
] as const;

export const REQUIRED_INDEXES = [
  { table: 'memories', name: 'memories_project_idx', sql: 'CREATE INDEX IF NOT EXISTS memories_project_idx ON memories(project_id)' },
  { table: 'memories', name: 'memories_type_idx', sql: 'CREATE INDEX IF NOT EXISTS memories_type_idx ON memories(type)' },
  { table: 'memories', name: 'memories_created_idx', sql: 'CREATE INDEX IF NOT EXISTS memories_created_idx ON memories(created_at)' },
  { table: 'memories', name: 'memories_tags_idx', sql: 'CREATE INDEX IF NOT EXISTS memories_tags_idx ON memories(tags)' },
  { table: 'conversations', name: 'conversations_project_idx', sql: 'CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations(project_id)' },
  { table: 'conversations', name: 'conversations_session_idx', sql: 'CREATE INDEX IF NOT EXISTS conversations_session_idx ON conversations(session_id)' },
  { table: 'learnings', name: 'learnings_project_idx', sql: 'CREATE INDEX IF NOT EXISTS learnings_project_idx ON learnings(project_id)' },
  { table: 'entities', name: 'entities_project_idx', sql: 'CREATE INDEX IF NOT EXISTS entities_project_idx ON entities(project_id)' },
  { table: 'places', name: 'places_project_idx', sql: 'CREATE INDEX IF NOT EXISTS places_project_idx ON places(project_id)' },
  { table: 'places', name: 'places_type_idx', sql: 'CREATE INDEX IF NOT EXISTS places_type_idx ON places(place_type)' },
  { table: 'entity_relations', name: 'relations_from_idx', sql: 'CREATE INDEX IF NOT EXISTS relations_from_idx ON entity_relations(from_entity_id)' },
  { table: 'entity_relations', name: 'relations_to_idx', sql: 'CREATE INDEX IF NOT EXISTS relations_to_idx ON entity_relations(to_entity_id)' },
  { table: 'entity_relations', name: 'relations_type_idx', sql: 'CREATE INDEX IF NOT EXISTS relations_type_idx ON entity_relations(type)' },
  { table: 'session_summaries', name: 'session_summaries_conversation_idx', sql: 'CREATE INDEX IF NOT EXISTS session_summaries_conversation_idx ON session_summaries(conversation_id)' },
  { table: 'session_summaries', name: 'session_summaries_project_idx', sql: 'CREATE INDEX IF NOT EXISTS session_summaries_project_idx ON session_summaries(project_id)' },
  { table: 'beliefs', name: 'beliefs_project_idx', sql: 'CREATE INDEX IF NOT EXISTS beliefs_project_idx ON beliefs(project_id)' },
  { table: 'beliefs', name: 'beliefs_type_idx', sql: 'CREATE INDEX IF NOT EXISTS beliefs_type_idx ON beliefs(belief_type)' },
  { table: 'belief_edges', name: 'belief_edges_from_idx', sql: 'CREATE INDEX IF NOT EXISTS belief_edges_from_idx ON belief_edges(from_belief_id)' },
  { table: 'belief_edges', name: 'belief_edges_to_idx', sql: 'CREATE INDEX IF NOT EXISTS belief_edges_to_idx ON belief_edges(to_belief_id)' },
  { table: 'memory_associations', name: 'associations_graph_traversal_idx', sql: 'CREATE INDEX IF NOT EXISTS associations_graph_traversal_idx ON memory_associations(from_memory_id, to_memory_id, weight, association_type)' },
  { table: 'maintenance_jobs', name: 'maintenance_jobs_name_idx', sql: 'CREATE INDEX IF NOT EXISTS maintenance_jobs_name_idx ON maintenance_jobs(job_name)' },
  { table: 'maintenance_jobs', name: 'maintenance_jobs_next_run_idx', sql: 'CREATE INDEX IF NOT EXISTS maintenance_jobs_next_run_idx ON maintenance_jobs(next_run_at)' },
  { table: 'core_memory', name: 'core_memory_project_idx', sql: 'CREATE INDEX IF NOT EXISTS core_memory_project_idx ON core_memory(project_id)' },
  { table: 'context_sessions', name: 'context_sessions_session_idx', sql: 'CREATE INDEX IF NOT EXISTS context_sessions_session_idx ON context_sessions(session_id)' },
  { table: 'namespaces', name: 'namespaces_project_idx', sql: 'CREATE INDEX IF NOT EXISTS namespaces_project_idx ON namespaces(project_id)' },
  { table: 'place_rules', name: 'place_rules_project_idx', sql: 'CREATE INDEX IF NOT EXISTS place_rules_project_idx ON place_rules(project_id)' },
  { table: 'projects', name: 'projects_path_idx', sql: 'CREATE INDEX IF NOT EXISTS projects_path_idx ON projects(path)' },
] as const;

/**
 * Critical columns that must exist on existing tables.
 * Used by probeSchemaHealth() to detect column-level drift.
 * When these are missing, squish doctor --fix will trigger migration.
 */
export const REQUIRED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'memories', column: 'primary_place' },
  { table: 'memories', column: 'memory_type' },
  { table: 'memories', column: 'media_type' },
  { table: 'memories', column: 'media_path' },
  { table: 'memories', column: 'media_metadata' },
  { table: 'memories', column: 'embedding_blob' },
  { table: 'memories', column: 'embedding_model' },
  { table: 'memories', column: 'embedding_dim' },
  { table: 'memories', column: 'sector' },
  { table: 'memories', column: 'valid_from' },
  { table: 'memories', column: 'recorded_at' },
];

// ─── Types ───────────────────────────────────────────────────────────────────

export type SchemaProbeStatus = 'ok' | 'drifted' | 'unavailable';

export interface SchemaProbeResult {
  status: SchemaProbeStatus;
  backend: string;
  dataDir?: string;
  dbPath?: string;
  detail: string;
  remediation: string | null;
  missingTables: string[];
  missingColumns: Array<{ table: string; column: string }>;
}

export interface CheckResult {
  name: string;
  status: 'ok' | 'degraded' | 'broken';
  message: string;
}

// ─── Error ───────────────────────────────────────────────────────────────────

export class SchemaDriftError extends Error {
  readonly probe: SchemaProbeResult;

  constructor(probe: SchemaProbeResult) {
    super(formatSchemaProbeMessage(probe));
    this.name = 'SchemaDriftError';
    this.probe = probe;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLocalDbPath(): string {
  return path.join(getDataDir(), 'squish.db');
}

export function getSchemaRemediationCommand(): string {
  return 'squish doctor --migrate';
}

export function formatSchemaProbeMessage(probe: SchemaProbeResult): string {
  const location = probe.dbPath
    ? ` (${probe.dbPath})`
    : probe.dataDir
      ? ` (${probe.dataDir})`
      : '';
  const remediation = probe.remediation ? ` Run \`${probe.remediation}\`.` : '';
  return `Schema drift detected for ${probe.backend}${location}: ${probe.detail}.${remediation}`.trim();
}

export function isSchemaDriftError(error: unknown): error is SchemaDriftError {
  return error instanceof SchemaDriftError;
}

async function listExistingTables(db: any): Promise<string[]> {
  const raw = getRawClient(db);

  if (raw && typeof raw.prepare === 'function') {
    const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  throw new Error('Unable to inspect database schema - unsupported driver');
}

/**
 * List column names for a given table.
 * Uses PRAGMA table_info() for SQLite.
 */
async function listTableColumns(db: any, tableName: string): Promise<string[]> {
  const raw = getRawClient(db);

  if (raw && typeof raw.prepare === 'function') {
    const rows = raw.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  return [];
}

// ─── Probe ───────────────────────────────────────────────────────────────────

/**
 * Probe the database schema for missing tables and columns.
 * Returns a result indicating whether the schema is OK, drifted, or unavailable.
 */
export async function probeSchemaHealth(): Promise<SchemaProbeResult> {
  const backend = 'local:sqlite';
  const remediation = getSchemaRemediationCommand();

  const dbPath = getLocalDbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      status: 'ok',
      backend,
      dataDir: getDataDir(),
      dbPath,
      detail: 'Local database has not been created yet',
      remediation: null,
      missingTables: [],
      missingColumns: [],
    };
  }

  let db: any;
  try {
    db = await getDb();
  } catch (error) {
    return {
      status: 'unavailable',
      backend,
      dataDir: getDataDir(),
      dbPath,
      detail: error instanceof Error ? error.message : 'Database initialization failed',
      remediation,
      missingTables: [],
      missingColumns: [],
    };
  }

  try {
    const existingTables = await listExistingTables(db);
    const missingTables = REQUIRED_TABLES.filter((table) => !existingTables.includes(table));

    if (missingTables.length > 0) {
      return {
        status: 'drifted',
        backend,
        dataDir: getDataDir(),
        dbPath,
        detail: `Missing required tables: ${missingTables.join(', ')}`,
        remediation,
        missingTables: [...missingTables],
        missingColumns: [],
      };
    }

    // Check for missing columns on existing tables (column-level drift)
    const missingColumns: Array<{ table: string; column: string }> = [];
    for (const req of REQUIRED_COLUMNS) {
      if (existingTables.includes(req.table)) {
        const columns = await listTableColumns(db, req.table);
        if (!columns.includes(req.column)) {
          missingColumns.push({ table: req.table, column: req.column });
        }
      }
    }

    if (missingColumns.length > 0) {
      const desc = missingColumns.map((c) => `${c.table}.${c.column}`).join(', ');
      return {
        status: 'drifted',
        backend,
        dataDir: getDataDir(),
        dbPath,
        detail: `Missing required columns: ${desc}`,
        remediation,
        missingTables: [],
        missingColumns,
      };
    }

    return {
      status: 'ok',
      backend,
      dataDir: getDataDir(),
      dbPath,
      detail: `Schema ready with ${existingTables.length} tables`,
      remediation: null,
      missingTables: [],
      missingColumns: [],
    };
  } catch (error) {
    return {
      status: 'unavailable',
      backend,
      dataDir: getDataDir(),
      dbPath,
      detail: error instanceof Error ? error.message : 'Schema inspection failed',
      remediation,
      missingTables: [],
      missingColumns: [],
    };
  }
}

/**
 * Assert that the schema is ready (no drift). Throws SchemaDriftError if drifted.
 */
export async function assertSchemaReady(): Promise<void> {
  const probe = await probeSchemaHealth();
  if (probe.status === 'drifted') {
    throw new SchemaDriftError(probe);
  }
}

// ─── Check functions ─────────────────────────────────────────────────────────

/**
 * Check if the entity_relations table exists
 */
export async function checkGraphEntitiesTable(): Promise<CheckResult> {
  try {
    const db = await getDb();
    const raw = getRawClient(db);

    if (raw && typeof raw.prepare === 'function') {
      const table = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_relations'").get() as { name: string } | undefined;
      if (!table) {
        return { name: 'graph entities table', status: 'degraded', message: 'entity_relations table is missing (needs schema migration)' };
      }
      // Check entities table too
      const entitiesTable = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'").get() as { name: string } | undefined;
      if (!entitiesTable) {
        return { name: 'graph entities table', status: 'degraded', message: 'entities table is missing' };
      }
      return { name: 'graph entities table', status: 'ok', message: 'entities and entity_relations tables exist' };
    }

    return { name: 'graph entities table', status: 'degraded', message: 'Cannot inspect graph entities - unsupported database driver' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name: 'graph entities table', status: 'degraded', message: `Cannot check graph entities: ${msg}` };
  }
}

/**
 * Check if the 7 default places have been initialized
 */
export async function checkPlacesInitialization(): Promise<CheckResult> {
  try {
    const db = await getDb();
    const raw = getRawClient(db);

    if (raw && typeof raw.prepare === 'function') {
      // Check if places table exists
      const placesTable = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='places'").get() as { name: string } | undefined;
      if (!placesTable) {
        return { name: 'places initialization', status: 'degraded', message: 'places table does not exist (needs schema migration)' };
      }

      const count = raw.prepare('SELECT COUNT(*) as count FROM places').get() as { count: number };
      if (count.count === 0) {
        return { name: 'places initialization', status: 'degraded', message: 'No places have been initialized yet' };
      }
      if (count.count < 7) {
        return { name: 'places initialization', status: 'degraded', message: `Only ${count.count}/7 default places exist` };
      }
      return { name: 'places initialization', status: 'ok', message: `All 7 default places initialized (${count.count} total)` };
    }

    return { name: 'places initialization', status: 'degraded', message: 'Cannot inspect places - unsupported database driver' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name: 'places initialization', status: 'degraded', message: `Cannot check places: ${msg}` };
  }
}

/**
 * Check if consolidation state (geometry tables) are ready
 */
export async function checkConsolidationState(result?: CheckResult): Promise<CheckResult> {
  try {
    const db = await getDb();
    const raw = getRawClient(db);

    if (raw && typeof raw.prepare === 'function') {
      // Check that key tables for consolidation exist
      const requiredForConsolidation = ['memories', 'memory_associations'];
      const missing: string[] = [];
      for (const tableName of requiredForConsolidation) {
        const table = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as { name: string } | undefined;
        if (!table) missing.push(tableName);
      }

      if (missing.length > 0) {
        return { name: 'consolidation state', status: 'degraded', message: `Consolidation tables missing: ${missing.join(', ')}` };
      }

      // Check for geometry-related FTS capabilities
      const ftsTable = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get() as { name: string } | undefined;
      const ftsStatus = ftsTable ? 'FTS available' : 'FTS not available for consolidation';

      return { name: 'consolidation state', status: 'ok', message: `Consolidation pipeline ready (${ftsStatus})` };
    }

    return { name: 'consolidation state', status: 'degraded', message: 'Cannot check consolidation state - unsupported database driver' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name: 'consolidation state', status: 'degraded', message: `Cannot check consolidation state: ${msg}` };
  }
}

/**
 * Check if memory_versions table exists (if versioning is used)
 */
export async function checkMemoryVersionsTable(): Promise<CheckResult> {
  try {
    const db = await getDb();
    const raw = getRawClient(db);

    if (raw && typeof raw.prepare === 'function') {
      const table = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_versions'").get() as { name: string } | undefined;
      if (!table) {
        // Versioning is optional; memories table itself has version column
        return { name: 'memory versions table', status: 'ok', message: 'Memory versioning uses built-in version column in memories table' };
      }
      return { name: 'memory versions table', status: 'ok', message: 'memory_versions table exists' };
    }

    return { name: 'memory versions table', status: 'ok', message: 'Cannot inspect - assuming ok for non-sqlite' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name: 'memory versions table', status: 'degraded', message: `Cannot check memory versions: ${msg}` };
  }
}
