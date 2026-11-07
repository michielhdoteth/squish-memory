/**
 * Regression guard: drizzle must not declare a column that no DDL creates.
 *
 * drizzle-orm 0.45.x emits EVERY declared column in an INSERT column list and
 * `select()` with no field list selects all declared columns. A single
 * drizzle-declared column that is missing from the physical table therefore
 * breaks every insert and every select on that table, even when the caller
 * never touches that column. That is how `maintenance_job_history.created_at`
 * and `namespaces.type` silently discarded 100% of maintenance job history
 * while `probeSchemaHealth()` still reported `ok`.
 *
 * These tests assert drizzle's declared columns against the schema that
 * `ensureSqliteSchema` actually creates, for every drizzle table that exists
 * physically. Drizzle-only tables with no DDL at all are dormant, out of
 * scope, and reported rather than asserted.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import { getTableColumns, getTableName, type Table } from 'drizzle-orm';

import { closeAllDbs, getDb, resetDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { ensureSqliteSchema } from '../../db/bootstrap.js';
import * as sqliteSchema from '../../db/drizzle/schema-sqlite.js';

const testDataDir = join(
  tmpdir(),
  `squish-drizzle-ddl-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let physicalTables: Set<string>;
let physicalColumns: Map<string, Set<string>>;

interface DrizzleTableShape {
  exportName: string;
  table: string;
  columns: string[];
}

function collectDrizzleTables(): DrizzleTableShape[] {
  const shapes: DrizzleTableShape[] = [];
  for (const [exportName, value] of Object.entries(sqliteSchema as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    try {
      const tableName = getTableName(value as Table);
      const columns = getTableColumns(value as Table);
      shapes.push({
        exportName,
        table: tableName,
        columns: Object.values(columns)
          .map((column) => column.name)
          .filter((name): name is string => typeof name === 'string'),
      });
    } catch {
      // Not a drizzle table (helpers, type-only exports, builders).
    }
  }
  return shapes;
}

function listPhysicalTables(sqlite: { prepare: (sql: string) => { all: () => unknown[] } }): string[] {
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function listPhysicalColumns(
  sqlite: { prepare: (sql: string) => { all: () => unknown[] } },
  table: string
): string[] {
  const rows = sqlite.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

beforeAll(async () => {
  savedDataDir = process.env.SQUISH_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  resetDb();

  // Bootstrap the real DDL into the temp location, then inspect it read-only.
  const sqlite = new (await import('bun:sqlite')).default(join(testDataDir, 'squish.db'));
  sqlite.exec('PRAGMA foreign_keys = OFF');
  await ensureSqliteSchema(sqlite);

  physicalTables = new Set(listPhysicalTables(sqlite as never));
  physicalColumns = new Map();
  for (const table of physicalTables) {
    physicalColumns.set(table, new Set(listPhysicalColumns(sqlite as never, table)));
  }
  sqlite.close();
});

afterAll(async () => {
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  await closeAllDbs();
  resetDb();
  // The temp dir lives under os.tmpdir() and is deliberately left in place:
  // on Windows the SQLite WAL/SHM files keep the directory locked well past
  // close(), which makes rmSync a platform-specific flake. Other suites in
  // tests/db do the same.
});

describe('drizzle schema vs bootstrapped DDL', () => {
  test('every drizzle-declared column exists on its physical table', () => {
    const shapes = collectDrizzleTables();
    expect(shapes.length).toBeGreaterThan(10);

    // Only assert against tables that exist physically. Tables declared in
    // drizzle with no DDL anywhere are dormant and out of scope.
    const missing: string[] = [];
    for (const shape of shapes) {
      if (!physicalTables.has(shape.table)) continue;
      const columns = physicalColumns.get(shape.table)!;
      for (const column of shape.columns) {
        if (!columns.has(column)) missing.push(`${shape.table}.${column}`);
      }
    }

    expect(missing).toEqual([]);
  });

  test('maintenance_job_history has no drizzle-declared created_at', () => {
    const shape = collectDrizzleTables().find((entry) => entry.table === 'maintenance_job_history');
    expect(shape).toBeDefined();
    expect(shape!.columns).not.toContain('created_at');
    expect(shape!.columns).toContain('started_at');
  });

  test('namespaces has no drizzle-declared type column', () => {
    const shape = collectDrizzleTables().find((entry) => entry.table === 'namespaces');
    expect(shape).toBeDefined();
    expect(shape!.columns).not.toContain('type');
    expect(shape!.columns).toContain('name');
  });

  test('maintenance_job_history insert persists the row', async () => {
    const schema = await getSchema();
    const db = await getDb();
    const maintenanceJobs = schema.maintenanceJobs as Parameters<typeof db.insert>[0];
    const maintenanceJobHistory = schema.maintenanceJobHistory as Parameters<typeof db.insert>[0];

    await db.insert(maintenanceJobs).values({
      id: 'job-1',
      jobName: 'drizzle-ddl-consistency-job',
      jobType: 'test',
      enabled: true,
      totalRuns: 0,
      successCount: 0,
      failureCount: 0,
    } as never);

    const startedAt = new Date('2026-01-02T03:04:05.000Z');
    await db
      .insert(maintenanceJobHistory)
      .values({
        jobId: 'job-1',
        startedAt,
        completedAt: new Date('2026-01-02T03:04:06.000Z'),
        duration: 1000,
        status: 'success',
        recordsProcessed: 7,
        resultSummary: JSON.stringify({ scanned: 7 }),
      } as never);

    const stored = await db.select().from(maintenanceJobHistory as never);
    expect(stored.length).toBe(1);
    expect((stored[0] as Record<string, unknown>).jobId).toBe('job-1');
    expect((stored[0] as Record<string, unknown>).recordsProcessed).toBe(7);
    expect((stored[0] as Record<string, unknown>).status).toBe('success');
  });

  test('namespaces insert and select round-trip', async () => {
    const schema = await getSchema();
    const db = await getDb();
    const projects = schema.projects as Parameters<typeof db.insert>[0];
    const namespaces = schema.namespaces as Parameters<typeof db.insert>[0];

    await db.insert(projects).values({
      id: 'project-1',
      name: 'namespace-project',
      path: '/namespace-project',
      metadata: JSON.stringify({ source: 'test' }),
    } as never);

    await db
      .insert(namespaces)
      .values({ id: 'ns-1', projectId: 'project-1', name: 'root', path: '/root' } as never);

    const stored = await db.select().from(namespaces as never);
    expect(stored.length).toBe(1);
    expect((stored[0] as Record<string, unknown>).name).toBe('root');
  });
});