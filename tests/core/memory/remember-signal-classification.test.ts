/**
 * Regression tests for DEFECT 3 (keystone): fresh squish_remember writes were
 * classified 'legacy-durable'.
 *
 * Root cause: the write path (core/memory/memory-write.ts enrichedMetadata)
 * stored the key `memorySignals` and never wrote `signal.classification`,
 * while the reader (core/memory/explain.ts) only honored `signal.classification`
 * (or a top-level `classification`). No fresh write could ever match, so every
 * memory classified as the legacy default.
 *
 * Fix contract:
 *  a) rememberMemory persists `signal: { classification: 'durable-distilled',
 *     reasons, capturedAt }` alongside the untouched `memorySignals` block;
 *  b) explainMemory also accepts `memorySignals.classification` as a fallback
 *     so pre-unification rows classify correctly, keeping 'legacy-durable'
 *     only as the last resort.
 *
 * Real isolated SQLite database (temp SQUISH_DATA_DIR), like the other
 * core/memory tests.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

const testDataDir = join(
  tmpdir(),
  `squish-signal-class-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
mkdirSync(testDataDir, { recursive: true });
const originalDataDir = process.env.SQUISH_DATA_DIR;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalEmbeddingsProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';

let resetDb: typeof import('../../../db/index.js').resetDb;
let getDb: typeof import('../../../db/index.js').getDb;
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let explainMemory: typeof import('../../../core/memory/explain.js').explainMemory;

const PROJECT = '/remember-signal-classification';

function getSqlite(): any {
  return (dbRef as any).$client;
}

let dbRef: any;

describe('DEFECT 3: remember-writes classify as durable-distilled, not legacy-durable', () => {
  beforeAll(async () => {
    const dbMod = await import('../../../db/index.js');
    resetDb = dbMod.resetDb;
    getDb = dbMod.getDb;
    ({ rememberMemory } = await import('../../../core/memory/memories.js'));
    ({ explainMemory } = await import('../../../core/memory/explain.js'));

    resetDb();
    dbRef = await getDb();
  });

  afterAll(() => {
    try {
      const client = dbRef?.$client;
      if (client && typeof client.close === 'function') client.close();
    } catch {
      // ignore
    }
    try {
      resetDb();
    } catch {
      // ignore
    }
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // Windows may hold the file briefly; temp dir is harmless
    }
    const restore = (key: string, original?: string) => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    };
    restore('SQUISH_DATA_DIR', originalDataDir);
    restore('DATABASE_URL', originalDatabaseUrl);
    restore('SQUISH_EMBEDDINGS_PROVIDER', originalEmbeddingsProvider);
  });

  test('fresh remember write inspects as durable-distilled with metadata availability', async () => {
    const record = await rememberMemory({
      content: 'Remember: the release gate requires the full test suite to be green.',
      type: 'decision',
      project: PROJECT,
      tags: ['release'],
    });

    const inspection = await explainMemory(record.id);
    expect(inspection).not.toBeNull();

    // Pre-fix: signal.classification never existed on fresh writes, so this
    // fell through to the 'legacy-durable' default.
    expect(inspection!.classification).toBe('durable-distilled');
    expect(inspection!.classification).not.toBe('legacy-durable');
    // Metadata availability: the legacy flag (rendered as "Legacy metadata:
    // yes" in the summary) must be false for a fresh write.
    expect(inspection!.legacyMetadata).toBe(false);
  });

  test('remember metadata persists the signal block without breaking memorySignals', async () => {
    const record = await rememberMemory({
      content: 'Preference: I like concise changelog entries.',
      type: 'preference',
      project: PROJECT,
    });

    const row = getSqlite()
      .prepare('SELECT metadata FROM memories WHERE id = ?')
      .get(record.id) as { metadata: string };
    const metadata = JSON.parse(row.metadata);

    expect(metadata.signal).toBeDefined();
    expect(metadata.signal.classification).toBe('durable-distilled');
    expect(Array.isArray(metadata.signal.reasons)).toBe(true);
    expect(typeof metadata.signal.capturedAt).toBe('number');
    expect(metadata.signal.capturedAt).toBeGreaterThan(0);

    // Existing consumers of the old key must not break.
    expect(metadata.memorySignals).toBeDefined();
    expect(metadata.memorySignals.requiresConflictCheck !== undefined).toBe(true);
  });

  test('remember persists a validated source time zone for later temporal interpretation', async () => {
    const record = await rememberMemory({
      content: 'The appointment is tomorrow.',
      type: 'fact',
      project: PROJECT,
      occurredAt: '2024-03-10T08:30:00.000Z',
      timeZone: 'America/Los_Angeles',
    });
    const row = getSqlite().prepare('SELECT metadata FROM memories WHERE id = ?').get(record.id) as { metadata: string };
    expect(JSON.parse(row.metadata).sourceTimeZone).toBe('America/Los_Angeles');
  });

  test('rejects an invalid source time zone before writing a memory', async () => {
    await expect(rememberMemory({
      content: 'This should not be persisted.',
      type: 'fact',
      project: PROJECT,
      timeZone: 'Mars/Olympus',
    })).rejects.toThrow('Invalid IANA time zone');
  });

  test('explain reader accepts the legacy memorySignals.classification shape', async () => {
    // Simulates a row written before key unification: no signal block, but
    // the memorySignals block carries a classification.
    const legacyId = 'legacy-signals-row-0000-0000000001';
    getSqlite()
      .prepare(
        `INSERT INTO memories (id, type, content, metadata, is_active, is_merged, is_mergeable, source)
         VALUES (?, 'fact', ?, ?, 1, 0, 1, 'test')`
      )
      .run(
        legacyId,
        'A memory written by the old writer that stored memorySignals.classification.',
        JSON.stringify({
          memorySignals: { classification: 'durable-raw+distilled', priority: 'high' },
        })
      );

    const inspection = await explainMemory(legacyId);
    expect(inspection).not.toBeNull();
    expect(inspection!.classification).toBe('durable-raw+distilled');
    expect(inspection!.legacyMetadata).toBe(false);
  });

  test('rows with no signal metadata still fall back to legacy-durable', async () => {
    const plainId = 'plain-legacy-row-0000-0000000001';
    getSqlite()
      .prepare(
        `INSERT INTO memories (id, type, content, metadata, is_active, is_merged, is_mergeable, source)
         VALUES (?, 'note', ?, ?, 1, 0, 1, 'test')`
      )
      .run(plainId, 'A pre-signal-era row with unrelated metadata.', JSON.stringify({ origin: 'old' }));

    const inspection = await explainMemory(plainId);
    expect(inspection).not.toBeNull();
    expect(inspection!.classification).toBe('legacy-durable');
    expect(inspection!.legacyMetadata).toBe(true);
  });
});
