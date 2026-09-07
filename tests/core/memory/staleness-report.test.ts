/**
 * Staleness report coverage: grouping by tag/source, suggested actions, digest format.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-stale-report-'));
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';

const { resetDb, getDb } = await import('../../../db/index.js');
const { rememberMemory } = await import('../../../core/memory/memories.js');
const { getOrCreateProject } = await import('../../../core/projects.js');
const { buildStalenessReport } = await import('../../../core/memory/staleness-report.js');

afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  delete process.env.SQUISH_DATA_DIR;
});

describe('staleness report', () => {
  let oldMemoryId: string;
  let recentMemoryId: string;
  let tempMemoryId: string;

  beforeAll(async () => {
    resetDb();

    const oldMem = await rememberMemory({
      content: 'old important memory',
      type: 'fact',
      tags: ['important'],
    });
    oldMemoryId = oldMem.id;

    const recentMem = await rememberMemory({
      content: 'recent memory',
      type: 'fact',
    });
    recentMemoryId = recentMem.id;

    const tempMem = await rememberMemory({
      content: 'temp memory',
      type: 'note',
      tags: ['temporary'],
    });
    tempMemoryId = tempMem.id;

    const sqlite = (await getDb()).$client;
    const cutoff = Math.floor((Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000);
    sqlite.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(cutoff, oldMemoryId);
    sqlite.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(cutoff, tempMemoryId);
  });

  test('groups stale memories by first tag/source', async () => {
    const report = await buildStalenessReport({ olderThanDays: 30, limit: 100 });
    expect(report.generatedAt).toBeTruthy();
    expect(report.groups.length).toBeGreaterThanOrEqual(2);

    const importantGroup = report.groups.find((g) => g.group === 'important');
    expect(importantGroup).toBeTruthy();
    expect(importantGroup!.count).toBeGreaterThanOrEqual(1);
    expect(importantGroup!.items.some((item) => item.memoryId === oldMemoryId)).toBe(true);
    expect(importantGroup!.items.some((item) => item.suggestedAction === 'update')).toBe(true);

    const temporaryGroup = report.groups.find((g) => g.group === 'temporary');
    expect(temporaryGroup).toBeTruthy();
    expect(temporaryGroup!.items.some((item) => item.memoryId === tempMemoryId)).toBe(true);
    expect(temporaryGroup!.items.some((item) => item.suggestedAction === 'forget')).toBe(true);
  });

  test('respects olderThanDays cutoff', async () => {
    const report = await buildStalenessReport({ olderThanDays: 1, limit: 100 });
    const staleIds = report.groups.flatMap((g) => g.items.map((item) => item.memoryId));
    expect(staleIds).not.toContain(recentMemoryId);
  });
});
