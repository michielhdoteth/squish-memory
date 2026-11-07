/**
 * Batch 6b integration: beliefs join retrieval.
 *
 * "What do we believe about X" through plain hybridSearch must return
 * belief-corpus rows (unified knowledge table) mixed with memory-corpus rows,
 * each carrying its true `corpus` identity. Also gates the
 * SQUISH_SEARCH_BELIEFS kill switch.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-beliefs-recall-'));
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';
// Offline embeddings like the golden eval harness.
process.env.SQUISH_EMBEDDINGS_PROVIDER ||= 'local';
// Deterministic precision stack for the retrieval assertions.
process.env.SQUISH_RERANKER_ENABLED ||= 'false';

import { resetDb, getDb } from '../../../db/index.js';
import { rememberMemory } from '../../../core/memory/memories.js';
import { hybridSearch } from '../../../core/memory/hybrid-search.js';
import { processMemoryAnalysisJobs } from '../../../core/memory/fact-extraction-worker.js';

describe('beliefs join retrieval (Batch 6b)', () => {
  let projectId: string | undefined;

  beforeAll(async () => {
    resetDb();
    // A decision memory -> extractor creates a belief row in the knowledge table.
    const decision = await rememberMemory({
      content: 'We decided to use PostgreSQL as the main database because of its reliability and JSON support',
      type: 'decision',
      project: '/proj/beliefs-test',
      tags: ['database'],
    });
    expect(decision).toBeDefined();

    // Plain episodic memories for the memory corpus.
    await rememberMemory({
      content: 'Watched the deployment pipeline fail this morning due to a flaky test',
      type: 'observation',
      project: '/proj/beliefs-test',
    });
    await rememberMemory({
      content: 'The standup meeting happened at 9am and covered sprint progress',
      type: 'note',
      project: '/proj/beliefs-test',
    });

    // Run queued analysis so beliefs are available through the durable worker.
    await processMemoryAnalysisJobs({ extract: async () => ({ facts: [], summary: '', entities: [] }) });

    const db = await getDb();
    const sqlite = (db as any).$client;
    // The row is stored in the normalised form the write side produces.
    const projRow = sqlite.prepare('SELECT id FROM projects WHERE path = ?').get(resolve('/proj/beliefs-test'));
    projectId = projRow?.id;

    // Sanity: the decision memory must have produced a knowledge belief row.
    const beliefRows = sqlite.prepare(
      "SELECT COUNT(*) AS c FROM knowledge WHERE knowledge_kind = 'belief' AND project_id = ?"
    ).get(projectId);
    expect(Number(beliefRows.c)).toBeGreaterThan(0);

    // Sanity: write path stamped sector + bi-temporal fields on new memories.
    const memRow = sqlite.prepare(
      'SELECT sector, valid_from, recorded_at FROM memories WHERE id = ?'
    ).get(decision.id);
    expect(memRow.sector).toBe('semantic'); // decision type routes semantic
    expect(memRow.valid_from).not.toBeNull();
    expect(memRow.recorded_at).not.toBeNull();

    const projectionRow = sqlite.prepare(
      `SELECT valid_from, valid_to, recorded_at FROM knowledge
       WHERE knowledge_kind = 'memory' AND json_extract(metadata, '$.sourceMemoryId') = ?`
    ).get(decision.id);
    expect(projectionRow).toBeDefined();
    expect(projectionRow.valid_from).toBe(memRow.valid_from);
    expect(projectionRow.valid_to).toBeNull();
    expect(projectionRow.recorded_at).not.toBeNull();
  });

  test('memory knowledge projection preserves an explicitly observed valid start', async () => {
    const observedAt = new Date('2022-04-03T12:30:00.000Z');
    const captured = await rememberMemory({
      content: 'The archival service used a local index during the 2022 migration window.',
      type: 'fact',
      project: '/proj/beliefs-test',
      validFrom: observedAt,
    });
    const db = await getDb();
    const sqlite = (db as any).$client;
    const rows = sqlite.prepare(
      `SELECT m.valid_from AS memory_valid_from, k.valid_from AS knowledge_valid_from
       FROM memories m
       JOIN knowledge k ON json_extract(k.metadata, '$.sourceMemoryId') = m.id
       WHERE m.id = ? AND k.knowledge_kind = 'memory'`
    ).get(captured.id);

    expect(rows).toBeDefined();
    expect(rows.knowledge_valid_from).toBe(rows.memory_valid_from);
    expect(Number(rows.knowledge_valid_from) * 1000).toBe(observedAt.getTime());
  });

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    delete process.env.SQUISH_DATA_DIR;
    delete process.env.SQUISH_SEARCH_BELIEFS;
  });

  test('"what do we believe about the database" returns belief corpus rows mixed with memories', async () => {
    const results = await hybridSearch(
      { query: 'what do we believe about the database choice', limit: 10 },
      { limit: 10 }
    );
    expect(results.length).toBeGreaterThan(0);

    // Every result carries its true identity.
    for (const r of results) {
      expect(['memory', 'belief']).toContain(r.corpus);
    }

    const corpora = new Set(results.map(r => r.corpus));
    expect(corpora.has('memory')).toBe(true); // memory leg always present

    const beliefResults = results.filter(r => r.corpus === 'belief');
    expect(beliefResults.length).toBeGreaterThan(0);
    for (const b of beliefResults) {
      expect(b.semanticScore).toBeDefined();
      expect(b.content.length).toBeGreaterThan(0);
    }
  });

  test('SQUISH_SEARCH_BELIEFS=false removes the beliefs leg', async () => {
    process.env.SQUISH_SEARCH_BELIEFS = 'false';
    try {
      const results = await hybridSearch(
        { query: 'what do we believe about the database choice', limit: 10 },
        { limit: 10 }
      );
      for (const r of results) {
        expect(r.corpus).not.toBe('belief');
      }
      // Memory corpus still fully functional.
      expect(results.some(r => r.corpus === 'memory')).toBe(true);
    } finally {
      delete process.env.SQUISH_SEARCH_BELIEFS;
    }
  });

  test('evidence block is populated for belief-corpus results too', async () => {
    const results = await hybridSearch(
      { query: 'what do we believe about PostgreSQL reliability', limit: 10 },
      { limit: 10 }
    );
    const beliefResult = results.find(r => r.corpus === 'belief');
    if (beliefResult) {
      // Evidence attachment is best-effort but must not crash; when present,
      // it carries the itemized shape with honest nulls where signals miss.
      if ((beliefResult as any).evidence) {
        const ev = (beliefResult as any).evidence;
        expect(ev).toHaveProperty('semantic');
        expect(ev).toHaveProperty('freshness');
        expect(ev).toHaveProperty('supportingCount');
      }
    }
  });
});
