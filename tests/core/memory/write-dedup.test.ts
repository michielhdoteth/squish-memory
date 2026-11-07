/**
 * WS2a: write-time near-duplicate DETECTION + LINKING tests.
 *
 * Contract under test (docs/ENV-CONFIG.md, .env.example DEDUP section):
 * - SQUISH_WRITE_DEDUP=off (DEFAULT): the remember path performs NO similarity
 *   scan and creates NO associations - byte-identical behavior/latency.
 * - SQUISH_WRITE_DEDUP=link: after the memory is stored, a BOUNDED top-K
 *   similarity search runs in the new memory's project scope; every candidate
 *   above the threshold gets a bidirectional 'near_duplicate' association and
 *   the new memory records metadata.dedup = { detectedAt, similarIds,
 *   maxSimilarity, mode }. NON-destructive: both memories stay active.
 * - SQUISH_WRITE_DEDUP=merge (explicit opt-in): the near-duplicate goes
 *   through the EXISTING reversible merge workflow (proposal row +
 *   handleApproveMerge), producing one canonical with merged-from provenance
 *   that handleReverseMerge can undo. Safety-blocked pairs fall back to link.
 *
 * Determinism: most tests inject a searcher via setWriteDedupSearcherForTesting
 * so near-dup decisions use exact controlled scores (threshold boundary,
 * over-return bounding, cross-scope candidates). Two integration tests run the
 * PRODUCTION searcher (findSimilarMemories over the real hybrid stack with the
 * deterministic offline TF-IDF provider) at a permissive threshold.
 *
 * Isolation pattern mirrors tests/core/algorithms/dedup-approve-embedding-bind.test.ts:
 * real temp SQLite DB, local provider pinned, bundled model off, contradiction
 * resolution skipped (it is an orthogonal async path; exact-duplicate writes
 * would otherwise supersede each other and confound the non-destructive check).
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

const testDataDir = join(
  tmpdir(),
  `squish-wd-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
mkdirSync(testDataDir, { recursive: true });

const originalEnv = {
  SQUISH_DATA_DIR: process.env.SQUISH_DATA_DIR,
  DATABASE_URL: process.env.DATABASE_URL,
  SQUISH_EMBEDDINGS_PROVIDER: process.env.SQUISH_EMBEDDINGS_PROVIDER,
  SQUISH_LOCAL_BUNDLED_MODEL: process.env.SQUISH_LOCAL_BUNDLED_MODEL,
  SQUISH_SKIP_CONTRADICTION: process.env.SQUISH_SKIP_CONTRADICTION,
  SQUISH_WRITE_DEDUP: process.env.SQUISH_WRITE_DEDUP,
  SQUISH_WRITE_DEDUP_THRESHOLD: process.env.SQUISH_WRITE_DEDUP_THRESHOLD,
  SQUISH_WRITE_DEDUP_TOP_K: process.env.SQUISH_WRITE_DEDUP_TOP_K,
  SQUISH_TRUST_POLICY: process.env.SQUISH_TRUST_POLICY,
};

process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off'; // deterministic offline TF-IDF
process.env.SQUISH_SKIP_CONTRADICTION = 'true';
delete process.env.SQUISH_WRITE_DEDUP;
delete process.env.SQUISH_WRITE_DEDUP_THRESHOLD;
delete process.env.SQUISH_WRITE_DEDUP_TOP_K;

const PROJECT_A = 'ws2a-project-a';
const PROJECT_B = 'ws2a-project-b';

let dbRef: any;
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let writeDedup: typeof import('../../../core/memory/write-dedup.js');
let handleReverseMerge: typeof import('../../../core/algorithms/handlers/reverse-merge.js').handleReverseMerge;

function getSqlite(): any {
  return (dbRef as any).$client;
}

function setMode(mode: string | undefined): void {
  if (mode === undefined) delete process.env.SQUISH_WRITE_DEDUP;
  else process.env.SQUISH_WRITE_DEDUP = mode;
}

function resetDbData(): void {
  const sqlite = getSqlite();
  // Children first (FKs reference memories/knowledge); tables that may not
  // exist in every bootstrap generation are tolerated.
  const tables = [
    'memory_associations',
    'memory_tags',
    'memory_analysis_jobs',
    'memory_merge_history',
    'memory_merge_proposals',
    'knowledge_edges',
    'knowledge',
    'memories',
  ];
  for (const table of tables) {
    try {
      sqlite.exec(`DELETE FROM ${table};`);
    } catch {
      // table absent in this schema generation
    }
  }
}

function getRow(id: string): any {
  return getSqlite().prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

function findRowByContent(content: string): any {
  return getSqlite().prepare('SELECT * FROM memories WHERE content = ? LIMIT 1').get(content);
}

function associationsBetween(idA: string, idB: string): any[] {
  return getSqlite()
    .prepare(
      `SELECT e.id,
         json_extract(f.metadata, '$.sourceMemoryId') AS from_memory_id,
         json_extract(t.metadata, '$.sourceMemoryId') AS to_memory_id,
         e.edge_type AS association_type, e.weight, e.metadata
       FROM knowledge_edges e
       JOIN knowledge f ON f.id = e.from_id
       JOIN knowledge t ON t.id = e.to_id
       WHERE (json_extract(f.metadata, '$.sourceMemoryId') = ? AND json_extract(t.metadata, '$.sourceMemoryId') = ?)
          OR (json_extract(f.metadata, '$.sourceMemoryId') = ? AND json_extract(t.metadata, '$.sourceMemoryId') = ?)`
    )
    .all(idA, idB, idB, idA);
}

function associationsForMemory(id: string): any[] {
  return getSqlite().prepare(`
    SELECT e.id, e.edge_type AS association_type
    FROM knowledge_edges e
    JOIN knowledge f ON f.id = e.from_id
    JOIN knowledge t ON t.id = e.to_id
    WHERE json_extract(f.metadata, '$.sourceMemoryId') = ?
       OR json_extract(t.metadata, '$.sourceMemoryId') = ?
  `).all(id, id);
}

function allNearDupAssociations(): any[] {
  return getSqlite().prepare(`SELECT id FROM knowledge_edges WHERE edge_type = 'near_duplicate' AND valid_to IS NULL`).all();
}

function nearDupAssociations(idA: string, idB: string): any[] {
  return associationsBetween(idA, idB).filter((a) => a.association_type === 'near_duplicate');
}

function dedupMetadata(id: string): Record<string, unknown> | null {
  const row = getRow(id);
  if (!row || !row.metadata) return null;
  const meta = JSON.parse(row.metadata);
  return (meta.dedup as Record<string, unknown>) ?? null;
}

/** Minimal near-duplicate candidate shape the searcher seam resolves to. */
type Candidate = { id: string; similarity: number };

function makeRecordingSearcher(
  responses: Candidate[] | ((params: any) => Candidate[])
): { searcher: (params: any) => Promise<Candidate[]>; calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    searcher: async (params: any) => {
      calls.push({ ...params });
      const list = typeof responses === 'function' ? responses(params) : responses;
      // Deep-ish copy so the stage cannot mutate the fixture.
      return list.map((c) => ({ ...c }));
    },
  };
}

async function seedExisting(content: string, project?: string): Promise<string> {
  const mem = await rememberMemory({ content, type: 'fact', ...(project ? { project } : {}) });
  return mem.id;
}

describe('WS2a write-time near-duplicate detection + linking', () => {
  beforeAll(async () => {
    const dbMod = await import('../../../db/index.js');
    dbMod.resetDb();
    dbRef = await dbMod.getDb();

    const memoriesMod = await import('../../../core/memory/memories.js');
    rememberMemory = memoriesMod.rememberMemory;
    writeDedup = await import('../../../core/memory/write-dedup.js');
    const reverseMod = await import('../../../core/algorithms/handlers/reverse-merge.js');
    handleReverseMerge = reverseMod.handleReverseMerge;
  });

  beforeEach(() => {
    resetDbData();
    setMode(undefined);
    delete process.env.SQUISH_TRUST_POLICY;
    delete process.env.SQUISH_WRITE_DEDUP_THRESHOLD;
    delete process.env.SQUISH_WRITE_DEDUP_TOP_K;
    writeDedup.setWriteDedupSearcherForTesting(null);
    writeDedup.resetWriteDedupStats();
  });

  afterAll(() => {
    writeDedup.setWriteDedupSearcherForTesting(null);
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

  // -------------------------------------------------------------------------
  // off (default)
  // -------------------------------------------------------------------------

  describe('mode off (default)', () => {
    test('returned write record preserves the delayed source valid-time start', async () => {
      const occurredAt = new Date('2024-03-10T08:30:00.000Z');
      const memory = await rememberMemory({
        content: 'Imported source event with an original date.',
        type: 'fact',
        project: PROJECT_A,
        occurredAt,
      });

      expect(memory.validFrom).toBe(occurredAt.toISOString());
      expect(Number(getRow(memory.id).valid_from)).toBe(occurredAt.getTime() / 1000);
    });

    test('rejects a framed retrieved-context echo before writing a new memory', async () => {
      const content = '# Session bootstrap\n\n## Verified memories\n- [fact] The service is active (memory:01234567-89ab-cdef-0123-456789abcdef)';
      await expect(rememberMemory({ content, type: 'fact', project: PROJECT_A }))
        .rejects.toThrow('Generated context cannot be stored as a new memory');
      expect(findRowByContent(content)).toBeNull();
    });

    test('remember stores the memory with no association and no similarity scan', async () => {
      const statsBefore = writeDedup.getWriteDedupStats();
      const existing = await seedExisting('the deploy pipeline runs on the 4m-server alias');
      const mem = await rememberMemory({
        content: 'the deploy pipeline runs on the 4m-server alias nightly',
        type: 'fact',
        project: PROJECT_A,
      });

      expect(mem.id).toBeTruthy();
      expect(getRow(mem.id)).toBeDefined();
      expect(getRow(existing)).toBeDefined();
      // No scan ran at all (this is the latency guarantee for the default path):
      expect(writeDedup.getWriteDedupStats().scans).toBe(statsBefore.scans);
      // No dedup association between the two rows:
      expect(nearDupAssociations(mem.id, existing)).toHaveLength(0);
      // No dedup metadata recorded:
      expect(dedupMetadata(mem.id)).toBeNull();
    });

    test('explicit off behaves identically and an invalid mode falls back to off', async () => {
      setMode('off');
      const a = await seedExisting('invalidation check alpha baseline content');
      const b = await rememberMemory({
        content: 'invalidation check alpha baseline content',
        type: 'fact',
        project: PROJECT_A,
      });
      expect(writeDedup.getWriteDedupStats().scans).toBe(0);
      expect(associationsBetween(a, b.id)).toHaveLength(0);

      setMode('not-a-real-mode');
      writeDedup.resetWriteDedupStats();
      const c = await rememberMemory({
        content: 'invalidation check alpha baseline content',
        type: 'fact',
        project: PROJECT_A,
      });
      expect(writeDedup.getWriteDedupStats().scans).toBe(0);
      expect(associationsBetween(c.id, a)).toHaveLength(0);
      expect(associationsBetween(c.id, b.id)).toHaveLength(0);
    });

    test('off does not mutate the stored metadata (no dedup key ever appears)', async () => {
      setMode(undefined);
      const mem = await rememberMemory({
        content: 'metadata purity check for the off mode contract',
        type: 'fact',
        project: PROJECT_A,
      });
      const stored = getRow(mem.id);
      const meta = JSON.parse(stored.metadata);
      expect(meta.dedup).toBeUndefined();
    });
  });

  describe('strict trust proposal boundary', () => {
    test('does not scan or persist plaintext merge proposals', async () => {
      const { calls, searcher } = makeRecordingSearcher([{ id: 'strict-existing', similarity: 0.99 }]);
      writeDedup.setWriteDedupSearcherForTesting(searcher);
      process.env.SQUISH_TRUST_POLICY = 'strict';
      setMode('merge');

      const outcome = await writeDedup.runWriteDedupStage({
        memoryId: 'strict-new-memory',
        content: 'Sensitive content that must not enter an unscoped merge proposal.',
        projectId: PROJECT_A,
      });

      expect(outcome).toBeNull();
      expect(calls).toHaveLength(0);
      expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM memory_merge_proposals').get().count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // link
  // -------------------------------------------------------------------------

  describe('mode link', () => {
    test('near-duplicate write creates bidirectional near_duplicate associations + metadata, both memories survive', async () => {
      setMode('link');
      const existing = await seedExisting('Michiel prefers bun over npm for JS tooling', PROJECT_A);

      const searcher = makeRecordingSearcher([{ id: existing, similarity: 0.93 }]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'Michiel prefers bun over npm for JavaScript tooling',
        type: 'fact',
        project: PROJECT_A,
      });

      const links = nearDupAssociations(mem.id, existing);
      expect(links.length).toBe(2); // new -> existing AND existing -> new
      const directions = new Set(links.map((a) => a.from_memory_id));
      expect(directions.has(mem.id)).toBe(true);
      expect(directions.has(existing)).toBe(true);

      // Confidence metadata lands on the association (similarity as score):
      for (const link of links) {
        const meta = JSON.parse(link.metadata);
        expect(meta.association_confidence.confidence_score).toBeCloseTo(0.93);
        expect(meta.association_confidence.confidence).toBe('EXTRACTED');
      }

      const dedup = dedupMetadata(mem.id);
      expect(dedup).not.toBeNull();
      expect(dedup!.mode).toBe('link');
      expect((dedup!.similarIds as string[])).toEqual([existing]);
      expect(dedup!.maxSimilarity).toBeCloseTo(0.93);
      expect(typeof dedup!.detectedAt).toBe('string');

      // NON-destructive: both memories remain active and unmerged.
      for (const id of [mem.id, existing]) {
        const row = getRow(id);
        expect(Number(row.is_merged)).toBe(0);
        expect(Number(row.is_active)).toBe(1);
        expect(row.merged_into_id).toBeNull();
      }
    });

    test('distinct memory (searcher finds nothing above bar) creates no association and no dedup metadata', async () => {
      setMode('link');
      await seedExisting('kubernetes ingress controller tuning notes', PROJECT_A);

      const searcher = makeRecordingSearcher([]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);
      writeDedup.resetWriteDedupStats(); // ignore scans from the seeding write

      const mem = await rememberMemory({
        content: 'the cat sat on the entirely unrelated windowsill',
        type: 'fact',
        project: PROJECT_A,
      });

      expect(writeDedup.getWriteDedupStats().scans).toBe(1);
      const anyAssoc = associationsForMemory(mem.id).filter((edge) => edge.association_type === 'near_duplicate');
      expect(anyAssoc).toHaveLength(0);
      expect(dedupMetadata(mem.id)).toBeNull();
    });

    test('threshold boundary: below-bar candidates are NOT linked, at/above-bar are', async () => {
      setMode('link'); // default threshold = 0.85 (reused detector bar)
      const below = await seedExisting('boundary probe below-bar memory content', PROJECT_A);
      const at = await seedExisting('boundary probe at-bar memory content', PROJECT_A);
      const above = await seedExisting('boundary probe above-bar memory content', PROJECT_A);

      const searcher = makeRecordingSearcher([
        { id: below, similarity: 0.8499 },
        { id: at, similarity: 0.85 },
        { id: above, similarity: 0.97 },
      ]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'boundary probe memory under threshold test',
        type: 'fact',
        project: PROJECT_A,
      });

      expect(nearDupAssociations(mem.id, below)).toHaveLength(0);
      expect(nearDupAssociations(mem.id, at).length).toBe(2);
      expect(nearDupAssociations(mem.id, above).length).toBe(2);

      const dedup = dedupMetadata(mem.id);
      expect((dedup!.similarIds as string[]).sort()).toEqual([at, above].sort());
      expect(dedup!.maxSimilarity).toBeCloseTo(0.97);

      // The stage passes the configured bar to the searcher too:
      expect(searcher.calls[0].threshold).toBeCloseTo(0.85);
    });

    test('custom threshold knob raises the bar', async () => {
      process.env.SQUISH_WRITE_DEDUP_THRESHOLD = '0.95';
      setMode('link');
      const mid = await seedExisting('custom bar candidate at point nine two', PROJECT_A);
      const high = await seedExisting('custom bar candidate at point nine eight', PROJECT_A);

      const searcher = makeRecordingSearcher([
        { id: mid, similarity: 0.92 },
        { id: high, similarity: 0.98 },
      ]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'custom threshold probe write',
        type: 'fact',
        project: PROJECT_A,
      });

      expect(nearDupAssociations(mem.id, mid)).toHaveLength(0);
      expect(nearDupAssociations(mem.id, high).length).toBe(2);
    });

    test('bounded top-K: searcher over-returning is truncated to the cap (not a full-corpus link)', async () => {
      const many = Array.from({ length: 30 }, (_, i) => `bounded scan probe corpus member ${i} shared wording`);
      // Seed with mode off so corpus seeding itself never runs the stage
      // (keeps the near_duplicate row count attributable to ONE write).
      setMode(undefined);
      const ids: string[] = [];
      for (const content of many) ids.push(await seedExisting(content, PROJECT_A));

      const searcher = makeRecordingSearcher(
        ids.map((id, i) => ({ id, similarity: 0.99 - i * 0.001 }))
      );
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);
      writeDedup.resetWriteDedupStats();
      setMode('link');

      const mem = await rememberMemory({
        content: 'bounded scan probe write triggers the topK cap',
        type: 'fact',
        project: PROJECT_A,
      });

      // One bounded scan, cap requested, not a full-corpus link:
      expect(writeDedup.getWriteDedupStats().scans).toBe(1);
      expect(searcher.calls[0].topK).toBe(5);

      // At most topK candidates linked (5 x 2 directions):
      const links = allNearDupAssociations();
      expect(links.length).toBe(10);

      const dedup = dedupMetadata(mem.id);
      expect((dedup!.similarIds as string[]).length).toBe(5);
    }, 30_000);

    test('link mode requests a PROJECT-SCOPED search, never a global scan', async () => {
      setMode('link');
      const searcher = makeRecordingSearcher([]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      await rememberMemory({
        content: 'scope propagation probe write',
        type: 'fact',
        project: PROJECT_A,
      });

      expect(searcher.calls).toHaveLength(1);
      expect(searcher.calls[0].projectPath).toBe(PROJECT_A);
      expect(typeof searcher.calls[0].projectId).toBe('string');
      expect(searcher.calls[0].projectId.length).toBeGreaterThan(0);
    });

    test('cross-project near-duplicate is NOT linked (strict scope verification)', async () => {
      setMode('link');
      // A near-duplicate living in a DIFFERENT project. The (simulated)
      // searcher leaks it as a candidate; the stage's own verification must
      // drop it because scopes differ.
      const foreign = await seedExisting('cross scope leak candidate shared content', PROJECT_B);

      const searcher = makeRecordingSearcher([{ id: foreign, similarity: 0.98 }]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'cross scope leak candidate shared content',
        type: 'fact',
        project: PROJECT_A,
      });

      expect(nearDupAssociations(mem.id, foreign)).toHaveLength(0);
      expect(dedupMetadata(mem.id)).toBeNull();
      // Both rows still exist (verification only skipped linking):
      expect(getRow(mem.id)).toBeDefined();
      expect(getRow(foreign)).toBeDefined();
    });

    test('self-candidate and already-merged candidates are dropped by verification', async () => {
      setMode('link');
      const merged = await seedExisting('merged candidate should never be relinked', PROJECT_A);
      getSqlite()
        .prepare('UPDATE memories SET is_merged = 1, is_active = 0 WHERE id = ?')
        .run(merged);

      const searcher = makeRecordingSearcher((params: any) => [
        { id: params.excludeId, similarity: 1.0 },
        { id: merged, similarity: 0.99 },
      ]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'verification guards probe write',
        type: 'fact',
        project: PROJECT_A,
      });

      expect(nearDupAssociations(mem.id, merged)).toHaveLength(0);
      expect(
        associationsBetween(mem.id, mem.id)
      ).toHaveLength(0);
      expect(dedupMetadata(mem.id)).toBeNull();
    });

    test('link never merges: no proposal/canonical/merge history in link mode', async () => {
      setMode('link');
      const existing = await seedExisting('link purity probe memory about indexing', PROJECT_A);
      const searcher = makeRecordingSearcher([{ id: existing, similarity: 0.99 }]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'link purity probe memory about indexing strategy',
        type: 'fact',
        project: PROJECT_A,
      });

      expect(nearDupAssociations(mem.id, existing).length).toBe(2);
      expect(getSqlite().prepare('SELECT * FROM memory_merge_proposals').all()).toHaveLength(0);
      expect(getSqlite().prepare('SELECT * FROM memory_merge_history').all()).toHaveLength(0);
      expect(Number(getRow(existing).is_merged)).toBe(0);
      expect(Number(getRow(mem.id).is_merged)).toBe(0);
    });

    test('production searcher: exact duplicate in the same project links end-to-end (real hybrid search)', async () => {
      setMode('link');
      process.env.SQUISH_WRITE_DEDUP_THRESHOLD = '0.6'; // permissive for TF-IDF fusion scores
      // No injected searcher -> default = findSimilarMemories over the real stack.
      const content = 'the vault wiki CLI indexes all pages under Sources every run';
      const existing = await seedExisting(content, PROJECT_A);
      writeDedup.resetWriteDedupStats(); // ignore the scan run by the seeding write

      const mem = await rememberMemory({ content, type: 'fact', project: PROJECT_A });

      expect(writeDedup.getWriteDedupStats().scans).toBe(1);
      const links = nearDupAssociations(mem.id, existing);
      expect(links.length).toBe(2);
      expect(getRow(existing)).toBeDefined();
      expect(Number(getRow(mem.id).is_merged)).toBe(0);
      const dedup = dedupMetadata(mem.id);
      expect((dedup!.similarIds as string[])).toContain(existing);
    });

    test('production searcher: distinct content does not link, cross-project duplicate does not link', async () => {
      setMode('link');
      process.env.SQUISH_WRITE_DEDUP_THRESHOLD = '0.6';
      const dupB = await seedExisting('shared wording that only lives in project beta', PROJECT_B);
      await seedExisting('shared wording that only lives in project beta', PROJECT_B);

      const mem = await rememberMemory({
        content: 'quantum flux capacitor calibration notes',
        type: 'fact',
        project: PROJECT_A,
      });

      // Distinct content: nothing above the bar at all.
      expect(dedupMetadata(mem.id)).toBeNull();
      expect(
        associationsForMemory(mem.id).filter((edge) => edge.association_type === 'near_duplicate')
      ).toHaveLength(0);
      // The project-B duplicate is also not linked (project-scoped search):
      expect(nearDupAssociations(mem.id, dupB)).toHaveLength(0);
    });

    test('global memories (no project) may link to each other but not to project rows', { timeout: 15000 }, async () => {
      setMode('link');
      const globalOther = await seedExisting('global scope pair member one shared phrase');
      const projectOne = await seedExisting('global scope pair member one shared phrase', PROJECT_A);

      const searcher = makeRecordingSearcher([
        { id: globalOther, similarity: 0.95 },
        { id: projectOne, similarity: 0.96 },
      ]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'global scope pair member one shared phrase again',
        type: 'fact',
      });

      expect(nearDupAssociations(mem.id, globalOther).length).toBe(2);
      // Same content but PROJECT-scoped: different scope, must not link.
      expect(nearDupAssociations(mem.id, projectOne)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // merge (explicit opt-in, reuses the reversible approve-merge machinery)
  // -------------------------------------------------------------------------

  describe('mode merge', () => {
    test('near-duplicate triggers the approve-merge path: one canonical + provenance + reversible', async () => {
      setMode('merge');
      const existing = await seedExisting('quarterly planning uses the zero-based budget method', PROJECT_A);
      const searcher = makeRecordingSearcher([{ id: existing, similarity: 0.97 }]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'quarterly planning uses the zero-based budget method every quarter',
        type: 'fact',
        project: PROJECT_A,
      });

      const dedup = dedupMetadata(mem.id);
      expect(dedup).not.toBeNull();
      expect(dedup!.mode).toBe('merge');
      expect((dedup!.similarIds as string[])).toEqual([existing]);
      const canonicalId = dedup!.canonicalMemoryId as string;
      const historyId = dedup!.mergeHistoryId as string;
      const proposalId = dedup!.proposalId as string;
      expect(canonicalId).toBeTruthy();
      expect(historyId).toBeTruthy();
      expect(proposalId).toBeTruthy();

      // The SAME machinery approve-merge uses leaves its fingerprints:
      // a proposal that transitioned pending -> approved with the write-dedup
      // review marker, a canonical row sourced from 'merge', and a history
      // snapshot for reversal.
      const proposal = getSqlite()
        .prepare('SELECT * FROM memory_merge_proposals WHERE id = ?')
        .get(proposalId);
      expect(proposal.status).toBe('approved');
      expect(proposal.review_notes).toContain('squish-write-dedup');
      const sourceIds = JSON.parse(proposal.source_memory_ids).sort();
      expect(sourceIds).toEqual([mem.id, existing].sort());

      const canonical = getRow(canonicalId);
      expect(canonical).toBeDefined();
      expect(Number(canonical.is_canonical)).toBe(1);
      expect(canonical.source).toBe('merge');
      expect(JSON.parse(canonical.merge_source_ids).sort()).toEqual([mem.id, existing].sort());

      const history = getSqlite()
        .prepare('SELECT * FROM memory_merge_history WHERE id = ?')
        .get(historyId);
      expect(history).toBeDefined();
      expect(Number(history.is_reversed)).toBe(0);
      expect(JSON.parse(history.source_memory_ids).sort()).toEqual([mem.id, existing].sort());

      // Both original rows are soft-archived into the canonical.
      for (const id of [mem.id, existing]) {
        const row = getRow(id);
        expect(Number(row.is_merged)).toBe(1);
        expect(row.merged_into_id).toBe(canonicalId);
      }

      // REVERSIBLE via the existing reverse-merge handler: sources restored,
      // canonical deactivated.
      const reversed = await handleReverseMerge({ mergeHistoryId: historyId, reason: 'ws2a test' });
      expect(reversed.ok).toBe(true);
      expect((reversed.data!.restoredMemoryIds as string[]).sort()).toEqual([mem.id, existing].sort());
      for (const id of [mem.id, existing]) {
        const row = getRow(id);
        expect(Number(row.is_merged)).toBe(0);
        expect(Number(row.is_active)).toBe(1);
      }
      expect(Number(getRow(canonicalId).is_active)).toBe(0);
    });

    test('safety-blocked pair falls back to linking (nothing merged)', async () => {
      setMode('merge');
      // Different type -> type_consistency blocker in runSafetyChecks.
      const pref = await rememberMemory({
        content: 'the team prefers trunk-based branching',
        type: 'preference',
        project: PROJECT_A,
      });

      const searcher = makeRecordingSearcher([{ id: pref.id, similarity: 0.96 }]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'the team prefers trunk-based branching strategy',
        type: 'fact',
        project: PROJECT_A,
      });

      // Fallback to link: association exists, nothing was merged.
      expect(nearDupAssociations(mem.id, pref.id).length).toBe(2);
      expect(getSqlite().prepare('SELECT * FROM memory_merge_proposals').all()).toHaveLength(0);
      expect(Number(getRow(mem.id).is_merged)).toBe(0);
      expect(Number(getRow(pref.id).is_merged)).toBe(0);

      const dedup = dedupMetadata(mem.id);
      expect(dedup!.mode).toBe('link');
      expect(dedup!.fallbackReason).toContain('type_consistency');
    });

    test('global (projectless) memory cannot form a proposal: safe link fallback', async () => {
      setMode('merge');
      const existing = await seedExisting('projectless merge probe shared content');
      const searcher = makeRecordingSearcher([{ id: existing, similarity: 0.98 }]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'projectless merge probe shared content again',
        type: 'fact',
      });

      expect(nearDupAssociations(mem.id, existing).length).toBe(2);
      expect(getSqlite().prepare('SELECT * FROM memory_merge_proposals').all()).toHaveLength(0);
      const dedup = dedupMetadata(mem.id);
      expect(dedup!.mode).toBe('link');
      expect(typeof dedup!.fallbackReason).toBe('string');
    });

    test('merge mode with no candidates behaves like link with no metadata', async () => {
      setMode('merge');
      await seedExisting('merge mode with no candidates baseline row', PROJECT_A);
      const searcher = makeRecordingSearcher([]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'merge mode with no candidates fresh unrelated write',
        type: 'fact',
        project: PROJECT_A,
      });

      expect(getSqlite().prepare('SELECT * FROM memory_merge_proposals').all()).toHaveLength(0);
      expect(dedupMetadata(mem.id)).toBeNull();
      expect(Number(getRow(mem.id).is_merged ?? 0)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // stats / observability
  // -------------------------------------------------------------------------

  describe('stats', () => {
    test('scans count one per enabled write, zero when off; lastScanTopK recorded', async () => {
      setMode('link');
      const searcher = makeRecordingSearcher([]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      await rememberMemory({ content: 'stats probe first write', type: 'fact', project: PROJECT_A });
      await rememberMemory({ content: 'stats probe second write', type: 'fact', project: PROJECT_A });
      expect(writeDedup.getWriteDedupStats().scans).toBe(2);
      expect(writeDedup.getWriteDedupStats().lastScanTopK).toBe(5);

      setMode('off');
      await rememberMemory({ content: 'stats probe third write off mode', type: 'fact', project: PROJECT_A });
      expect(writeDedup.getWriteDedupStats().scans).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // WS2a carryover: stage failures must never touch the primary write
  // -------------------------------------------------------------------------

  describe('searcher failure isolation (WS2a coverage gap)', () => {
    test('a throwing similarity searcher cannot fail the primary write or corrupt the row', async () => {
      setMode('link');
      writeDedup.setWriteDedupSearcherForTesting(async () => {
        throw new Error('similarity leg exploded');
      });

      const mem = await rememberMemory({
        content: 'the deploy pipeline runs on the 4m-server alias',
        type: 'fact',
        project: PROJECT_A,
      });

      // The write itself succeeded and the row is intact and active:
      expect(mem.id).toBeTruthy();
      const row = getRow(mem.id);
      expect(row).toBeDefined();
      expect(row.content).toBe('the deploy pipeline runs on the 4m-server alias');
      expect(row.status).toBe('active');
      // Nothing was mutated around it: no associations, no dedup metadata.
      expect(associationsForMemory(mem.id)).toHaveLength(0);
      expect(dedupMetadata(mem.id)).toBeNull();
      // The scan was ATTEMPTED (observability truth) - the failure was swallowed.
      expect(writeDedup.getWriteDedupStats().scans).toBe(1);

      // A later write still works after the stage failure (no poisoned state):
      const second = await rememberMemory({
        content: 'the deploy pipeline runs on the 4m-server alias nightly',
        type: 'fact',
        project: PROJECT_A,
      });
      expect(getRow(second.id)).toBeDefined();
    });

    test('a searcher that rejects with a non-Error value is also isolated', async () => {
      setMode('link');
      writeDedup.setWriteDedupSearcherForTesting(() => Promise.reject('plain string failure'));

      const mem = await rememberMemory({
        content: 'nightly vacuum holds stats fresh on the analytics db',
        type: 'fact',
        project: PROJECT_A,
      });
      expect(getRow(mem.id)).toBeDefined();
      expect(dedupMetadata(mem.id)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // WS2a carryover: empty/invalid env threshold must NOT collapse to 0
  // -------------------------------------------------------------------------

  describe('threshold guard (SQUISH_WRITE_DEDUP_THRESHOLD empty/invalid)', () => {
    test('sanitizeWriteDedupThreshold: empty/NaN/out-of-range fall back to 0.85, valid values pass through', () => {
      // Number('') === 0 and 0 passes the generic finite check in getNumber -
      // that is the bug the guard closes (0 would link EVERYTHING).
      expect(writeDedup.sanitizeWriteDedupThreshold(Number(''))).toBe(0.85);
      expect(writeDedup.sanitizeWriteDedupThreshold(0)).toBe(0.85);
      expect(writeDedup.sanitizeWriteDedupThreshold(-1)).toBe(0.85);
      expect(writeDedup.sanitizeWriteDedupThreshold(2)).toBe(0.85);
      expect(writeDedup.sanitizeWriteDedupThreshold(Number.NaN)).toBe(0.85);
      expect(writeDedup.sanitizeWriteDedupThreshold(Number.POSITIVE_INFINITY)).toBe(0.85);
      // Genuinely valid operator choices pass through untouched:
      expect(writeDedup.sanitizeWriteDedupThreshold(0.85)).toBe(0.85);
      expect(writeDedup.sanitizeWriteDedupThreshold(0.95)).toBe(0.95);
      expect(writeDedup.sanitizeWriteDedupThreshold(0.5)).toBe(0.5);
      expect(writeDedup.sanitizeWriteDedupThreshold(1)).toBe(1);
    });

    test('SQUISH_WRITE_DEDUP_THRESHOLD="" scans with the 0.85 default, not 0', async () => {
      setMode('link');
      process.env.SQUISH_WRITE_DEDUP_THRESHOLD = '';
      const existing = await seedExisting('the deploy pipeline runs on the 4m-server alias', PROJECT_A);
      const searcher = makeRecordingSearcher([{ id: existing, similarity: 0.72 }]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'the deploy pipeline runs on the 4m-server alias weekly',
        type: 'fact',
        project: PROJECT_A,
      });

      // The stage must hand the SEARCHER the guarded bar:
      expect(searcher.calls.length).toBeGreaterThan(0);
      expect(searcher.calls[0].threshold).toBe(0.85);
      // 0.72 is below the default bar: nothing links (with threshold 0 it would).
      expect(nearDupAssociations(mem.id, existing)).toHaveLength(0);
      expect(dedupMetadata(mem.id)).toBeNull();
    });

    test('SQUISH_WRITE_DEDUP_THRESHOLD="0" (explicit link-everything) is treated as invalid and guarded', async () => {
      setMode('link');
      process.env.SQUISH_WRITE_DEDUP_THRESHOLD = '0';
      const existing = await seedExisting('grafana dashboards carry the oncall boards', PROJECT_A);
      const searcher = makeRecordingSearcher([{ id: existing, similarity: 0.11 }]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);

      const mem = await rememberMemory({
        content: 'grafana dashboards carry the oncall boards nightly',
        type: 'fact',
        project: PROJECT_A,
      });

      expect(searcher.calls[0].threshold).toBe(0.85);
      expect(nearDupAssociations(mem.id, existing)).toHaveLength(0);
    });

    test('a valid custom threshold still passes through unchanged', async () => {
      setMode('link');
      process.env.SQUISH_WRITE_DEDUP_THRESHOLD = '0.97';
      const searcher = makeRecordingSearcher([]);
      writeDedup.setWriteDedupSearcherForTesting(searcher.searcher);
      await rememberMemory({ content: 'threshold passthrough probe', type: 'fact', project: PROJECT_A });
      expect(searcher.calls[0].threshold).toBe(0.97);
    });
  });
});
