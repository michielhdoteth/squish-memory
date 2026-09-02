/**
 * SquishClient.listRecent - empty-query recency listing with hoursBack filter.
 *
 * Regression coverage for the squish_extract empty-query crash: the tool
 * previously called search("", ...) which throws "Query cannot be empty".
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let client: import('@squish/core-sdk').SquishClient;
let getDb: typeof import('../../db/index.js').getDb;
let resetDb: typeof import('../../db/index.js').resetDb;

const PROJECT = join(tmpdir(), `squish-list-recent-project-${Date.now()}`);

describe('SquishClient.listRecent', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-list-recent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const { SquishClient } = await import('@squish/core-sdk');
    const dbMod = await import('../../db/index.js');
    client = new SquishClient();
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;
    resetDb();

    // Seed three memories in a stable project scope.
    await client.remember('list-recent alpha entry', { project: PROJECT, type: 'note' });
    await client.remember('list-recent beta entry', { project: PROJECT, type: 'note' });
    await client.remember('list-recent gamma entry', { project: PROJECT, type: 'note' });

    // Force distinct created_at values so recency ordering is deterministic.
    const db = await getDb();
    const sqlite = (db as any).$client;
    const ids = sqlite
      .prepare(`SELECT id FROM memories WHERE content LIKE 'list-recent %' ORDER BY created_at ASC`)
      .all() as Array<{ id: string }>;
    expect(ids.length).toBe(3);
    const now = Date.now();
    const offsets = [6 * 3600_000, 90 * 60_000, 30 * 60_000]; // alpha oldest
    for (let i = 0; i < ids.length; i++) {
      sqlite
        .prepare(`UPDATE memories SET created_at = ? WHERE id = ?`)
        .run(new Date(now - offsets[i]).toISOString(), ids[i].id);
    }
  }, 60_000);

  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    try {
      rmSync(testDataDir, { recursive: true, force: true });
      rmSync(PROJECT, { recursive: true, force: true });
    } catch {}
  });

  test('empty query lists memories ordered by recency (newest first)', async () => {
    const memories = await client.listRecent({ limit: 10, project: PROJECT });
    expect(memories.length).toBe(3);

    const contents = memories.map((m) => m.content);
    // gamma was given the most recent created_at, alpha the oldest.
    expect(contents[0]).toContain('gamma');
    expect(contents[contents.length - 1]).toContain('alpha');

    const times = memories.map((m) => m.createdAt.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    }
  });

  test('hoursBack filters out memories older than the window', async () => {
    const withinWindow = await client.listRecent({ limit: 10, project: PROJECT, hoursBack: 2 });
    const contents = withinWindow.map((m) => m.content);
    expect(contents.some((c) => c.includes('gamma'))).toBe(true);
    expect(contents.some((c) => c.includes('beta'))).toBe(true);
    // alpha sits ~6h back and must be excluded by the time filter.
    expect(contents.some((c) => c.includes('alpha'))).toBe(false);

    const emptyWindow = await client.listRecent({ limit: 10, project: PROJECT, hoursBack: 0.1 });
    expect(emptyWindow.length).toBe(0);
  });

  test('project scoping excludes memories from other projects', async () => {
    const otherProject = `${PROJECT}-other`;
    await client.remember('list-recent delta entry elsewhere', { project: otherProject, type: 'note' });

    const scoped = await client.listRecent({ limit: 10, project: PROJECT });
    expect(scoped.every((m) => !m.content.includes('delta'))).toBe(true);
  });
});
