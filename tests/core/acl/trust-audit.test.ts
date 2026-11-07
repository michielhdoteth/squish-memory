import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { closeAllDbs, resetDb } from '../../../db/index.js';
import { ensureSqliteSchema } from '../../../db/bootstrap.js';
import * as sqliteSchema from '../../../db/drizzle/schema-sqlite.js';
import * as pgSchema from '../../../db/drizzle/schema-pg.js';
import { writeTrustAudit } from '../../../core/acl/trust-audit.js';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-trust-audit-'));
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;

beforeAll(async () => {
  savedDataDir = process.env.SQUISH_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  resetDb();
  const sqlite = new (await import('bun:sqlite')).Database(join(dataDir, 'squish.db'));
  sqlite.exec('PRAGMA foreign_keys = OFF');
  await ensureSqliteSchema(sqlite);
  sqlite.close();
  resetDb();
});

afterAll(async () => {
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  await closeAllDbs();
  resetDb();
});

describe('portable trust audit schema', () => {
  test('SQLite and PostgreSQL declare the same minimized audit columns', () => {
    const sqliteTable = sqliteSchema.trustAuditLog;
    const postgresTable = pgSchema.trustAuditLog;
    expect(getTableName(sqliteTable)).toBe('trust_audit_log');
    expect(getTableName(postgresTable)).toBe('trust_audit_log');
    const sqliteColumns = Object.values(getTableColumns(sqliteTable)).map((column) => column.name);
    const pgColumns = Object.values(getTableColumns(postgresTable)).map((column) => column.name);
    expect(pgColumns).toEqual(sqliteColumns);
  });

  test('PostgreSQL migration journal points to the trust audit DDL', () => {
    const root = join(import.meta.dir, '..', '..', '..');
    const journal = JSON.parse(readFileSync(join(root, 'db/drizzle/migrations/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    expect(journal.entries.some((entry) => entry.tag === '0002_trust_audit_log')).toBe(true);
    expect(journal.entries.some((entry) => entry.tag === '0003_trust_audit_epoch_ms_bigint')).toBe(true);
    const migration = readFileSync(join(root, 'db/drizzle/migrations/0002_trust_audit_log.sql'), 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS trust_audit_log');
    expect(migration).toContain('actor_hash TEXT NOT NULL');
    expect(migration).toContain('resource_hash TEXT NOT NULL');
    const widening = readFileSync(join(root, 'db/drizzle/migrations/0003_trust_audit_epoch_ms_bigint.sql'), 'utf8');
    expect(widening).toContain('ALTER COLUMN created_at TYPE BIGINT');
    expect(widening).toContain('USING created_at::BIGINT');
  });

  test('uses a 64-bit PostgreSQL type for epoch-millisecond audit timestamps', () => {
    const createdAt = getTableColumns(pgSchema.trustAuditLog).createdAt;
    expect(createdAt.getSQLType()).toBe('bigint');
    expect(createdAt.columnType).toBe('PgBigInt53');
  });

  test('writes hashed identities and resources through the active SQLite schema', async () => {
    await writeTrustAudit({
      actorId: 'alice@example.test',
      resourceId: 'edge-private-42',
      assetType: 'knowledge_edge',
      decision: 'deny',
      reason: 'private_default',
    });

    const sqlite = new (await import('bun:sqlite')).Database(join(dataDir, 'squish.db'), { readonly: true });
    const row = sqlite.prepare('SELECT actor_hash, resource_hash, asset_type, decision, reason FROM trust_audit_log LIMIT 1').get() as {
      actor_hash: string; resource_hash: string; asset_type: string; decision: string; reason: string;
    };
    expect(row.actor_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.resource_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.actor_hash).not.toContain('alice');
    expect(row.resource_hash).not.toContain('edge-private-42');
    expect(row.asset_type).toBe('knowledge_edge');
    expect(row.decision).toBe('deny');
    expect(row.reason).toBe('private_default');
    sqlite.close();
  });
});
