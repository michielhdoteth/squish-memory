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
    sqlite.exec('DROP TABLE IF EXISTS trust_audit_log');
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
    const repairedDb = new Database(dbPath, { readonly: true });
    const trustAuditTable = repairedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trust_audit_log'").get();
    expect(trustAuditTable).toBeDefined();
    repairedDb.close();
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

  test('temporal candidate index is created on fresh, upgraded, and repaired databases and used by the scoped plan', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();
    const indexName = 'memories_valid_from_idx';
    const hasTemporalIndex = (sqlite: Database) => Boolean(sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name = ?",
    ).get(indexName));

    const freshDb = new Database(dbPath);
    expect(hasTemporalIndex(freshDb)).toBe(true);
    freshDb.exec(`DROP INDEX ${indexName}`);
    freshDb.close();

    // The normal SQLite migration chain repairs an existing database that
    // predates this index, independently of the fresh-schema DDL.
    const migrationDb = new Database(dbPath);
    const { runAllMigrations } = await import('../../db/migrations/index.js');
    await runAllMigrations(migrationDb as never);
    expect(hasTemporalIndex(migrationDb)).toBe(true);
    migrationDb.exec(`DROP INDEX ${indexName}`);
    migrationDb.prepare('DELETE FROM _schema_versions WHERE version LIKE ?').run('sqlite-schema-%');
    migrationDb.prepare('INSERT INTO _schema_versions (version, description) VALUES (?, ?)')
      .run('sqlite-schema-2026-10-20-revision-3', 'pre-temporal-candidate-index fixture');
    migrationDb.close();

    // Opening a revision-3 database must apply the SQLite migration even
    // though all tables already exist and the old revision marker is present.
    const upgradeDb = new Database(dbPath);
    upgradeDb.exec('PRAGMA foreign_keys = OFF');
    await ensureSqliteSchema(upgradeDb);
    expect(hasTemporalIndex(upgradeDb)).toBe(true);

    const replacementStart = Date.UTC(2026, 5, 3) / 1000;
    const replacementEnd = Date.UTC(2026, 5, 8) / 1000;
    const insert = upgradeDb.prepare(`INSERT INTO memories
      (id, type, content, status, created_at, valid_from)
      VALUES (?, 'fact', 'synthetic temporal candidate', 'active', strftime('%s','now'), ?)`);
    const insertRows = upgradeDb.transaction(() => {
      for (let index = 0; index < 5000; index++) {
        insert.run(`index-plan-future-${index}`, replacementEnd + index + 1);
      }
    });
    insertRows();
    upgradeDb.exec('ANALYZE');
    const queryPlan = upgradeDb.prepare(`EXPLAIN QUERY PLAN
      SELECT id, content, valid_from, valid_to FROM memories
      WHERE status = ?
        AND (valid_to IS NULL OR valid_to > ?)
        AND (valid_from IS NULL OR valid_from < ?)`)
      .all('active', replacementStart, replacementEnd) as Array<{ detail: string }>;
    expect(queryPlan.some((step) => step.detail.includes(indexName) && step.detail.includes('SEARCH'))).toBe(true);
    upgradeDb.close();

    const driftDb = new Database(dbPath);
    driftDb.exec(`DROP INDEX ${indexName}`);
    driftDb.close();

    await ensureFreshDb(dataDir);
    const drift = await probeSchemaHealth();
    expect(drift.indexIssues).toContainEqual({ name: indexName, reason: 'missing' });
    const repairActions = await fixSchemaIssues({ fixMissingIndexes: true, verbose: false });
    expect(repairActions).toContainEqual(expect.objectContaining({
      type: 'create_index',
      detail: `Created index ${indexName} on memories`,
      target: 'memories',
    }));
    const repairedDb = new Database(dbPath, { readonly: true });
    expect(hasTemporalIndex(repairedDb)).toBe(true);
    repairedDb.close();
  });

  test('fixSchemaIssues repairs a required index that exists with the wrong definition', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();

    const sqlite = new Database(dbPath);
    sqlite.exec('DROP INDEX memories_project_idx');
    sqlite.exec('CREATE INDEX memories_project_idx ON memories(type)');
    sqlite.close();
    await ensureFreshDb(dataDir);

    const drift = await probeSchemaHealth();
    expect(drift.status).toBe('drifted');
    expect(drift.indexIssues).toContainEqual({ name: 'memories_project_idx', reason: 'definition_mismatch' });
    expect(drift.detail).toContain('memories_project_idx (definition mismatch)');

    const actions = await fixSchemaIssues({ fixMissingIndexes: true, verbose: false });
    expect(actions).toContainEqual(expect.objectContaining({
      type: 'create_index',
      detail: 'Repaired index memories_project_idx on memories',
      target: 'memories',
    }));

    const verify = new Database(dbPath, { readonly: true });
    const columns = verify.prepare('PRAGMA index_info(memories_project_idx)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(['project_id']);
    verify.close();
    expect((await probeSchemaHealth()).status).toBe('ok');
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

  test('fixSchemaIssues rebuilds stale FTS postings from canonical memory rows', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();
    const sqlite = new Database(dbPath);
    sqlite.prepare(`INSERT INTO memories (id, content, type, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('fts-repair-row', 'qzxv rebuildingunique memory posting', 'note', 'fts-repair-project', Date.now(), Date.now());
    sqlite.exec("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')");
    sqlite.close();
    await ensureFreshDb(dataDir);

    const actions = await fixSchemaIssues({ fixFts: true, verbose: false });
    expect(actions.some((action) => action.detail.includes('Rebuilt memories_fts postings'))).toBe(true);

    const verify = new Database(dbPath);
    const indexed = verify.prepare(`
      SELECT m.id FROM memories_fts JOIN memories m ON memories_fts.rowid = m.rowid
      WHERE memories_fts MATCH ?
    `).all('qzxv') as Array<{ id: string }>;
    expect(indexed.map((row) => row.id)).toContain('fts-repair-row');
    verify.close();
  });

  test('fixSchemaIssues rebuilds stale message FTS postings from canonical message rows', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();
    const sqlite = new Database(dbPath);
    sqlite.prepare('INSERT INTO conversations (id, session_id) VALUES (?, ?)')
      .run('fts-repair-conversation', 'fts-repair-session');
    sqlite.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)')
      .run('fts-repair-message', 'fts-repair-conversation', 'user', 'qzxv rebuildingunique message posting');
    sqlite.exec("INSERT INTO messages_fts(messages_fts) VALUES('delete-all')");
    sqlite.close();
    await ensureFreshDb(dataDir);

    const actions = await fixSchemaIssues({ fixFts: true, verbose: false });
    expect(actions.some((action) => action.detail.includes('Rebuilt messages_fts postings'))).toBe(true);

    const verify = new Database(dbPath);
    const indexed = verify.prepare(`SELECT m.id FROM messages_fts JOIN messages m ON messages_fts.rowid = m.rowid
      WHERE messages_fts MATCH ?`).all('qzxv') as Array<{ id: string }>;
    expect(indexed.map((row) => row.id)).toContain('fts-repair-message');
    verify.close();
  });

  test('fixSchemaIssues restores missing FTS update triggers when postings are otherwise healthy', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();
    const sqlite = new Database(dbPath);
    sqlite.prepare(`INSERT INTO memories (id, content, type, project_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('fts-trigger-repair-row', 'ftsrecoveroldtoken original text', 'note', null, Date.now(), Date.now());
    sqlite.prepare(`INSERT INTO conversations (id, session_id) VALUES (?, ?)`)
      .run('fts-trigger-repair-conversation', 'fts-trigger-repair-session');
    sqlite.prepare(`INSERT INTO messages (id, conversation_id, role, content)
      VALUES (?, ?, ?, ?)`)
      .run('fts-trigger-repair-message', 'fts-trigger-repair-conversation', 'user', 'msgrecoveroldtoken original text');
    sqlite.exec('DROP TRIGGER memories_au');
    sqlite.exec('DROP TRIGGER messages_au');
    sqlite.close();
    await ensureFreshDb(dataDir);

    const actions = await fixSchemaIssues({ fixFts: true, verbose: false });
    expect(actions.some((action) => action.type === 'repair_fts')).toBe(true);

    const verify = new Database(dbPath);
    const trigger = verify.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='memories_au'")
      .get() as { name: string } | undefined;
    expect(trigger?.name).toBe('memories_au');
    const messageTrigger = verify.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='messages_au'")
      .get() as { name: string } | undefined;
    expect(messageTrigger?.name).toBe('messages_au');
    verify.prepare('UPDATE memories SET content = ? WHERE id = ?')
      .run('ftsrecovernewtoken corrected text', 'fts-trigger-repair-row');
    const oldMatches = verify.prepare(`SELECT count(*) AS count FROM memories_fts
      WHERE memories_fts MATCH 'ftsrecoveroldtoken'`).get() as { count: number };
    const newMatches = verify.prepare(`SELECT count(*) AS count FROM memories_fts
      WHERE memories_fts MATCH 'ftsrecovernewtoken'`).get() as { count: number };
    expect(oldMatches.count).toBe(0);
    expect(newMatches.count).toBe(1);
    verify.prepare('UPDATE messages SET content = ? WHERE id = ?')
      .run('msgrecovernewtoken corrected text', 'fts-trigger-repair-message');
    const oldMessageMatches = verify.prepare(`SELECT count(*) AS count FROM messages_fts
      WHERE messages_fts MATCH 'msgrecoveroldtoken'`).get() as { count: number };
    const newMessageMatches = verify.prepare(`SELECT count(*) AS count FROM messages_fts
      WHERE messages_fts MATCH 'msgrecovernewtoken'`).get() as { count: number };
    expect(oldMessageMatches.count).toBe(0);
    expect(newMessageMatches.count).toBe(1);
    verify.close();
  });

  test('fixSchemaIssues replaces a same-name FTS trigger with an incorrect body', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();
    const sqlite = new Database(dbPath);
    sqlite.prepare(`INSERT INTO memories (id, content, type, project_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('fts-trigger-body-row', 'ftsbodyoldtoken original text', 'note', null, Date.now(), Date.now());
    sqlite.exec(`DROP TRIGGER memories_au;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN SELECT 1; END;`);
    sqlite.close();
    await ensureFreshDb(dataDir);

    const actions = await fixSchemaIssues({ fixFts: true, verbose: false });
    expect(actions.some((action) => action.detail.includes('memories_au'))).toBe(true);

    const verify = new Database(dbPath);
    verify.prepare('UPDATE memories SET content = ? WHERE id = ?')
      .run('ftsbodynewtoken corrected text', 'fts-trigger-body-row');
    const oldMatches = verify.prepare(`SELECT count(*) AS count FROM memories_fts
      WHERE memories_fts MATCH 'ftsbodyoldtoken'`).get() as { count: number };
    const newMatches = verify.prepare(`SELECT count(*) AS count FROM memories_fts
      WHERE memories_fts MATCH 'ftsbodynewtoken'`).get() as { count: number };
    expect(oldMatches.count).toBe(0);
    expect(newMatches.count).toBe(1);
    verify.close();
  });

  test('fixSchemaIssues leaves healthy FTS postings untouched', async () => {
    const { dataDir } = await bootstrapFullDb();
    await ensureFreshDb(dataDir);
    const actions = await fixSchemaIssues({ fixFts: true, verbose: false });
    expect(actions.some((action) => action.detail.includes('Rebuilt memories_fts postings'))).toBe(false);
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

  test('graph health and repair do not require or recreate legacy entity relations', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();
    await ensureFreshDb(dataDir);

    const result = await checkGraphEntitiesTable();
    expect(result.status).toBe('ok');
    expect(result.message).toContain('knowledge_edges');

    const actions = await fixSchemaIssues({ fixAll: true, verbose: false });
    const sqlite2 = new Database(dbPath);
    const table = sqlite2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_relations'").get() as { name: string } | null;
    expect(table).toBeNull();
    expect(actions.some(a => a.type === 'create_table' && a.detail.includes('entity_relations'))).toBe(false);
    expect((await probeSchemaHealth()).status).toBe('ok');
    sqlite2.close();
  });

  test('checkGraphEntitiesTable detects a missing canonical edge store', async () => {
    const { dataDir, dbPath } = await bootstrapFullDb();

    const sqlite = new Database(dbPath);
    sqlite.exec('DROP TABLE IF EXISTS knowledge_edges');
    sqlite.close();
    await ensureFreshDb(dataDir);

    const result = await checkGraphEntitiesTable();
    expect(result.status).toBe('degraded');
    expect(result.message).toContain('knowledge_edges');
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
