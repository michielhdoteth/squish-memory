import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-memory-crud-trust-'));
const envKeys = [
  'SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID',
  'SQUISH_PROVENANCE_PRIVATE_KEY', 'SQUISH_PROVENANCE_PUBLIC_KEY', 'SQUISH_PROVENANCE_KEY_ID',
  'SQUISH_EMBEDDINGS_PROVIDER', 'SQUISH_LOCAL_BUNDLED_MODEL', 'SQUISH_SKIP_CONTRADICTION',
  'SQUISH_GRAPH_AUTO_BUILD', 'SQUISH_LLM_ENABLED', 'SQUISH_GEOMETRY_AUTO_CONSOLIDATE', 'SQUISH_WRITE_DEDUP',
] as const;
const savedEnv = new Map<string, string | undefined>();

describe('strict trust for low-level memory CRUD', () => {
  let getDb: typeof import('../../db/index.js').getDb;
  let closeAllDbs: typeof import('../../db/index.js').closeAllDbs;
  let rememberMemory: typeof import('../../core/memory/memory-write.js').rememberMemory;
  let setConfidence: typeof import('../../core/memory/memory-crud.js').setConfidence;
  let getMemory: typeof import('../../core/memory/memory-crud.js').getMemory;
  let getMemoriesByIds: typeof import('../../core/memory/memory-crud.js').getMemoriesByIds;
  let ensureMemoryScores: typeof import('../../core/memory/memory-crud.js').ensureMemoryScores;
  let getRecent: typeof import('../../core/memory/memory-crud.js').getRecent;
  let loadMemory: typeof import('../../core/memory/loader.js').loadMemory;
  let loadMemories: typeof import('../../core/memory/loader.js').loadMemories;
  let loadMemoryRaw: typeof import('../../core/memory/loader.js').loadMemoryRaw;
  let getMemoryStats: typeof import('../../core/memory/stats.js').getMemoryStats;
  let getTierStats: typeof import('../../core/memory/tiers.js').getTierStats;
  let recalculateTiers: typeof import('../../core/memory/tiers.js').recalculateTiers;
  let getLowImportanceMemories: typeof import('../../core/memory/importance.js').getLowImportanceMemories;
  let recalculateImportanceScores: typeof import('../../core/memory/importance-recalc.js').recalculateImportanceScores;
  let getTemporalFactsStats: typeof import('../../core/memory/temporal-facts.js').getTemporalFactsStats;
  let checkTemporalValidity: typeof import('../../core/memory/temporal-facts.js').checkTemporalValidity;
  let supersedeOldTemporalFacts: typeof import('../../core/memory/temporal-facts.js').supersedeOldTemporalFacts;
  let linkTemporalRelations: typeof import('../../core/memory/temporal-parser.js').linkTemporalRelations;
  let consolidateMemories: typeof import('../../core/memory/consolidation.js').consolidateMemories;
  let reverseConsolidation: typeof import('../../core/memory/consolidation.js').reverseConsolidation;
  let getConsolidationStats: typeof import('../../core/memory/consolidation.js').getConsolidationStats;
  let explainMemory: typeof import('../../core/memory/explain.js').explainMemory;
  let buildInspectState: typeof import('../../core/runtime/trust-state.js').buildInspectState;
  let buildStalenessReport: typeof import('../../core/memory/staleness-report.js').buildStalenessReport;

  beforeAll(async () => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'memory-crud-test-caller';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
    process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
    process.env.SQUISH_SKIP_CONTRADICTION = 'true';
    process.env.SQUISH_GRAPH_AUTO_BUILD = 'false';
    process.env.SQUISH_LLM_ENABLED = 'false';
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_KEY_ID = 'memory-crud-test';

    ({ getDb, closeAllDbs } = await import('../../db/index.js'));
    ({ rememberMemory } = await import('../../core/memory/memory-write.js'));
    ({ setConfidence, getMemory, getMemoriesByIds, ensureMemoryScores, getRecent } = await import('../../core/memory/memory-crud.js'));
    ({ loadMemory, loadMemories, loadMemoryRaw } = await import('../../core/memory/loader.js'));
    ({ getMemoryStats } = await import('../../core/memory/stats.js'));
    ({ getTierStats } = await import('../../core/memory/tiers.js'));
    ({ recalculateTiers } = await import('../../core/memory/tiers.js'));
    ({ getLowImportanceMemories } = await import('../../core/memory/importance.js'));
    ({ recalculateImportanceScores } = await import('../../core/memory/importance-recalc.js'));
    ({ getTemporalFactsStats } = await import('../../core/memory/temporal-facts.js'));
    ({ checkTemporalValidity, supersedeOldTemporalFacts } = await import('../../core/memory/temporal-facts.js'));
    ({ linkTemporalRelations } = await import('../../core/memory/temporal-parser.js'));
    ({ consolidateMemories, reverseConsolidation, getConsolidationStats } = await import('../../core/memory/consolidation.js'));
    ({ explainMemory } = await import('../../core/memory/explain.js'));
    ({ buildInspectState } = await import('../../core/runtime/trust-state.js'));
    ({ buildStalenessReport } = await import('../../core/memory/staleness-report.js'));
    await getDb();
  });

  afterAll(async () => {
    await closeAllDbs();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may retain a closed SQLite handle briefly. */ }
  });

  test('withholds unscoped readers, aggregates, and mutations with hashed denial audits', async () => {
    const memory = await rememberMemory({ content: 'Confidence update authorization fixture', type: 'fact', project: dataDir });

    const recent = await getRecent(dataDir, 10, { sql: '1 = 1 OR 1 = 1', params: [] });
    expect(recent.map((candidate) => candidate.id)).toContain(memory.id);

    await expect(setConfidence(memory.id, 'outdated'))
      .rejects.toThrow('caller-scoped provenance authorization');
    await expect(getMemory(memory.id)).rejects.toThrow('caller-scoped provenance authorization');
    await expect(getMemoriesByIds([memory.id])).rejects.toThrow('caller-scoped provenance authorization');
    await expect(ensureMemoryScores({
      id: memory.id,
      type: 'fact',
      created_at: Math.floor(Date.now() / 1000),
      importance_score: null,
      relevance_score: null,
    })).rejects.toThrow('caller-scoped provenance authorization');
    await expect(loadMemory(memory.id)).rejects.toThrow('caller-scoped provenance authorization');
    await expect(loadMemories([memory.id])).rejects.toThrow('caller-scoped provenance authorization');
    await expect(loadMemoryRaw(memory.id)).rejects.toThrow('caller-scoped provenance authorization');
    await expect(getMemoryStats(dataDir)).rejects.toThrow('Unscoped memory statistics are disabled');
    await expect(getTierStats()).rejects.toThrow('Unscoped tier statistics are disabled');
    await expect(getLowImportanceMemories(memory.projectId ?? undefined)).rejects.toThrow('Unscoped maintenance candidate reads are disabled');
    await expect(recalculateImportanceScores(memory.projectId ?? undefined)).rejects.toThrow('Unscoped importance recalculation is disabled');
    await expect(recalculateTiers(memory.projectId ?? undefined)).rejects.toThrow('Unscoped tier recalculation is disabled');
    await expect(getTemporalFactsStats(memory.projectId ?? undefined)).rejects.toThrow('Unscoped temporal statistics are disabled');
    await expect(checkTemporalValidity(memory.id)).rejects.toThrow('Unscoped temporal validity reads are disabled');
    await expect(supersedeOldTemporalFacts(memory.id, 'Updated policy begins on 2099-01-01', memory.projectId ?? undefined))
      .rejects.toThrow('Unscoped temporal supersession is disabled');
    await expect(linkTemporalRelations(memory.id, [{
      type: 'absolute', value: '2099-01-01', parsed: { start: new Date('2099-01-01T00:00:00Z') },
      confidence: 1, context: 'policy begins 2099-01-01',
    }])).rejects.toThrow('Unscoped temporal relation linking is disabled');
    await expect(consolidateMemories({ projectId: memory.projectId ?? undefined })).rejects.toThrow('Memory consolidation is disabled');
    const sqlite = (await getDb() as any).$client;
    sqlite.prepare('UPDATE memories SET is_consolidated = 1, metadata = ? WHERE id = ?')
      .run(JSON.stringify({ consolidatedFrom: [memory.id] }), memory.id);
    await expect(reverseConsolidation(memory.id)).rejects.toThrow('Reversing memory consolidation is disabled');
    await expect(getConsolidationStats(memory.projectId!)).rejects.toThrow('Unscoped consolidation statistics are disabled');
    await expect(explainMemory(memory.id)).rejects.toThrow('Unscoped memory inspection is disabled');
    await expect(buildInspectState(memory.id)).rejects.toThrow('Unscoped memory inspection is disabled');
    await expect(buildStalenessReport({ projectId: memory.projectId ?? undefined })).rejects.toThrow('Unscoped staleness reports are disabled');

    expect(sqlite.prepare('SELECT confidence_level FROM memories WHERE id = ?').get(memory.id).confidence_level)
      .toBe('speculative');
    expect(sqlite.prepare('SELECT is_consolidated, tier FROM memories WHERE id = ?').get(memory.id))
      .toEqual({ is_consolidated: 1, tier: 'working' });
    const audits = sqlite.prepare(`SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log
      WHERE asset_type = 'memory' AND reason = 'strict_surface'`).all();
    const callerHash = createHash('sha256').update('memory-crud-test-caller').digest('hex');
    const resourceHashes = new Set([
      createHash('sha256').update(memory.id).digest('hex'),
      createHash('sha256').update('memory_batch_read').digest('hex'),
      createHash('sha256').update('memory_batch_load').digest('hex'),
      createHash('sha256').update('memory_statistics').digest('hex'),
      createHash('sha256').update('tier_statistics').digest('hex'),
      createHash('sha256').update('maintenance_candidates').digest('hex'),
      createHash('sha256').update('importance_recalculation').digest('hex'),
      createHash('sha256').update('tier_recalculation').digest('hex'),
      createHash('sha256').update('temporal_statistics').digest('hex'),
      createHash('sha256').update('consolidation_run').digest('hex'),
      createHash('sha256').update('consolidation_reverse').digest('hex'),
      createHash('sha256').update('consolidation_statistics').digest('hex'),
      createHash('sha256').update('staleness_report').digest('hex'),
    ]);
    expect(audits).toHaveLength(22);
    expect(audits.every((audit: { actor_hash: string; resource_hash: string; decision: string; reason: string }) =>
      audit.actor_hash === callerHash && resourceHashes.has(audit.resource_hash)
      && audit.decision === 'deny' && audit.reason === 'strict_surface')).toBe(true);
  });
});
