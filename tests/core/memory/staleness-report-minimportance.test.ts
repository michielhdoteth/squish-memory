/**
 * `buildStalenessReport` must not silently ignore an out-of-range
 * `minImportance`.
 *
 * The MCP tool clamps the value into [0, 1], but `SquishRuntime.stalenessReport`
 * and any direct caller do not. The old guard was `minImportance > 0`, so 0, -1
 * and undefined all collapsed to "no filter": a caller asking for the LEAST
 * important memories got the whole corpus instead, with no error and no signal.
 *
 * These tests pin the clamp and the non-finite guard.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-stale-clamp-'));
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';

const { resetDb, getDb } = await import('../../../db/index.js');
const { rememberMemory } = await import('../../../core/memory/memories.js');
const { buildStalenessReport } = await import('../../../core/memory/staleness-report.js');

let importantId: string;
let unimportantId: string;

afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  delete process.env.SQUISH_DATA_DIR;
});

async function idsFor(minImportance?: number): Promise<string[]> {
  const report = await buildStalenessReport({ olderThanDays: 30, minImportance, limit: 100 });
  return report.groups.flatMap((group) => group.items.map((item) => item.memoryId));
}

describe('buildStalenessReport clamps minImportance', () => {
  beforeAll(async () => {
    resetDb();
    importantId = (await rememberMemory({ content: 'stale but important decision record', type: 'fact' })).id;
    unimportantId = (await rememberMemory({ content: 'stale and unimportant scratch note', type: 'note' })).id;

    const sqlite = (await getDb() as any).$client;
    const cutoff = Math.floor((Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000);
    sqlite.prepare('UPDATE memories SET updated_at = ? WHERE id IN (?, ?)').run(cutoff, importantId, unimportantId);
    sqlite.prepare('UPDATE memories SET importance_score = 80 WHERE id = ?').run(importantId);
    sqlite.prepare('UPDATE memories SET importance_score = 10 WHERE id = ?').run(unimportantId);
  });

  test('undefined means no filter', async () => {
    const ids = await idsFor(undefined);
    expect(ids).toContain(importantId);
    expect(ids).toContain(unimportantId);
  });

  test('a negative minImportance is clamped to 0 and means no filter, not "everything important"', async () => {
    // -1 is the value the old `> 0` guard silently dropped. It must now behave
    // exactly like 0: no filter, low-importance rows included.
    const ids = await idsFor(-1);
    expect(ids).toContain(importantId);
    expect(ids).toContain(unimportantId);
  });

  test('a minImportance above 1 is clamped to 1, not to an unreachable score', async () => {
    // 5 previously filtered on `importance_score >= 500`. No row can reach
    // that, so a caller asking for "importance at least 5" got an empty report
    // that looked like "nothing is stale" rather than "that argument was out of
    // range". Clamped to 1 it selects the max-importance rows.
    const sqlite = (await getDb() as any).$client;
    const cutoff = Math.floor((Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000);
    sqlite.prepare('UPDATE memories SET importance_score = 100, updated_at = ? WHERE id = ?').run(cutoff, importantId);

    const ids = await idsFor(5);
    expect(ids).toContain(importantId);
    expect(ids).not.toContain(unimportantId);

    // Identical to asking for exactly 1: the clamp, not a silent reinterpretation.
    const atOne = await idsFor(1);
    expect(new Set(ids)).toEqual(new Set(atOne));

    sqlite.prepare('UPDATE memories SET importance_score = 80 WHERE id = ?').run(importantId);
  });

  test('a non-finite minImportance is ignored rather than silently emptying the report', async () => {
    const ids = await idsFor(Number.NaN);
    expect(ids).toContain(importantId);
    expect(ids).toContain(unimportantId);
  });
});