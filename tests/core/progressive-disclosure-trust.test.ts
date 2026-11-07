import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDataDir = mkdtempSync(join(tmpdir(), 'squish-progressive-disclosure-trust-'));
const originalDataDir = process.env.SQUISH_DATA_DIR;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalSquishDatabaseUrl = process.env.SQUISH_DATABASE_URL;
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
delete process.env.SQUISH_DATABASE_URL;

const { closeAllDbs, getDb } = await import('../../db/index.js');
const {
  allocateTokenBudget,
  createLightweightIndex,
  deleteLightweightIndex,
  estimateTokenCount,
  getPreloadCandidates,
  loadFullMemory,
  preloadCandidateMemories,
  searchLightweightIndices,
  updateIndexImportance,
} = await import('../../core/memory/progressive-disclosure.js');

afterAll(async () => {
  await closeAllDbs();
  try { rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may retain a closed SQLite handle briefly. */ }
  if (originalDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = originalDataDir;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalSquishDatabaseUrl === undefined) delete process.env.SQUISH_DATABASE_URL;
  else process.env.SQUISH_DATABASE_URL = originalSquishDatabaseUrl;
});

test('strict trust denies unscoped progressive-disclosure access and index mutations', async () => {
  const previousPolicy = process.env.SQUISH_TRUST_POLICY;
  const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
  process.env.SQUISH_TRUST_POLICY = 'strict';
  process.env.SQUISH_TRUSTED_CALLER_ID = 'progressive-disclosure-test-caller';
  try {
    await expect(createLightweightIndex('private-memory', 'private preview content', 'fact', 50))
      .rejects.toThrow('caller-scoped memory authorization');
    await expect(searchLightweightIndices('private-project', 'private preview'))
      .rejects.toThrow('caller-scoped memory authorization');
    await expect(loadFullMemory('private-memory')).rejects.toThrow('caller-scoped memory authorization');
    await expect(allocateTokenBudget('private-session', 512)).rejects.toThrow('caller-scoped memory authorization');
    await expect(preloadCandidateMemories('private-session', 'private-project', 512, []))
      .rejects.toThrow('caller-scoped memory authorization');
    await expect(getPreloadCandidates('private-session')).rejects.toThrow('caller-scoped memory authorization');
    await expect(updateIndexImportance('private-memory', 20)).rejects.toThrow('caller-scoped memory authorization');
    await expect(deleteLightweightIndex('private-memory')).rejects.toThrow('caller-scoped memory authorization');
    expect(await estimateTokenCount('1234')).toBe(1);
  } finally {
    if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
    else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
    else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
  }

  const sqlite = (await getDb() as any).$client;
  const audits = sqlite.prepare(`SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log
    WHERE asset_type = 'memory_index' AND reason = 'strict_surface'`).all();
  expect(audits).toHaveLength(8);
  expect(audits.every((row: { actor_hash: string; resource_hash: string; decision: string; reason: string }) =>
    row.actor_hash === createHash('sha256').update('progressive-disclosure-test-caller').digest('hex') &&
    row.resource_hash === createHash('sha256').update('progressive_disclosure').digest('hex') &&
    row.decision === 'deny' && row.reason === 'strict_surface')).toBe(true);
});
