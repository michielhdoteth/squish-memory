/**
 * Regression guard: the drift detector must cover the tables whose DDL and
 * drizzle declaration previously disagreed.
 *
 * `REQUIRED_TABLES` had no entry for `maintenance_job_history` and
 * `REQUIRED_COLUMNS` had none for it or for `namespaces`, which is exactly why
 * `probeSchemaHealth()` could return `status: "ok"` while every insert and
 * select on those tables threw `no column named ...`.
 *
 * The lists must also stay derived from the DDL: an entry for a column no
 * `CREATE TABLE` produces would make every correctly bootstrapped database
 * report `drifted` and block every MCP tool.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';

import { probeSchemaHealth, REQUIRED_TABLES, REQUIRED_COLUMNS } from '../../db/schema-probe.js';
import { closeAllDbs, resetDb } from '../../db/index.js';

const testDataDir = join(
  tmpdir(),
  `squish-probe-required-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;

/**
 * The physical `memory_feedback` column set, read from the CREATE TABLE in
 * db/bootstrap.ts. Asserted against a bootstrapped database so the probe entry
 * can never name a column the DDL does not create.
 */
const MEMORY_FEEDBACK_DDL_COLUMNS = [
  'id',
  'memory_id',
  'session_id',
  'conversation_id',
  'was_injected',
  'was_referenced',
  'reference_count',
  'retrieval_priority_delta',
  'injected_at',
  'referenced_at',
  'created_at',
] as const;

/**
 * Boot db/bootstrap.ts into its own throwaway file and return what it created.
 * Kept in one place so every DDL assertion in this file runs against a schema
 * built only from the bootstrap DDL, never from a mutated shared database.
 */
async function bootstrapAuditDb(label: string): Promise<{
  tables: Set<string>;
  columns: Map<string, Set<string>>;
}> {
  const ddlDir = join(testDataDir, label);
  if (!existsSync(ddlDir)) mkdirSync(ddlDir, { recursive: true });

  const BunSqlite = (await import('bun:sqlite')).default;
  const raw = new BunSqlite(join(ddlDir, 'audit.db'));
  raw.exec('PRAGMA foreign_keys = OFF');
  const { ensureSqliteSchema } = await import('../../db/bootstrap.js');
  await ensureSqliteSchema(raw as never);

  const tableRows = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;
  const tables = new Set(tableRows.map((row) => row.name));
  const columns = new Map<string, Set<string>>();
  for (const table of tables) {
    const columnRows = raw.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string;
    }>;
    columns.set(table, new Set(columnRows.map((row) => row.name)));
  }
  raw.close();
  return { tables, columns };
}

async function bootstrappedColumnsOf(table: string): Promise<Set<string>> {
  const audit = await bootstrapAuditDb(`ddl-audit-${table}`);
  return audit.columns.get(table) ?? new Set<string>();
}

beforeAll(async () => {
  savedDataDir = process.env.SQUISH_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  resetDb();
  // Touch the db so a fresh temp schema is bootstrapped by the adapter.
  const { getDb } = await import('../../db/index.js');
  await getDb();
});

afterAll(async () => {
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  await closeAllDbs();
  resetDb();
});

describe('schema-probe required surface', () => {
  test('REQUIRED_TABLES covers maintenance_job_history', () => {
    expect(REQUIRED_TABLES).toContain('maintenance_job_history');
  });

  test('REQUIRED_TABLES covers memory_feedback', () => {
    // The table had no bootstrap DDL at all, so every `squish_feedback` write
    // failed with `no such table` while probeSchemaHealth() reported `ok`.
    expect(REQUIRED_TABLES).toContain('memory_feedback');
  });

  test('retired edge stores are optional legacy sources absent from fresh schemas', async () => {
    const retiredTables = ['entity_relations', 'memory_associations', 'belief_edges', 'memory_places'] as const;
    const freshSchema = await bootstrapAuditDb('ddl-audit-retired-edge-absence');
    for (const table of retiredTables) {
      expect(REQUIRED_TABLES).not.toContain(table);
      expect(freshSchema.tables.has(table)).toBe(false);
    }
  });

  test('REQUIRED_COLUMNS covers every memory_feedback column the DDL creates', () => {
    const covered = new Set(
      REQUIRED_COLUMNS.map((entry) => `${entry.table}.${entry.column}`)
    );
    for (const column of MEMORY_FEEDBACK_DDL_COLUMNS) {
      expect(covered.has(`memory_feedback.${column}`)).toBe(true);
    }
  });

  test('every memory_feedback column probed for physically exists', async () => {
    // The invariant that makes the entry above safe to add. probeSchemaHealth()
    // iterates REQUIRED_COLUMNS for every physically existing table, so ONE
    // entry naming a column the DDL does not create makes every correctly
    // bootstrapped database report `drifted`, and safeRegisterTool then returns
    // an error for EVERY MCP tool on EVERY call. Verified column by column
    // against a database built only from db/bootstrap.ts.
    const physical = await bootstrappedColumnsOf('memory_feedback');
    const missing = MEMORY_FEEDBACK_DDL_COLUMNS.filter((c) => !physical.has(c));
    expect(missing).toEqual([]);
  });

  test('REQUIRED_COLUMNS covers every DDL column of maintenance_job_history and namespaces', () => {
    const covered = new Set(
      REQUIRED_COLUMNS.map((entry) => `${entry.table}.${entry.column}`)
    );

    for (const column of [
      'job_id',
      'started_at',
      'completed_at',
      'duration',
      'status',
      'error',
      'records_processed',
      'result_summary',
    ]) {
      expect(covered.has(`maintenance_job_history.${column}`)).toBe(true);
    }

    for (const column of [
      'project_id',
      'name',
      'path',
      'description',
      'parent_id',
      'created_at',
      'updated_at',
    ]) {
      expect(covered.has(`namespaces.${column}`)).toBe(true);
    }
  });

  test('REQUIRED_COLUMNS never demands a column the DDL does not create', () => {
    // The two columns that were drizzle-only. Listing either here would report
    // `drifted` for every healthy database and block every MCP tool.
    const covered = REQUIRED_COLUMNS.map((entry) => `${entry.table}.${entry.column}`);
    expect(covered).not.toContain('namespaces.type');
    expect(covered).not.toContain('maintenance_job_history.created_at');
  });

  test('every REQUIRED_COLUMNS entry is created by the bootstrap DDL', async () => {
    // The invariant the comment in db/schema-probe.ts documents: probeSchemaHealth()
    // iterates REQUIRED_COLUMNS for every existing table, so ONE entry naming a
    // column the DDL does not create makes every correctly bootstrapped database
    // report `drifted`, and safeRegisterTool then returns an error for EVERY MCP
    // tool on EVERY call. Checking only the historical offenders is not enough -
    // this asserts the whole list against real DDL, so the memory_feedback entry
    // added alongside it is covered by the same guard.
    const { tables, columns } = await bootstrapAuditDb('ddl-audit');

    expect(REQUIRED_COLUMNS.length).toBeGreaterThan(0);
    const overBroad: string[] = [];
    for (const entry of REQUIRED_COLUMNS) {
      if (!tables.has(entry.table)) {
        overBroad.push(`${entry.table}.${entry.column} (table not created by DDL)`);
        continue;
      }
      if (!columns.get(entry.table)!.has(entry.column)) {
        overBroad.push(`${entry.table}.${entry.column}`);
      }
    }

    expect(overBroad).toEqual([]);
  });

  test('every REQUIRED_TABLES entry is created by the bootstrap DDL', async () => {
    const { tables } = await bootstrapAuditDb('ddl-audit-tables');
    const absent = REQUIRED_TABLES.filter((table) => !tables.has(table));
    expect(absent).toEqual([]);
  });

  test('a freshly bootstrapped database probes as ok', async () => {
    const probe = await probeSchemaHealth();
    expect(probe.missingTables).toEqual([]);
    expect(probe.missingColumns).toEqual([]);
    expect(probe.status).toBe('ok');
  });

  test('a dropped required table is reported as drifted', async () => {
    const { getDb } = await import('../../db/index.js');
    const db = await getDb();
    const sqlite = (db as { $client: { exec: (sql: string) => void } }).$client;
    sqlite.exec('DROP TABLE maintenance_job_history');

    const probe = await probeSchemaHealth();
    expect(probe.status).toBe('drifted');
    expect(probe.missingTables).toContain('maintenance_job_history');

    // Restore so the shared temp db stays usable for other assertions.
    const { ensureSqliteSchema } = await import('../../db/bootstrap.js');
    await ensureSqliteSchema(sqlite as never);
    const recheck = await probeSchemaHealth();
    expect(recheck.status).toBe('ok');
  });
});
