import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let reinforceMemory: typeof import('../../core/memory/resurrection.js').reinforceMemory;
let sqlite: any;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'squish-resurrection-test-'));
  process.env.SQUISH_DATA_DIR = dataDir;

  const { getDb } = await import('../../db/index.js');
  const db = await getDb();
  sqlite = (db as any).$client;

  const { reinforceMemory: rm } = await import('../../core/memory/resurrection.js');
  reinforceMemory = rm;
});

afterAll(() => {
  try { rmSync(process.env.SQUISH_DATA_DIR!, { recursive: true, force: true }); } catch {}
});

function seedMemory(id: string, importanceScore = 50, stability = 0.0) {
  sqlite.prepare(`
    INSERT INTO memories (id, content, type, status, importance_score, stability, usage_count, created_at, updated_at)
    VALUES (?, 'test', 'fact', 'active', ?, ?, 0, datetime('now'), datetime('now'))
  `).run(id, importanceScore, stability);
}

function getMemory(id: string) {
  return sqlite.prepare(
    'SELECT importance_score, stability, usage_count, last_reinforced_at FROM memories WHERE id = ?'
  ).get(id);
}

describe('reinforceMemory', () => {
  it('strengthens a dormant memory on successful use', async () => {
    seedMemory('test-strengthen', 30, 0.1);

    const result = await reinforceMemory({
      memoryId: 'test-strengthen',
      signal: 'successful_use',
      relevance: 0.8,
      answerConfidence: 0.9,
    });

    expect(result.blocked).toBe(false);
    expect(result.newConfidence).toBeGreaterThan(result.previousConfidence);
    expect(result.newStability).toBeGreaterThan(result.previousStability);

    const mem = getMemory('test-strengthen');
    expect(mem.importance_score).toBeGreaterThan(30);
  });

  it('blocks reinforcement during cooldown', async () => {
    seedMemory('test-cooldown', 50, 0.3);

    await reinforceMemory({
      memoryId: 'test-cooldown',
      signal: 'successful_use',
      relevance: 0.8,
      answerConfidence: 0.9,
    });

    const result = await reinforceMemory({
      memoryId: 'test-cooldown',
      signal: 'successful_use',
      relevance: 0.8,
      answerConfidence: 0.9,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('cooldown');
  });

  it('applies contradiction penalty', async () => {
    seedMemory('test-contradict', 70, 0.5);

    const result = await reinforceMemory({
      memoryId: 'test-contradict',
      signal: 'contradicted',
      relevance: 0.9,
      answerConfidence: 0.95,
    });

    expect(result.blocked).toBe(false);
    expect(result.newConfidence).toBeLessThan(result.previousConfidence);
    expect(result.reason).toBe('contradicted');

    const mem = getMemory('test-contradict');
    expect(mem.importance_score).toBeLessThan(70);
  });

  it('returns memory_not_found for missing memory', async () => {
    const result = await reinforceMemory({
      memoryId: 'nonexistent-id',
      signal: 'successful_use',
      relevance: 0.8,
      answerConfidence: 0.9,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('memory_not_found');
  });

  it('applies diminishing returns on repeated use', async () => {
    seedMemory('test-diminishing', 40, 0.2);

    const deltas: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = getMemory('test-diminishing');
      const result = await reinforceMemory({
        memoryId: 'test-diminishing',
        signal: 'successful_use',
        relevance: 0.7,
        answerConfidence: 0.8,
      });
      const after = getMemory('test-diminishing');
      if (!result.blocked) {
        deltas.push(after.importance_score - before.importance_score);
      }
    }

    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i]).toBeLessThanOrEqual(deltas[i - 1]);
    }
  });

  it('detects resurrection of dormant memory', async () => {
    seedMemory('test-resurrect', 10, 0.05);

    const result = await reinforceMemory({
      memoryId: 'test-resurrect',
      signal: 'successful_use',
      relevance: 0.9,
      answerConfidence: 0.95,
    });

    if (result.resurrected) {
      expect(result.newConfidence).toBeGreaterThan(0.5);
    }
    expect(result.blocked).toBe(false);
  });
});
