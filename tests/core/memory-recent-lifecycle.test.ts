import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-memory-recent-lifecycle-'));
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_TRUST_POLICY = 'local-compatible';

const { closeAllDbs, getDb, resetDb } = await import('../../db/index.js');
const { getOrCreateProject } = await import('../../core/projects.js');
const { getRecent } = await import('../../core/memory/memory-crud.js');

describe('recent memory lifecycle filtering', () => {
  beforeAll(async () => {
    resetDb();
    const db = await getDb();
    const project = await getOrCreateProject(dataDir);
    if (!project) throw new Error('Could not create recent-memory fixture project');

    const nowSeconds = Math.floor(Date.now() / 1000);
    const insert = (id: string, lifecycle: string, active: number, validFrom: number | null, validTo: number | null, expiresAt: number | null) => {
      (db as any).$client.prepare(`INSERT INTO memories
        (id, project_id, type, content, status, is_active, valid_from, valid_to, expires_at, created_at)
        VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, project.id, id, lifecycle, active, validFrom, validTo, expiresAt, nowSeconds);
    };

    insert('recent-lifecycle-active', 'active', 1, null, null, null);
    insert('recent-lifecycle-archived', 'archived', 0, null, null, null);
    insert('recent-lifecycle-inactive', 'active', 0, null, null, null);
    insert('recent-lifecycle-expired-ms', 'active', 1, null, null, Date.now() - 60_000);
    insert('recent-lifecycle-ended-seconds', 'active', 1, null, nowSeconds - 1, null);
    insert('recent-lifecycle-future-ms', 'active', 1, Date.now() + 60_000, null, null);
    insert('recent-lifecycle-superseded', 'superseded', 0, null, null, null);
  });

  afterAll(async () => {
    await closeAllDbs();
    delete process.env.SQUISH_DATA_DIR;
    delete process.env.DATABASE_URL;
    delete process.env.SQUISH_TRUST_POLICY;
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows can retain a closed SQLite handle briefly. */ }
  });

  test('does not inject archived, inactive, superseded, expired, ended, or future-valid memories', async () => {
    const recent = await getRecent(dataDir, 20);
    expect(recent.map((memory) => memory.id)).toEqual(['recent-lifecycle-active']);
  });
});
