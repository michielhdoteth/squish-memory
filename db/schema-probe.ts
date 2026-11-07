/**
 * Schema probing: health checks, drift detection, and diagnostic queries.
 *
 * This module inspects the database to determine whether required tables,
 * columns, and indexes exist. It never mutates schema state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../config.js';
import { openReadOnlySqlite } from './adapter.js';
import type { ReadOnlySqliteDatabase } from './adapter.js';
import { normalizeIndexSql, quoteIdent } from './utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const REQUIRED_TABLES = [
  'memories',
  'learnings',
  'projects',
  'users',
  'conversations',
  'messages',
  'entities',
  'core_memory',
  'context_sessions',
  'memory_edit_proposals',
  'memory_snapshots',
  'namespaces',
  'maintenance_jobs',
  'maintenance_job_history',
  'memory_feedback',
  'places',
  'place_rules',
  'session_summaries',
  'knowledge',
  'knowledge_edges',
  'trust_audit_log',
] as const;

export const REQUIRED_INDEXES = [
  { table: 'knowledge_edges', name: 'knowledge_edges_valid_time_idx', sql: 'CREATE INDEX IF NOT EXISTS knowledge_edges_valid_time_idx ON knowledge_edges(valid_from, valid_to, recorded_at, recorded_to)' },
  { table: 'memories', name: 'memories_project_idx', sql: 'CREATE INDEX IF NOT EXISTS memories_project_idx ON memories(project_id)' },
  { table: 'memories', name: 'memories_valid_from_idx', sql: 'CREATE INDEX IF NOT EXISTS memories_valid_from_idx ON memories(valid_from)' },
  { table: 'memories', name: 'memories_type_idx', sql: 'CREATE INDEX IF NOT EXISTS memories_type_idx ON memories(type)' },
  { table: 'memories', name: 'memories_created_idx', sql: 'CREATE INDEX IF NOT EXISTS memories_created_idx ON memories(created_at)' },
  { table: 'memories', name: 'memories_tags_idx', sql: 'CREATE INDEX IF NOT EXISTS memories_tags_idx ON memories(tags)' },
  { table: 'conversations', name: 'conversations_project_idx', sql: 'CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations(project_id)' },
  { table: 'conversations', name: 'conversations_session_idx', sql: 'CREATE INDEX IF NOT EXISTS conversations_session_idx ON conversations(session_id)' },
  { table: 'learnings', name: 'learnings_project_idx', sql: 'CREATE INDEX IF NOT EXISTS learnings_project_idx ON learnings(project_id)' },
  { table: 'entities', name: 'entities_project_idx', sql: 'CREATE INDEX IF NOT EXISTS entities_project_idx ON entities(project_id)' },
  { table: 'places', name: 'places_project_idx', sql: 'CREATE INDEX IF NOT EXISTS places_project_idx ON places(project_id)' },
  { table: 'places', name: 'places_type_idx', sql: 'CREATE INDEX IF NOT EXISTS places_type_idx ON places(place_type)' },
  { table: 'session_summaries', name: 'session_summaries_conversation_idx', sql: 'CREATE INDEX IF NOT EXISTS session_summaries_conversation_idx ON session_summaries(conversation_id)' },
  { table: 'session_summaries', name: 'session_summaries_project_idx', sql: 'CREATE INDEX IF NOT EXISTS session_summaries_project_idx ON session_summaries(project_id)' },
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
  // rememberMemory always includes team_id in its insert shape (NULL for
  // personal memories). Omitting this from drift detection made older global
  // databases fail their first write with "no column named team_id".
  { table: 'memories', column: 'team_id' },
  ...['valid_from', 'valid_to', 'recorded_at', 'recorded_to'].map((column) => ({ table: 'knowledge_edges', column })),
  // Knowledge is the MCP's unified search corpus. These columns participate in
  // the normal write/retrieval contract and must be migration-checked on
  // existing databases, where CREATE TABLE IF NOT EXISTS is not sufficient.
  ...[
    'embedding_blob', 'embedding_model', 'embedding_dim', 'evidence', 'version',
    'is_private', 'is_protected', 'is_pinned', 'is_immutable', 'write_scope', 'read_scope',
    'scope', 'visibility_scope', 'actor_user', 'actor_agent', 'agent_role', 'triggered_by',
    'capture_reason', 'valid_from', 'valid_to', 'recorded_at', 'access_count',
    'last_accessed_at', 'is_merged', 'merged_into_id', 'merged_at', 'consolidated_from',
    'consolidated_at', 'is_consolidated', 'encrypted_content', 'encryption_nonce',
    'is_encrypted', 'compression_level', 'relevance_score', 'tokens_estimate', 'decay_rate',
    'coactivation_score', 'last_decay_at', 'has_l0_abstract', 'has_l1_overview',
    'last_layer_update', 'media_type', 'media_path', 'media_metadata', 'namespace_id',
    'namespace_path', 'employee_id',
  ].map((column) => ({ table: 'knowledge', column })),
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
  // drizzle-orm 0.45.x emits EVERY declared column in an INSERT column list
  // and selects all of them for a field-less `select()`. One declared column
  // with no physical counterpart therefore breaks every read and write on the
  // table while this probe still reported `ok` - that is how
  // `maintenance_job_history` silently discarded 100% of job history.
  //
  // These entries pin the physical column set of the two tables that drifted,
  // taken from the DDL in db/bootstrap.ts. IMPORTANT: never list a column here
  // that the DDL does not create - doing so makes every correctly bootstrapped
  // database report `drifted` and blocks every MCP tool. `namespaces.type` and
  // `maintenance_job_history.created_at` were drizzle-only and were REMOVED
  // from db/drizzle/schema-sqlite.ts rather than added here; the guard for that
  // direction lives in tests/db/drizzle-ddl-consistency.test.ts.
  ...[
    'job_id', 'started_at', 'completed_at', 'duration',
    'status', 'error', 'records_processed', 'result_summary',
  ].map((column) => ({ table: 'maintenance_job_history', column })),
  ...[
    'project_id', 'name', 'path', 'description', 'parent_id',
    'created_at', 'updated_at',
  ].map((column) => ({ table: 'namespaces', column })),
  // memory_feedback is written on every squish_feedback session
  // (core/memory/feedback-tracker.ts) and read by core/scheduler/job-runner.ts.
  // It had no bootstrap DDL at all, so every write failed with `no such table`
  // while this probe reported `ok`. Listed from the DDL in db/bootstrap.ts.
  ...[
    'id', 'memory_id', 'session_id', 'conversation_id', 'was_injected',
    'was_referenced', 'reference_count', 'retrieval_priority_delta',
    'injected_at', 'referenced_at', 'created_at',
  ].map((column) => ({ table: 'memory_feedback', column })),
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
  indexIssues: Array<{ name: string; reason: 'missing' | 'definition_mismatch' }>;
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
    super(formatProbeMsg(probe));
    this.name = 'SchemaDriftError';
    this.probe = probe;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLocalDbPath(): string {
  return path.join(getDataDir(), 'squish.db');
}

export function schemaRemedyCmd(): string {
  return 'squish doctor --migrate';
}

export function formatProbeMsg(probe: SchemaProbeResult): string {
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

async function listExistingTables(db: ReadOnlySqliteDatabase): Promise<string[]> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * List column names for a given table.
 * Uses PRAGMA table_info() for SQLite.
 */
async function listTableColumns(db: ReadOnlySqliteDatabase, tableName: string): Promise<string[]> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

async function withReadOnlyDb<T>(fn: (db: ReadOnlySqliteDatabase) => Promise<T> | T): Promise<T> {
  const db = await openReadOnlySqlite(getLocalDbPath());
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

// ─── Probe ───────────────────────────────────────────────────────────────────

/**
 * Probe the database schema for missing tables and columns.
 * Returns a result indicating whether the schema is OK, drifted, or unavailable.
 */
export async function probeSchemaHealth(): Promise<SchemaProbeResult> {
  const backend = 'local:sqlite';
  const remediation = schemaRemedyCmd();

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
      indexIssues: [],
    };
  }

  let db: Awaited<ReturnType<typeof openReadOnlySqlite>>;
  try {
    db = await openReadOnlySqlite(dbPath);
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
      indexIssues: [],
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
        indexIssues: [],
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
        indexIssues: [],
      };
    }

    const installedIndexes = new Map((db.prepare(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index'",
    ).all() as Array<{ name: string; tbl_name: string; sql: string | null }>).map((index) => [index.name, index]));
    const indexIssues: SchemaProbeResult['indexIssues'] = [];
    for (const required of REQUIRED_INDEXES) {
      const installed = installedIndexes.get(required.name);
      if (!installed) {
        indexIssues.push({ name: required.name, reason: 'missing' });
      } else if (installed.tbl_name !== required.table
        || typeof installed.sql !== 'string'
        || normalizeIndexSql(installed.sql) !== normalizeIndexSql(required.sql)) {
        indexIssues.push({ name: required.name, reason: 'definition_mismatch' });
      }
    }

    if (indexIssues.length > 0) {
      const detail = indexIssues.map(({ name, reason }) => `${name} (${reason === 'missing' ? 'missing' : 'definition mismatch'})`).join(', ');
      return {
        status: 'drifted',
        backend,
        dataDir: getDataDir(),
        dbPath,
        detail: `Required indexes need repair: ${detail}`,
        remediation,
        missingTables: [],
        missingColumns: [],
        indexIssues,
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
      indexIssues: [],
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
      indexIssues: [],
    };
  } finally {
    db.close();
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
 * Check the canonical entity and temporal edge stores.
 */
export async function checkGraphEntitiesTable(): Promise<CheckResult> {
  try {
    return await withReadOnlyDb((db) => {
      const entitiesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'").get() as { name: string } | undefined;
      if (!entitiesTable) {
        return { name: 'graph entities table', status: 'degraded', message: 'entities table is missing' };
      }
      const edgesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_edges'").get() as { name: string } | undefined;
      if (!edgesTable) {
        return { name: 'graph entities table', status: 'degraded', message: 'knowledge_edges table is missing' };
      }
      return { name: 'graph entities table', status: 'ok', message: 'canonical entities and knowledge_edges tables exist' };
    });
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
    return await withReadOnlyDb((db) => {
      // Check if places table exists
      const placesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='places'").get() as { name: string } | undefined;
      if (!placesTable) {
        return { name: 'places initialization', status: 'degraded', message: 'places table does not exist (needs schema migration)' };
      }

      const count = db.prepare('SELECT COUNT(*) as count FROM places').get() as { count: number };
      if (count.count === 0) {
        return { name: 'places initialization', status: 'degraded', message: 'No places have been initialized yet' };
      }
      if (count.count < 7) {
        return { name: 'places initialization', status: 'degraded', message: `Only ${count.count}/7 default places exist` };
      }
      return { name: 'places initialization', status: 'ok', message: `All 7 default places initialized (${count.count} total)` };
    });
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
    return await withReadOnlyDb((db) => {
      // Check that key tables for consolidation exist
      const requiredForConsolidation = ['memories', 'knowledge_edges'];
      const missing: string[] = [];
      for (const tableName of requiredForConsolidation) {
        const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as { name: string } | undefined;
        if (!table) missing.push(tableName);
      }

      if (missing.length > 0) {
        return { name: 'consolidation state', status: 'degraded', message: `Consolidation tables missing: ${missing.join(', ')}` };
      }

      // Check for geometry-related FTS capabilities
      const ftsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get() as { name: string } | undefined;
      const ftsStatus = ftsTable ? 'FTS available' : 'FTS not available for consolidation';

      return { name: 'consolidation state', status: 'ok', message: `Consolidation pipeline ready (${ftsStatus})` };
    });
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
    return await withReadOnlyDb((db) => {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_versions'").get() as { name: string } | undefined;
      if (!table) {
        // Versioning is optional; memories table itself has version column
        return { name: 'memory versions table', status: 'ok', message: 'Memory versioning uses built-in version column in memories table' };
      }
      return { name: 'memory versions table', status: 'ok', message: 'memory_versions table exists' };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name: 'memory versions table', status: 'degraded', message: `Cannot check memory versions: ${msg}` };
  }
}
