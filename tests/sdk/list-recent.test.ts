/**
 * SquishClient.listRecent - empty-query recency listing with hoursBack filter.
 *
 * Regression coverage for recent-memory listing, including empty-query paths.
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
const trustEnvKeys = [
  'SQUISH_TRUST_POLICY',
  'SQUISH_TRUSTED_CALLER_ID',
  'SQUISH_PROVENANCE_PRIVATE_KEY',
  'SQUISH_PROVENANCE_PUBLIC_KEY',
  'SQUISH_PROVENANCE_KEY_ID',
] as const;
const savedTrustEnv = new Map<string, string | undefined>();
let client: import('../../core/runtime/squish-runtime.js').SquishRuntime;
let getDb: typeof import('../../db/index.js').getDb;
let resetDb: typeof import('../../db/index.js').resetDb;

const PROJECT = join(tmpdir(), `squish-list-recent-project-${Date.now()}`);

describe('SquishClient.listRecent', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    for (const key of trustEnvKeys) savedTrustEnv.set(key, process.env[key]);
    testDataDir = join(tmpdir(), `squish-list-recent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const { SquishRuntime } = await import('../../core/runtime/squish-runtime.js');
    const dbMod = await import('../../db/index.js');
    client = new SquishRuntime();
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
    for (const [key, value] of savedTrustEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

    const times = memories.map((memory) => {
      expect(memory.createdAt).toBeInstanceOf(Date);
      return memory.createdAt!.getTime();
    });
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

  test('strict reads omit unsigned timestamps and hoursBack excludes unknown age', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-list-recent-caller';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-list-recent-test';

    const memory = await client.remember('strict 48-hour list recent fixture', {
      project: PROJECT,
      type: 'note',
      user: 'strict-list-recent-caller',
    });
    expect(memory.createdAt).toBeUndefined();
    expect(memory.updatedAt).toBeUndefined();
    const sqlite = (await getDb() as any).$client;
    sqlite.prepare('UPDATE memories SET created_at = ? WHERE id = ?')
      .run(Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000), memory.id);

    const recent = await client.getRecent(50, PROJECT);
    const strictMemory = recent.find((candidate) => candidate.id === memory.id);
    expect(strictMemory).toBeDefined();
    expect(strictMemory?.createdAt).toBeUndefined();
    expect(strictMemory?.updatedAt).toBeUndefined();

    const withinWindow = await client.listRecent({ limit: 50, project: PROJECT, hoursBack: 24 });
    expect(withinWindow.some((candidate) => candidate.id === memory.id)).toBe(false);
  });

  test('project scoping excludes memories from other projects', async () => {
    const otherProject = `${PROJECT}-other`;
    await client.remember('list-recent delta entry elsewhere', { project: otherProject, type: 'note' });

    const scoped = await client.listRecent({ limit: 10, project: PROJECT });
    expect(scoped.every((m) => !m.content.includes('delta'))).toBe(true);
  });
});
