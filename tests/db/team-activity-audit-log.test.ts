/**
 * Regression guard: getTeamActivity must read the audit table that exists.
 *
 * `db/team-adapter.ts` selected from the drizzle-declared `audit_logs` table.
 * No DDL ever created it: the live audit trail is `audit_log` (singular),
 * created lazily by `core/knowledge/audit.ts`, with columns
 * id / knowledge_id / action / agent_id / project_id / session_id / details /
 * created_at. Every call therefore threw `no such table: audit_logs`.
 *
 * The test drives the real code path against a bootstrapped temporary
 * database and asserts it returns rows instead of throwing.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';

const testDataDir = join(
  tmpdir(),
  `squish-team-activity-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

interface RawSqlite {
  prepare: (sql: string) => {
    get: (sql?: string) => unknown | null;
    run: (...params: unknown[]) => unknown;
  };
}

let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let savedTrustPolicy: string | undefined;

beforeAll(async () => {
  savedDataDir = process.env.SQUISH_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  savedTrustPolicy = process.env.SQUISH_TRUST_POLICY;
  if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  const { resetDb, getDb } = await import('../../db/index.js');
  resetDb();
  await getDb();
});

afterAll(async () => {
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  if (savedTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
  else process.env.SQUISH_TRUST_POLICY = savedTrustPolicy;
  const { closeAllDbs, resetDb } = await import('../../db/index.js');
  await closeAllDbs();
  resetDb();
});

describe('getTeamActivity reads the real audit trail', () => {
  test('returns team-scoped audit rows instead of throwing on a missing table', async () => {
    const { getTeamActivity } = await import('../../db/team-adapter.js');
    const { getDb } = await import('../../db/index.js');
    const db = await getDb();
    const sqlite = (db as unknown as { $client: RawSqlite }).$client;

    // audit_log is created lazily by the knowledge audit module, never by
    // bootstrap, so a freshly bootstrapped database does not have it yet.
    const { ensureAuditTable } = await import('../../core/knowledge/audit.js');
    await ensureAuditTable();

    // memories.team_id references teams(id), so the team has to exist.
    sqlite.prepare(`INSERT INTO teams (id, name, slug) VALUES ('team-1', 'Team One', 'team-one')`).run();

    const memoryId = '11111111-1111-4111-8111-111111111111';
    sqlite
      .prepare(
        `INSERT INTO memories (id, type, content, tokens_estimate, team_id)
         VALUES (?, 'fact', 'team scoped memory', 0, 'team-1')`
      )
      .run(memoryId);

    sqlite
      .prepare(
        `INSERT INTO audit_log (knowledge_id, action, agent_id, project_id, session_id, details, created_at)
         VALUES (?, 'create', 'agent-7', 'project-1', 'session-1', '{"kind":"memory"}', 1700000000)`
      )
      .run(memoryId);

    // The plural table the old query named genuinely does not exist here.
    const plural = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'")
      .get();
    expect(plural ?? undefined).toBeUndefined();

    const entries = await getTeamActivity('team-1', { limit: 10 });
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const entry = entries[0]!;
    expect(entry.action).toBe('create');
    expect(entry.entityId).toBe(memoryId);
    expect(entry.teamId).toBe('team-1');
    expect(entry.userId).toBe('agent-7');
    expect(entry.createdAt.getTime()).toBe(1700000000000);
    expect(entry.metadata).toEqual({ kind: 'memory' });

    // An unrelated team yields nothing rather than throwing.
    const other = await getTeamActivity('team-does-not-exist');
    expect(other).toEqual([]);
  });

  test('the audit_log table is created on demand so the query always has a table', async () => {
    const { getTeamActivity } = await import('../../db/team-adapter.js');
    const { getDb } = await import('../../db/index.js');
    const db = await getDb();
    const sqlite = (db as unknown as { $client: RawSqlite }).$client;

    // Drop the lazily created table, then call straight into the adapter: the
    // path must still work because it owns ensuring its table exists.
    sqlite.prepare('DROP TABLE IF EXISTS audit_log').run();

    await expect(getTeamActivity('team-1', { limit: 5 })).resolves.toBeInstanceOf(Array);
  });

  test('strict trust denies this unscoped audit reader before touching SQLite', async () => {
    const { getTeamActivity } = await import('../../db/team-adapter.js');
    const { getDb } = await import('../../db/index.js');
    const db = await getDb();
    const sqlite = (db as unknown as { $client: RawSqlite }).$client;
    sqlite.prepare('DROP TABLE IF EXISTS audit_log').run();

    process.env.SQUISH_TRUST_POLICY = 'strict';
    try {
      await expect(getTeamActivity('team-1')).rejects.toThrow('caller-scoped membership and audit visibility checks');
      const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get();
      expect(table).toBeNull();
    } finally {
      if (savedTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = savedTrustPolicy;
    }
  });
});
