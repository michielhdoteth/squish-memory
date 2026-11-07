/**
 * WS2b: supersession-evidence consumption tests for search-evidence.
 *
 * Contract under test: contradiction supersession creates association edges
 * FROM the replacing memory TO the replaced memory
 * (`applySupersession -> createAssociation(newMemoryId, oldId, ...)`), so the
 * `temporal.supersededBy` pointer belongs on the OLD side and must name the
 * successor. The from-side (current) memory must never receive a
 * self-referential supersededBy. Both endpoints of a conflict edge keep
 * contradictingCount > 0 (the CONFLICT_CAP regime is untouched - this fix is
 * evidence direction, not ranking/capping behavior).
 *
 * Two layers:
 *  1. Pure unit tests over the extracted edge indexer (synthetic chains that
 *     are NOT in any eval set - the generalization requirement).
 *  2. One end-to-end check through the REAL write path: seed an update chain
 *     ("X now ... instead of ..."), let the contradiction resolver link it,
 *     then prove collectDbMeta reads the direction correctly.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

import { indexAssociationEdges, collectDbMeta } from '../../../core/memory/search-evidence.js';

const testDataDir = join(
  tmpdir(),
  `squish-se-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
mkdirSync(testDataDir, { recursive: true });

const originalEnv = {
  SQUISH_DATA_DIR: process.env.SQUISH_DATA_DIR,
  DATABASE_URL: process.env.DATABASE_URL,
  SQUISH_EMBEDDINGS_PROVIDER: process.env.SQUISH_EMBEDDINGS_PROVIDER,
  SQUISH_LOCAL_BUNDLED_MODEL: process.env.SQUISH_LOCAL_BUNDLED_MODEL,
};

process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off'; // deterministic offline TF-IDF

describe('WS2b indexAssociationEdges: supersession direction (pure)', () => {
  test('updates edge from NEW to OLD puts supersededBy on the OLD side only', () => {
    const ids = ['new-id', 'old-id'];
    const edges = [{ fromMemoryId: 'new-id', toMemoryId: 'old-id', associationType: 'updates' }];
    const out = indexAssociationEdges(ids, edges);

    const oldEntry = out.get('old-id')!;
    expect(oldEntry.supersededBy).toBe('new-id');
    expect(oldEntry.contradictingCount).toBe(1);

    const newEntry = out.get('new-id')!;
    expect(newEntry.supersededBy).toBeNull(); // never self-referential
    expect(newEntry.contradictingCount).toBe(1); // contested fact still caps trust
  });

  test('three-version chain v3->v2->v1: every version points at its direct successor', () => {
    // Fresh synthetic update chain (not an eval-set fixture): same subject
    // restated twice over time; each successor supersedes its predecessor.
    const ids = ['v1', 'v2', 'v3'];
    const edges = [
      { fromMemoryId: 'v2', toMemoryId: 'v1', associationType: 'supersedes' },
      { fromMemoryId: 'v3', toMemoryId: 'v2', associationType: 'updates' },
    ];
    const out = indexAssociationEdges(ids, edges);

    expect(out.get('v1')!.supersededBy).toBe('v2');
    expect(out.get('v2')!.supersededBy).toBe('v3');
    expect(out.get('v3')!.supersededBy).toBeNull(); // current version wins, unpointed
    // v2 is both replaced (by v3) and a replacer (of v1): two conflict edges.
    expect(out.get('v2')!.contradictingCount).toBe(2);
    expect(out.get('v1')!.contradictingCount).toBe(1);
    expect(out.get('v3')!.contradictingCount).toBe(1);
  });

  test('contradicts/merged/duplicate edges count conflicts without a successor pointer', () => {
    const ids = ['a', 'b'];
    const out = indexAssociationEdges(ids, [
      { fromMemoryId: 'a', toMemoryId: 'b', associationType: 'contradicts' },
      { fromMemoryId: 'a', toMemoryId: 'b', associationType: 'merged' },
      { fromMemoryId: 'a', toMemoryId: 'b', associationType: 'duplicate' },
    ]);
    expect(out.get('a')!.supersededBy).toBeNull();
    expect(out.get('b')!.supersededBy).toBeNull();
    expect(out.get('a')!.contradictingCount).toBe(3);
    expect(out.get('b')!.contradictingCount).toBe(3);
  });

  test('non-conflict types count as support on both ends', () => {
    const out = indexAssociationEdges(['x', 'y'], [
      { fromMemoryId: 'x', toMemoryId: 'y', associationType: 'co_occurred' },
      { fromMemoryId: 'x', toMemoryId: 'y', associationType: 'near_duplicate' },
    ]);
    expect(out.get('x')!.supportingCount).toBe(2);
    expect(out.get('y')!.supportingCount).toBe(2);
    expect(out.get('x')!.contradictingCount).toBe(0);
    expect(out.get('y')!.contradictingCount).toBe(0);
  });

  test('edges between two endpoint-ids that are both watched still count the from side once', () => {
    // Regression guard: a supersedes edge touching the result set on both
    // ends increments contradictingCount on BOTH endpoints (the cap regime
    // is symmetric) but the supersededBy pointer appears ONLY on the old end.
    const out = indexAssociationEdges(['n', 'o'], [
      { fromMemoryId: 'n', toMemoryId: 'o', associationType: 'supersedes' },
    ]);
    expect(out.get('n')!.contradictingCount).toBe(1);
    expect(out.get('o')!.contradictingCount).toBe(1);
    expect(out.get('n')!.supersededBy).toBeNull();
    expect(out.get('o')!.supersededBy).toBe('n');
  });

  test('edges touching only one watched id count that id; unwatched ends are skipped', () => {
    const out = indexAssociationEdges(['mine'], [
      { fromMemoryId: 'mine', toMemoryId: 'elsewhere', associationType: 'updates' },
    ]);
    expect(out.get('mine')!.contradictingCount).toBe(1);
    expect(out.get('mine')!.supersededBy).toBeNull();
    expect(out.has('elsewhere')).toBe(false);
  });

  test('empty id set or empty rows produce an empty map', () => {
    expect(indexAssociationEdges([], [{ fromMemoryId: 'a', toMemoryId: 'b', associationType: 'updates' }]).size).toBe(0);
    expect(indexAssociationEdges(['a'], []).size).toBe(0);
  });
});

describe('WS2b supersession evidence end-to-end (real write path, synthetic chain)', () => {
  let dbRef: any;
  let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;

  beforeAll(async () => {
    const dbMod = await import('../../../db/index.js');
    dbMod.resetDb();
    dbRef = await dbMod.getDb();
    const memMod = await import('../../../core/memory/memories.js');
    rememberMemory = memMod.rememberMemory;
  });

  afterAll(() => {
    try {
      const client = dbRef?.$client;
      if (client && typeof client.close === 'function') client.close();
    } catch {}
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch {}
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('write-path update chain: stale row carries the successor pointer, current row does not', async () => {
    // Fresh synthetic chain (NOT in the penalty/golden eval sets): the new
    // statement carries an update indicator ("now", "instead of") and shares
    // its subject with the predecessor, so the REAL contradiction resolver
    // supersedes the old row and links v2 -> v1 with an 'updates' edge.
    const stale = await rememberMemory({
      content: 'Northwind Analytics aggregates events with the Segment stack.',
      type: 'fact',
      project: 'ws2b-supersession-proof',
    });
    const current = await rememberMemory({
      content: 'Northwind Analytics now aggregates events with RudderStack instead of the Segment stack.',
      type: 'fact',
      project: 'ws2b-supersession-proof',
    });

    // The resolver dispatch is fire-and-forget; wait for both its lifecycle
    // update and canonical edge write to settle before asserting evidence.
    const sqlite = (dbRef as any).$client;
    const { getMemoryAssociationRows } = await import('../../../core/associations.js');
    const statusOf = (id: string): string | undefined =>
      sqlite.prepare('SELECT status FROM memories WHERE id = ?').get(id)?.status;
    const deadline = Date.now() + 10_000;
    let relations = await getMemoryAssociationRows([current.id, stale.id]);
    while ((statusOf(stale.id) !== 'superseded' || !relations.some((edge) => edge.fromMemoryId === current.id && edge.toMemoryId === stale.id)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      relations = await getMemoryAssociationRows([current.id, stale.id]);
    }
    expect(statusOf(stale.id)).toBe('superseded');
    expect(statusOf(current.id)).toBe('active');

    const { conflictsById } = await collectDbMeta([current.id, stale.id]);

    // The STALE version knows which memory replaced it (so consumers can
    // demote/exclude it for current-referencing queries):
    expect(conflictsById.get(stale.id)?.supersededBy).toBe(current.id);
    // The CURRENT version must not claim to be superseded by itself or
    // anything else - it is the winner of the chain:
    expect(conflictsById.get(current.id)?.supersededBy ?? null).toBeNull();
    // Cap symmetry preserved: BOTH endpoints of the conflict edge remain
    // contested (CONFLICT_CAP behavior is unchanged by this fix).
    expect((conflictsById.get(stale.id)?.contradictingCount ?? 0)).toBeGreaterThan(0);
    expect((conflictsById.get(current.id)?.contradictingCount ?? 0)).toBeGreaterThan(0);
  }, 20_000);
});
