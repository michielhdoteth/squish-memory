/**
 * Tests for the merged contradiction engine in core/memory/contradiction-resolver.ts
 *
 * Covers:
 * - Scenario 7 keyword-opposite detection (absorbed from retired contradiction-v2)
 * - LLM-as-validator wiring (mocked callLLM): veto, confirm, graceful degradation
 * - Proposition-aware end-to-end pipeline shape through resolveContradictions
 *
 * callLLM is mocked with mock.module; config is controlled via env vars
 * (SQUISH_LLM_ENABLED) since config.ts reads env lazily through getters.
 * DB is isolated in a temp dir (SQUISH_DATA_DIR + DATABASE_URL='').
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';

// ─── Mock the only allowed LLM entrypoint ─────────────────────────────────────
const llmMockState = {
  response: null as string | null,
  calls: [] as string[],
};

mock.module('../../../core/llm/client.js', () => ({
  callLLM: async (prompt: string): Promise<string | null> => {
    llmMockState.calls.push(prompt);
    return llmMockState.response;
  },
  callLLMWithContent: async (): Promise<string | null> => llmMockState.response,
  registerProvider: (): void => {},
  getActiveProviderName: (): string | null => null,
}));

// ─── Env / DB isolation ───────────────────────────────────────────────────────
let testDataDir: string;
let savedEnv: Record<string, string | undefined>;

let detectContradictions: typeof import('../../../core/memory/contradiction-resolver.js').detectContradictions;
let resolveContradictions: typeof import('../../../core/memory/contradiction-resolver.js').resolveContradictions;
let applySupersession: typeof import('../../../core/memory/contradiction-resolver.js').applySupersession;
let checkTemporalContradictions: typeof import('../../../core/memory/contradiction-resolver.js').checkTemporalContradictions;
let wouldCreateSupersessionCycle: typeof import('../../../core/memory/contradiction-resolver.js').wouldCreateSupersessionCycle;
let hasOppositeKeywords: typeof import('../../../core/memory/contradiction-resolver.js').hasOppositeKeywords;
let resetDb: typeof import('../../../db/index.js').resetDb;
let getDb: typeof import('../../../db/index.js').getDb;
let createAssociation: typeof import('../../../core/associations.js').createAssociation;

async function seedActiveMemory(id: string, content: string): Promise<void> {
  const db = await getDb();
  const sqlite = (db as any).$client;
  sqlite.exec(
    `INSERT INTO memories (id, content, type, status, created_at) VALUES ('${id}', '${content.replace(/'/g, "''")}', 'fact', 'active', '${new Date().toISOString()}')`
  );
  sqlite.prepare(`
    INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
    VALUES (?, 'memory', 'fact', ?, ?, 'active', 1)
  `).run(`knowledge-${id}`, content, JSON.stringify({ sourceMemoryId: id }));
}

describe('contradiction resolver (merged v1 + keyword opposites + LLM validator)', () => {
  beforeAll(async () => {
    savedEnv = {
      SQUISH_DATA_DIR: process.env.SQUISH_DATA_DIR,
      DATABASE_URL: process.env.DATABASE_URL,
      SQUISH_LLM_ENABLED: process.env.SQUISH_LLM_ENABLED,
      SQUISH_LOCAL_BUNDLED_MODEL: process.env.SQUISH_LOCAL_BUNDLED_MODEL,
      SQUISH_TRUST_POLICY: process.env.SQUISH_TRUST_POLICY,
      SQUISH_TRUSTED_CALLER_ID: process.env.SQUISH_TRUSTED_CALLER_ID,
    };

    testDataDir = join(tmpdir(), `squish-contradiction-resolver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
    delete process.env.SQUISH_LLM_ENABLED;
    delete process.env.SQUISH_TRUST_POLICY;
    delete process.env.SQUISH_TRUSTED_CALLER_ID;
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const resolverMod = await import('../../../core/memory/contradiction-resolver.js');
    const dbMod = await import('../../../db/index.js');
    detectContradictions = resolverMod.detectContradictions;
    resolveContradictions = resolverMod.resolveContradictions;
    applySupersession = resolverMod.applySupersession;
    checkTemporalContradictions = resolverMod.checkTemporalContradictions;
    wouldCreateSupersessionCycle = resolverMod.wouldCreateSupersessionCycle;
    hasOppositeKeywords = resolverMod.hasOppositeKeywords;
    resetDb = dbMod.resetDb;
    getDb = dbMod.getDb;
    ({ createAssociation } = await import('../../../core/associations.js'));
    resetDb();
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    delete process.env.SQUISH_TRUST_POLICY;
    delete process.env.SQUISH_TRUSTED_CALLER_ID;
    llmMockState.calls = [];
    llmMockState.response = null;
    resetDb();
    const db = await getDb();
    const sqlite = (db as any).$client;
    if (sqlite && typeof sqlite.exec === 'function') {
      sqlite.exec('DELETE FROM memories;');
      sqlite.exec('DELETE FROM trust_audit_log;');
    }
  });

  // ─── Pure helper: hasOppositeKeywords (Scenario 7) ──────────────────────────

  describe('hasOppositeKeywords', () => {
    test('detects yes/no', () => {
      expect(hasOppositeKeywords('The answer is yes', 'The answer is no')).toBe(true);
    });

    test('detects true/false', () => {
      expect(hasOppositeKeywords('The statement is true', 'The statement is false')).toBe(true);
    });

    test('detects always/never', () => {
      expect(hasOppositeKeywords('We always use this approach', 'We never use this approach')).toBe(true);
    });

    test('detects increase/decrease', () => {
      expect(hasOppositeKeywords('Increase the budget', 'Decrease the budget')).toBe(true);
    });

    test('detects up/down', () => {
      expect(hasOppositeKeywords('Prices are going up', 'Prices are going down')).toBe(true);
    });

    test('detects good/bad', () => {
      expect(hasOppositeKeywords('This is a good solution', 'This is a bad solution')).toBe(true);
    });

    test('detects success/failure', () => {
      expect(hasOppositeKeywords('The deployment was a success', 'The deployment was a failure')).toBe(true);
    });

    test('detects working/broken', () => {
      expect(hasOppositeKeywords('The system is working', 'The system is broken')).toBe(true);
    });

    test('is order-independent (pair split across arguments both ways)', () => {
      expect(hasOppositeKeywords('The answer is no', 'The answer is yes')).toBe(true);
      expect(hasOppositeKeywords('The system is broken', 'The system is working')).toBe(true);
    });

    test('is case-insensitive', () => {
      expect(hasOppositeKeywords('YES', 'no')).toBe(true);
    });

    test('whole-word matching avoids substring false positives', () => {
      // 'notice' contains 'no' as substring but not as a whole word
      expect(hasOppositeKeywords('I notice the change', 'The answer is no')).toBe(false);
    });

    test('returns false when no opposite pair present', () => {
      expect(hasOppositeKeywords('The sky is blue', 'The ocean is blue')).toBe(false);
    });
  });

  // ─── LLM-as-validator wiring through detectContradictions ───────────────────

  describe('LLM validator wiring', () => {
    // Heuristic trigger pair: shared words push subjectSimilarity to 4/7 (~0.57 > 0.5),
    // update indicator 'now' fires Scenario 2.
    const EXISTING = 'Sarah lives and works in Austin.';
    const UPDATED = 'Sarah now lives and works in Houston.';

    test('drops heuristic proposal when LLM confidently rejects it', async () => {
      process.env.SQUISH_LLM_ENABLED = 'true';
      await seedActiveMemory('mem-austin-1', EXISTING);
      llmMockState.response = '{"contradicts":false,"confidence":0.9}';

      const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

      expect(llmMockState.calls.length).toBe(1);
      // Prompt must be proposition-aware: includes both contents
      expect(llmMockState.calls[0]).toContain(EXISTING);
      expect(llmMockState.calls[0]).toContain(UPDATED);
      expect(llmMockState.calls[0]).toContain('SAME subject AND the SAME attribute');
      // Vetoed: no supersession committed
      expect(result.hasContradiction).toBe(false);
      expect(result.supersededMemories).toEqual([]);
    });

    test('keeps proposal when LLM confirms contradiction', async () => {
      process.env.SQUISH_LLM_ENABLED = 'true';
      await seedActiveMemory('mem-austin-2', EXISTING);
      llmMockState.response = '{"contradicts":true,"confidence":0.95}';

      const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

      expect(llmMockState.calls.length).toBe(1);
      expect(result.hasContradiction).toBe(true);
      expect(result.supersededMemories).toEqual(['mem-austin-2']);
      // Scenario 2 confidence: subjectSimilarity(4/7) * 0.85 * temporalFactor(unknown=1.0)
      expect(result.confidence).toBeCloseTo(0.486, 2);
      expect(result.reason).toContain('update to existing information');
      expect(result.associationType).toBe('updates');
    });

    test('keeps proposal on garbage LLM response (graceful degradation)', async () => {
      process.env.SQUISH_LLM_ENABLED = 'true';
      await seedActiveMemory('mem-austin-3', EXISTING);
      llmMockState.response = 'not json at all';

      const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

      expect(llmMockState.calls.length).toBe(1);
      expect(result.hasContradiction).toBe(true);
      expect(result.supersededMemories).toEqual(['mem-austin-3']);
    });

    test('keeps proposal on null LLM response (unavailable fallback)', async () => {
      process.env.SQUISH_LLM_ENABLED = 'true';
      await seedActiveMemory('mem-austin-4', EXISTING);
      llmMockState.response = null;

      const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

      expect(llmMockState.calls.length).toBe(1);
      expect(result.hasContradiction).toBe(true);
      expect(result.supersededMemories).toEqual(['mem-austin-4']);
    });

    test('parses markdown-fenced JSON robustly (fenced veto drops proposal)', async () => {
      process.env.SQUISH_LLM_ENABLED = 'true';
      await seedActiveMemory('mem-austin-5', EXISTING);
      llmMockState.response = '```json\n{"contradicts":false,"confidence":0.9}\n```';

      const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

      expect(llmMockState.calls.length).toBe(1);
      // Fence stripping worked, verdict parsed, proposal dropped
      expect(result.hasContradiction).toBe(false);
      expect(result.supersededMemories).toEqual([]);
    });

    test('LLM disabled: no call attempted, heuristic verdict unchanged', async () => {
      delete process.env.SQUISH_LLM_ENABLED;
      await seedActiveMemory('mem-austin-6', EXISTING);
      // If consulted, this response would veto - proves it was never called
      llmMockState.response = '{"contradicts":false,"confidence":0.9}';

      const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

      expect(llmMockState.calls.length).toBe(0);
      expect(result.hasContradiction).toBe(true);
      expect(result.supersededMemories).toEqual(['mem-austin-6']);
    });
  });

  // ─── Scenario 7 end-to-end through detectContradictions ────────────────────

  describe('keyword-opposite scenario through detectContradictions', () => {
    test('opposite keywords supersede with expected confidence and reason', async () => {
      delete process.env.SQUISH_LLM_ENABLED;
      await seedActiveMemory('mem-working-7', 'The deploy pipeline is working fine');

      const result = await detectContradictions({
        newContent: 'The deploy pipeline is broken now',
        newType: 'fact',
      });

      expect(result.hasContradiction).toBe(true);
      expect(result.supersededMemories).toEqual(['mem-working-7']);
      expect(result.confidence).toBeCloseTo(0.7, 2); // 0.7 * temporalFactor(unknown=1.0)
      expect(result.reason).toContain('opposite keywords (working/broken)');
    });

    test('moderate similarity without opposite keywords does not supersede', async () => {
      delete process.env.SQUISH_LLM_ENABLED;
      await seedActiveMemory('mem-blue-sky', 'The sky is blue today');

      const result = await detectContradictions({
        newContent: 'The ocean is blue today',
        newType: 'fact',
      });

      expect(result.hasContradiction).toBe(false);
      expect(result.supersededMemories).toEqual([]);
    });
  });

  // ─── End-to-end proposition case through resolveContradictions ─────────────

  describe('resolveContradictions end-to-end (proposition-aware pipeline shape)', () => {
    test('returns full supersession shape with mocked LLM confirmation', async () => {
      process.env.SQUISH_LLM_ENABLED = 'true';
      await seedActiveMemory('mem-e2e-1', 'Sarah lives and works in Austin.');
      llmMockState.response = '{"contradicts":true,"confidence":0.9}';

      const result = await resolveContradictions(
        'Sarah now lives and works in Houston.',
        'fact'
      );

      expect(result.shouldProceed).toBe(true);
      expect(result.supersededIds).toEqual(['mem-e2e-1']);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.reason).toBeTruthy();
      expect(result.associationType).toBe('updates'); // explicit replacement via update indicator
      expect(llmMockState.calls.length).toBe(1);
    });

    test('vetoed proposition yields empty supersession but still proceeds', async () => {
      process.env.SQUISH_LLM_ENABLED = 'true';
      await seedActiveMemory('mem-e2e-2', 'Sarah lives and works in Austin.');
      llmMockState.response = '{"contradicts":false,"confidence":0.95}';

      const result = await resolveContradictions(
        'Sarah now lives and works in Houston.',
        'fact'
      );

      expect(result.shouldProceed).toBe(true);
      expect(result.supersededIds).toEqual([]);
      expect(result.confidence).toBe(0);
    });
  });

  test('supersession cycle checks respect new-to-old direction and ignore non-supersession relations', () => {
    const chain = [
      { fromMemoryId: 'v3', toMemoryId: 'v2', associationType: 'updates' as const },
      { fromMemoryId: 'v2', toMemoryId: 'v1', associationType: 'supersedes' as const },
      { fromMemoryId: 'v1', toMemoryId: 'v3', associationType: 'supports' as const },
    ];
    expect(wouldCreateSupersessionCycle('v3', 'v1', chain)).toBe(false);
    expect(wouldCreateSupersessionCycle('v1', 'v3', chain)).toBe(true);
    expect(wouldCreateSupersessionCycle('v1', 'v1', chain)).toBe(true);
  });

  test('applySupersession deactivates superseded memories', async () => {
    await seedActiveMemory('old-superseded', 'The old deployment uses PostgreSQL');
    await seedActiveMemory('new-superseding', 'The new deployment uses MySQL');
    const db = await getDb();
    (db as any).$client.prepare(`
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES ('malformed-unrelated-projection', 'memory', 'note', 'legacy row', '{invalid', 'active', 1)
    `).run();

    await applySupersession('new-superseding', ['old-superseded'], 0.9);

    const oldMemory = (db as any).$client
      .prepare('SELECT status, is_active, superseded_by, valid_to, recorded_at FROM memories WHERE id = ?')
      .get('old-superseded');
    expect(oldMemory.status).toBe('superseded');
    expect(oldMemory.is_active).toBe(0);
    expect(oldMemory.superseded_by).toBe('new-superseding');
    expect(oldMemory.valid_to).not.toBeNull();
    const oldProjection = (db as any).$client
      .prepare('SELECT status, is_active, superseded_by, valid_to, recorded_at FROM knowledge WHERE id = ?')
      .get('knowledge-old-superseded');
    expect(oldProjection.status).toBe('superseded');
    expect(oldProjection.is_active).toBe(0);
    expect(oldProjection.superseded_by).toBe('new-superseding');
    expect(oldProjection.valid_to).toBe(oldMemory.valid_to);
    expect(oldProjection.recorded_at).toBe(oldMemory.recorded_at);
  });

  test('applySupersession closes a legacy canonical projection keyed by the source id', async () => {
    const oldId = 'legacy-canonical-old';
    const newId = 'legacy-canonical-new';
    const db = await getDb();
    const sqlite = (db as any).$client;
    sqlite.prepare(`INSERT INTO memories (id, content, type, status, created_at)
      VALUES (?, 'Legacy source deployment region', 'fact', 'active', strftime('%s','now'))`).run(oldId);
    sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES (?, 'memory', 'fact', 'Legacy source deployment region', '{}', 'active', 1)`).run(oldId);
    await seedActiveMemory(newId, 'Replacement source deployment region');

    await applySupersession(newId, [oldId], 0.9);

    expect(sqlite.prepare('SELECT status, is_active, superseded_by FROM knowledge WHERE id = ?').get(oldId))
      .toMatchObject({ status: 'superseded', is_active: 0, superseded_by: newId });
  });

  test('applySupersession retracts source-derived beliefs and their support edges', async () => {
    const oldId = 'supersession-derived-old';
    const newId = 'supersession-derived-new';
    const beliefId = 'supersession-derived-belief';
    const db = await getDb();
    const sqlite = (db as any).$client;
    await seedActiveMemory(oldId, 'Old deployment uses the west region');
    await seedActiveMemory(newId, 'New deployment replaces it with the east region');
    sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES (?, 'belief', 'preference', 'Derived belief from old deployment', ?, 'active', 1)`)
      .run(beliefId, JSON.stringify({ sourceMemoryId: oldId }));
    sqlite.prepare(`INSERT INTO knowledge_edges
      (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at)
      VALUES ('supersession-derived-support', ?, 'knowledge', ?, 'memory', 'sourced_from', ?, ?, ?)`)
      .run(beliefId, oldId, Date.now(), Date.now(), Date.now());

    await applySupersession(newId, [oldId], 0.9);

    expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(beliefId)).toBeNull();
    expect(sqlite.prepare('SELECT recorded_to FROM knowledge_edges WHERE id = ?').get('supersession-derived-support').recorded_to)
      .not.toBeNull();
  });

  test('applySupersession rolls back the source when canonical projection synchronization fails', async () => {
    await seedActiveMemory('rollback-old', 'The prior verified deployment region');
    await seedActiveMemory('rollback-new', 'The replacement verified deployment region');
    const db = await getDb();
    const sqlite = (db as any).$client;
    sqlite.exec(`CREATE TRIGGER reject_supersession_projection BEFORE UPDATE ON knowledge
      WHEN OLD.id = 'knowledge-rollback-old' AND NEW.status = 'superseded'
      BEGIN SELECT RAISE(ABORT, 'injected supersession projection failure'); END`);

    try {
      await applySupersession('rollback-new', ['rollback-old'], 0.9);
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS reject_supersession_projection');
    }

    expect(sqlite.prepare('SELECT status, is_active, superseded_by FROM memories WHERE id = ?').get('rollback-old'))
      .toMatchObject({ status: 'active', is_active: 1, superseded_by: null });
    expect(sqlite.prepare('SELECT status, is_active, superseded_by FROM knowledge WHERE id = ?').get('knowledge-rollback-old'))
      .toMatchObject({ status: 'active', is_active: 1, superseded_by: null });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM knowledge_edges
      WHERE edge_type = 'supersedes' AND from_id = 'knowledge-rollback-new' AND to_id = 'knowledge-rollback-old'`).get().count)
      .toBe(0);
  });

  test('strict trust denies direct contradiction reads and supersession mutation with hashed audits', async () => {
    await seedActiveMemory('strict-old', 'The old system stores files on disk.');
    await seedActiveMemory('strict-new', 'The new system stores files in object storage.');
    const db = await getDb();
    const sqlite = (db as any).$client;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'contradiction-test-owner';
    try {
      await expect(detectContradictions({
        newContent: 'The new system stores files in object storage.',
        newType: 'fact',
        projectId: 'secret-project-id',
      })).rejects.toThrow('disabled under strict trust');
      await expect(checkTemporalContradictions('As of 2025 the system changed.', 'secret-project-id'))
        .rejects.toThrow('disabled under strict trust');
      await expect(applySupersession('strict-new', ['strict-old'], 0.9))
        .rejects.toThrow('disabled under strict trust');

      expect(sqlite.prepare('SELECT status, is_active, superseded_by FROM memories WHERE id=?').get('strict-old'))
        .toMatchObject({ status: 'active', is_active: 1, superseded_by: null });
      expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id=?').get('strict-new'))
        .toMatchObject({ status: 'active', is_active: 1 });
      const audit = sqlite.prepare(`SELECT actor_hash, resource_hash, decision, reason
        FROM trust_audit_log ORDER BY rowid`).all() as Array<Record<string, unknown>>;
      expect(audit).toHaveLength(3);
      expect(audit.every((row) => row.decision === 'deny' && row.reason === 'strict_surface')).toBe(true);
      expect(JSON.stringify(audit)).not.toContain('contradiction-test-owner');
      expect(JSON.stringify(audit)).not.toContain('secret-project-id');
      expect(JSON.stringify(audit)).not.toContain('strict-old');
    } finally {
      if (savedEnv.SQUISH_TRUST_POLICY === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = savedEnv.SQUISH_TRUST_POLICY;
      if (savedEnv.SQUISH_TRUSTED_CALLER_ID === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = savedEnv.SQUISH_TRUSTED_CALLER_ID;
    }
  });

  test('applySupersession records the replacement fact valid start separately from discovery time', async () => {
    await seedActiveMemory('dated-old', 'The service used the prior region');
    await seedActiveMemory('dated-new', 'The service uses the replacement region');
    const db = await getDb();
    const sqlite = (db as any).$client;
    const priorStart = Date.UTC(2019, 0, 1);
    const replacementStart = Date.UTC(2021, 5, 1);
    sqlite.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(priorStart / 1000, 'dated-old');
    sqlite.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(replacementStart / 1000, 'dated-new');
    await createAssociation('dated-new', 'dated-old', 'supersedes', 0.5);

    await applySupersession('dated-new', ['dated-old'], 0.9);

    const edge = sqlite.prepare(`
      SELECT e.valid_from, e.recorded_at
      FROM knowledge_edges e
      JOIN knowledge f ON f.id = e.from_id
      JOIN knowledge t ON t.id = e.to_id
      WHERE e.edge_type = 'supersedes'
        AND json_extract(f.metadata, '$.sourceMemoryId') = ?
        AND json_extract(t.metadata, '$.sourceMemoryId') = ?
        AND e.recorded_to IS NULL
    `).get('dated-new', 'dated-old');
    expect(edge.valid_from).toBe(replacementStart);
    expect(edge.recorded_at).toBeGreaterThan(replacementStart);
  });

  test('applySupersession rejects a replacement that would create an empty valid-time interval', async () => {
    await seedActiveMemory('future-old', 'Old fact valid in the future');
    await seedActiveMemory('past-new', 'Replacement has an earlier valid start');
    const db = await getDb();
    const sqlite = (db as any).$client;
    sqlite.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(Date.UTC(2026, 5, 5) / 1000, 'future-old');
    sqlite.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(Date.UTC(2026, 5, 3) / 1000, 'past-new');

    await applySupersession('past-new', ['future-old'], 0.9);

    const oldMemory = sqlite.prepare('SELECT status, valid_to, superseded_by FROM memories WHERE id = ?').get('future-old');
    expect(oldMemory).toMatchObject({ status: 'active', valid_to: null, superseded_by: null });
  });

  test('applySupersession ignores the replacement memory itself', async () => {
    await seedActiveMemory('same-memory', 'An in-place update to the same memory');

    await applySupersession('same-memory', ['same-memory'], 0.9);

    const db = await getDb();
    const sqlite = (db as any).$client;
    const memory = sqlite
      .prepare('SELECT status, is_active, superseded_by FROM memories WHERE id = ?')
      .get('same-memory');
    const associations = sqlite
      .prepare("SELECT COUNT(*) count FROM knowledge_edges WHERE edge_type IN ('supersedes', 'updates') AND (from_id = ? OR to_id = ?)")
      .get('same-memory', 'same-memory');
    expect(memory.status).toBe('active');
    expect(memory.is_active).toBe(1);
    expect(memory.superseded_by).toBeNull();
    expect(associations.count).toBe(0);
  });

  test('applySupersession rejects a cycle and leaves the older memory active', async () => {
    await seedActiveMemory('cycle-new', 'New version');
    await seedActiveMemory('cycle-old', 'Old version');
    await createAssociation('cycle-old', 'cycle-new', 'supersedes', 1);

    await applySupersession('cycle-new', ['cycle-old'], 0.9);

    const db = await getDb();
    const row = (db as any).$client
      .prepare('SELECT status, is_active, superseded_by FROM memories WHERE id = ?')
      .get('cycle-old');
    expect(row.status).toBe('active');
    expect(row.is_active).toBe(1);
    expect(row.superseded_by).toBeNull();
  });
});
