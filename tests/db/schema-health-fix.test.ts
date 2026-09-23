/**
 * Tests for schema health checks and auto-repair functionality
 *
 * Each test starts with a fully bootstrapped schema (via ensureSqliteSchema)
 * then corrupts specific parts to test the fixing.
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';

let testCounter = 0;
const testDataDirRoot = join(tmpdir(), `squish-health-fix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.SQUISH_DATA_DIR = testDataDirRoot;
process.env.DATABASE_URL = '';

if (!existsSync(testDataDirRoot)) mkdirSync(testDataDirRoot, { recursive: true });

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';

import {
  probeSchemaHealth,
  checkGraphEntitiesTable,
  checkPlacesInitialization,
  checkConsolidationState,
} from '../../db/schema-probe.js';
import { fixSchemaIssues } from '../../db/schema-repair.js';
import { resetDb } from '../../db/index.js';
import { ensureSqliteSchema } from '../../db/bootstrap.js';

/**
 * Set up a fresh fully-bootstrapped database for each test.
 * Returns the directory path so the test can corrupt it.
 */
async function bootstrapFullDb(): Promise<{ dataDir: string; dbPath: string }> {
  const dataDir = join(testDataDirRoot, `test-${testCounter++}`);
  mkdirSync(dataDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  resetDb();

  const dbPath = join(dataDir, 'squish.db');
  const sqlite = new Database(dbPath);
  sqlite.exec('PRAGMA foreign_keys = OFF'); // Off to allow schema bootstrap
  await ensureSqliteSchema(sqlite);
  sqlite.close();
  resetDb();

  return { dataDir, dbPath };
}

/**
 * Ensure SQUISH_DATA_DIR is set and db is fresh for schema-health functions.
 * This is needed because other test files may have changed env vars.
 */
async function ensureFreshDb(dataDir: string) {
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  resetDb();
}

describe('schema-health fix functionality', () => {
  test('fixSchemaIssues creates missing tables', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();

    // Simulate drift: drop tables via direct SQLite
    const sqlite = new Database(dbPath);
    sqlite.exec('DROP TABLE IF EXISTS learnings');
    sqlite.exec('DROP TABLE IF EXISTS session_summaries');
    sqlite.exec('DROP TABLE IF EXISTS beliefs');
    sqlite.close();
    await ensureFreshDb(dataDir);

    const probe = await probeSchemaHealth();
    expect(probe.status).toBe('drifted');
    expect(probe.missingTables.length).toBeGreaterThan(0);

    // Fix issues
    await ensureFreshDb(dataDir);
    const actions = await fixSchemaIssues({ fixMissingTables: true, verbose: false });
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some(a => a.type === 'run_migration' || a.type === 'create_table')).toBe(true);

    // Recheck - should be ok now
    await ensureFreshDb(dataDir);
    const recheck = await probeSchemaHealth();
    expect(recheck.status).toBe('ok');
  });

  test('fixSchemaIssues creates missing indexes', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();

    // Drop specific indexes
    const sqlite = new Database(dbPath);
    sqlite.exec('DROP INDEX IF EXISTS memories_project_idx');
    sqlite.exec('DROP INDEX IF EXISTS memories_type_idx');
    sqlite.close();
    await ensureFreshDb(dataDir);

    // Fix indexes
    const actions = await fixSchemaIssues({ fixMissingIndexes: true, verbose: false });
    expect(actions.some(a => a.type === 'create_index')).toBe(true);

    // Verify indexes exist
    const sqlite2 = new Database(dbPath);
    const indexes = sqlite2.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'").all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    expect(names).toContain('memories_project_idx');
    expect(names).toContain('memories_type_idx');
    sqlite2.close();
  });

  test('fixSchemaIssues repairs FTS schema', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();

    // Drop FTS-related objects to simulate corruption
    const sqlite = new Database(dbPath);
    sqlite.exec('DROP TRIGGER IF EXISTS memories_ai');
    sqlite.exec('DROP TRIGGER IF EXISTS memories_ad');
    sqlite.exec('DROP TRIGGER IF EXISTS memories_au');
    sqlite.exec('DROP TABLE IF EXISTS memories_fts');
    sqlite.close();
    await ensureFreshDb(dataDir);

    const actions = await fixSchemaIssues({ fixFts: true, verbose: false });
    expect(actions.some(a => a.type === 'repair_fts')).toBe(true);

    // Verify FTS table exists
    const sqlite2 = new Database(dbPath);
    const ftsTable = sqlite2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get() as { name: string } | undefined;
    expect(ftsTable).toBeDefined();

    // Verify triggers exist
    const triggers = sqlite2.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memories'").all() as Array<{ name: string }>;
    const triggerNames = triggers.map(t => t.name);
    expect(triggerNames).toContain('memories_ai');
    expect(triggerNames).toContain('memories_ad');
    expect(triggerNames).toContain('memories_au');
    sqlite2.close();
  });

  test('fixSchemaIssues initializes default places', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();

    // Clear places data
    const sqlite = new Database(dbPath);
    sqlite.exec('DELETE FROM place_rules');
    sqlite.exec('DELETE FROM places');
    sqlite.close();
    await ensureFreshDb(dataDir);

    const actions = await fixSchemaIssues({ fixPlaces: true, verbose: false });
    expect(actions.some(a => a.type === 'init_places')).toBe(true);

    // Verify places exist
    const sqlite2 = new Database(dbPath);
    const places = sqlite2.prepare('SELECT COUNT(*) as count FROM places').get() as { count: number };
    expect(places.count).toBe(7);
    sqlite2.close();
  });

  test('fixSchemaIssues initializes graph entities table', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();

    // Drop entity_relations
    const sqlite = new Database(dbPath);
    sqlite.exec('DROP TABLE IF EXISTS entity_relations');
    sqlite.close();
    await ensureFreshDb(dataDir);

    const actions = await fixSchemaIssues({ fixGraphEntities: true, verbose: false });
    expect(actions.some(a => a.type === 'create_entities_table')).toBe(true);

    // Verify table exists
    const sqlite2 = new Database(dbPath);
    const table = sqlite2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_relations'").get() as { name: string } | undefined;
    expect(table).toBeDefined();
    sqlite2.close();
  });

  test('checkGraphEntitiesTable detects missing table', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();

    const sqlite = new Database(dbPath);
    sqlite.exec('DROP TABLE IF EXISTS entity_relations');
    sqlite.close();
    await ensureFreshDb(dataDir);

    const result = await checkGraphEntitiesTable();
    expect(result.status).toBe('degraded');
    expect(result.message).toContain('entity_relations');
  });

  test('checkPlacesInitialization detects missing places', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();

    const sqlite = new Database(dbPath);
    sqlite.exec('DELETE FROM places');
    sqlite.close();
    await ensureFreshDb(dataDir);

    const result = await checkPlacesInitialization();
    expect(result.status).toBe('degraded');
    expect(result.message.toLowerCase()).toContain('no places');
  });

  test('checkConsolidationState reports correct status', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();
    await ensureFreshDb(dataDir);

    const result = await checkConsolidationState();
    expect(result.status).toBe('ok');
  });

  test('fixSchemaIssues is idempotent', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();
    await ensureFreshDb(dataDir);

    // Run fix multiple times on healthy db
    const actions1 = await fixSchemaIssues({ fixAll: true, verbose: false });
    const actions2 = await fixSchemaIssues({ fixAll: true, verbose: false });

    expect(Array.isArray(actions1)).toBe(true);
    expect(Array.isArray(actions2)).toBe(true);
    // Second run should produce equal or fewer actions (no new issues)
    expect(actions2.length).toBeLessThanOrEqual(actions1.length);
  });
});
