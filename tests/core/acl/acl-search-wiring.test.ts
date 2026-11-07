/**
 * ACL search wiring test (fix for dead-code acl gate):
 * A real SDK-level client.search() must automatically build the ACL context
 * when visibility rules exist, log would-filter decisions in log-only mode,
 * and actually filter in enforce mode. With no rules defined the gate must
 * stay completely inert.
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';

let testDataDir: string;
let savedEnv: Record<string, string | undefined>;

let SquishClient: typeof import('../../../core/runtime/squish-runtime.js').SquishRuntime;
let setVisibilityRule: typeof import('../../../core/loadout/loadout.js').setVisibilityRule;
let removeVisibilityRule: typeof import('../../../core/loadout/loadout.js').removeVisibilityRule;
let getAclLog: typeof import('../../../core/acl/acl-log.js').getAclLog;
let clearAclLog: typeof import('../../../core/acl/acl-log.js').clearAclLog;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const ID_READ_MEMORY = 'e9b5cbce-23f0-4c8f-82b9-8c3a3cfb0001';
const ID_PRIVATE_MEMORY = 'e9b5cbce-23f0-4c8f-82b9-8c3a3cfb0002';
const ID_TAMPER_MEMORY = 'e9b5cbce-23f0-4c8f-82b9-8c3a3cfb0003';

async function seedMemory(id: string, content: string): Promise<void> {
  const db = await getDb();
  const sqlite = (db as any).$client;
  const createdAt = Math.floor(Date.now() / 1000);
  sqlite.prepare('INSERT INTO memories (id, content, type, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, content, 'fact', 'active', createdAt);
}

describe('SDK search ACL wiring', () => {
  beforeAll(async () => {
    savedEnv = {
      SQUISH_DATA_DIR: process.env.SQUISH_DATA_DIR,
      DATABASE_URL: process.env.DATABASE_URL,
      SQUISH_ACL_ENFORCE: process.env.SQUISH_ACL_ENFORCE,
      SQUISH_TRUST_POLICY: process.env.SQUISH_TRUST_POLICY,
      SQUISH_TRUSTED_CALLER_ID: process.env.SQUISH_TRUSTED_CALLER_ID,
      SQUISH_PROVENANCE_PRIVATE_KEY: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      SQUISH_PROVENANCE_PUBLIC_KEY: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      SQUISH_PROVENANCE_PUBLIC_KEYS: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
      SQUISH_PROVENANCE_KEY_ID: process.env.SQUISH_PROVENANCE_KEY_ID,
      SQUISH_PROFILE: process.env.SQUISH_PROFILE,
      SQUISH_GRAPH_EXPANSION: process.env.SQUISH_GRAPH_EXPANSION,
      SQUISH_GRAPH_BOOST_LEGACY: process.env.SQUISH_GRAPH_BOOST_LEGACY,
      SQUISH_RERANKER_ENABLED: process.env.SQUISH_RERANKER_ENABLED,
      SQUISH_SEARCH_BELIEFS: process.env.SQUISH_SEARCH_BELIEFS,
      SQUISH_EMBEDDINGS_PROVIDER: process.env.SQUISH_EMBEDDINGS_PROVIDER,
    };

    testDataDir = join(tmpdir(), `squish-acl-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDataDir, { recursive: true });
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';

    const sdkMod = await import('../../../core/runtime/squish-runtime.js');
    const loadoutMod = await import('../../../core/loadout/loadout.js');
    const logMod = await import('../../../core/acl/acl-log.js');
    const dbMod = await import('../../../db/index.js');
    SquishClient = sdkMod.SquishRuntime;
    setVisibilityRule = loadoutMod.setVisibilityRule;
    removeVisibilityRule = loadoutMod.removeVisibilityRule;
    getAclLog = logMod.getAclLog;
    clearAclLog = logMod.clearAclLog;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;

    await resetDb();

    // mem-private: rule grants only STRANGER -> hidden from OWNER in enforce mode
    // mem-open: rule grants everyone -> always served
    await seedMemory('mem-wired-private', 'confidential roadmap details');
    await seedMemory('mem-wired-open', 'public changelog notes');
    await seedMemory(ID_READ_MEMORY, 'ID read access fixture');
    await seedMemory(ID_PRIVATE_MEMORY, 'ID private access fixture');
    await seedMemory(ID_TAMPER_MEMORY, 'Tamper evidence fixture');

    await setVisibilityRule({
      assetType: 'memory',
      assetId: 'mem-wired-private',
      ruleType: 'allow',
      granteeType: 'user',
      granteeId: STRANGER,
      permission: 'read',
    });
    await setVisibilityRule({
      assetType: 'memory',
      assetId: 'mem-wired-open',
      ruleType: 'allow',
      granteeType: 'everyone',
      granteeId: '*',
      permission: 'read',
    });
    await setVisibilityRule({
      assetType: 'memory',
      assetId: ID_READ_MEMORY,
      ruleType: 'allow',
      granteeType: 'everyone',
      granteeId: '*',
      permission: 'read',
    });
    await setVisibilityRule({
      assetType: 'memory',
      assetId: ID_PRIVATE_MEMORY,
      ruleType: 'allow',
      granteeType: 'user',
      granteeId: STRANGER,
      permission: 'read',
    });
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { await removeVisibilityRule('memory', 'mem-wired-private', 'user', STRANGER); } catch {}
    try { await removeVisibilityRule('memory', 'mem-wired-open', 'everyone', '*'); } catch {}
    try { await removeVisibilityRule('memory', ID_READ_MEMORY, 'everyone', '*'); } catch {}
    try { await removeVisibilityRule('memory', ID_PRIVATE_MEMORY, 'user', STRANGER); } catch {}
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  });

  test('log-only mode: SDK search serves everything but logs would-filter', async () => {
    delete process.env.SQUISH_ACL_ENFORCE;
    clearAclLog();

    // No explicit user -> auto context falls back to 'local-agent', who is not
    // granted on mem-wired-private. Log-only mode must still serve it.
    const client = new SquishClient({ dataDir: testDataDir });
    const results = await client.search('roadmap');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const logged = getAclLog('acl_would_filter');
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(logged.some((e) => e.memoryId === 'mem-wired-private')).toBe(true);
  });

  test('enforce mode: SDK search filters disallowed results', async () => {
    process.env.SQUISH_ACL_ENFORCE = 'true';

    const client = new SquishClient({ dataDir: testDataDir });
    const results = await client.search('notes', { limit: 50 });
    const ids = results.map((r: any) => r.memory?.id);
    expect(ids).not.toContain('mem-wired-private');
    expect(ids).toContain('mem-wired-open');

    delete process.env.SQUISH_ACL_ENFORCE;
  });

  test('strict trust binds SDK reads to its configured caller and durably audits ACL decisions', async () => {
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-test-caller';
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.SQUISH_PROVENANCE_KEY_ID = 'test-key-v1';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const { signMemoryProvenance, verifyMemoryProvenance } = await import('../../../core/acl/provenance.js');
    const db = await getDb();
    const sqlite = (db as any).$client;
    const { applyTagOverlapBoost, getMemoriesByIndexedTags } = await import('../../../core/memory/search-scoring.js');
    const { getRetrievalConfig } = await import('../../../core/retrieval/config.js');
    const tagCandidates = [{ id: ID_READ_MEMORY, similarity: 0.5 }] as any[];
    const tagIndexAuditBefore = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'memory_tag_index'").get().count);
    expect(await applyTagOverlapBoost(tagCandidates, ['private-marker'], getRetrievalConfig().scoring)).toBe(tagCandidates);
    expect(Number(sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'memory_tag_index'").get().count)).toBe(tagIndexAuditBefore);
    await expect(getMemoriesByIndexedTags(['private-marker'], 10)).rejects.toThrow('Unscoped memory tag-index reads are disabled under strict trust');
    const tagIndexAudit = sqlite.prepare("SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log WHERE asset_type = 'memory_tag_index' ORDER BY rowid DESC LIMIT 1").get() as {
      actor_hash: string; resource_hash: string; decision: string; reason: string;
    };
    expect(tagIndexAudit).toMatchObject({
      actor_hash: createHash('sha256').update('strict-test-caller').digest('hex'),
      resource_hash: createHash('sha256').update('memory_tags').digest('hex'),
      decision: 'deny',
      reason: 'strict_surface',
    });
    for (const [id, content] of [
      ['mem-wired-private', 'confidential roadmap details'],
      ['mem-wired-open', 'public changelog notes'],
      [ID_READ_MEMORY, 'ID read access fixture'],
      [ID_PRIVATE_MEMORY, 'ID private access fixture'],
    ]) {
      const row = sqlite.prepare('SELECT metadata FROM memories WHERE id = ?').get(id) as { metadata: string | null };
      const metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
      const scope = sqlite.prepare('SELECT user_id, team_id FROM memories WHERE id = ?').get(id) as { user_id: string | null; team_id: string | null };
      metadata.__squishProvenance = signMemoryProvenance({ content, projectId: null, type: 'fact',
        ownerId: scope.user_id, teamId: scope.team_id, sourceMemoryId: id, metadata });
      sqlite.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), id);
    }
    const tamperMetadata: Record<string, unknown> = { sourceId: 'source-original' };
    tamperMetadata.__squishProvenance = signMemoryProvenance({
      content: 'Tamper evidence fixture',
      projectId: null,
      type: 'fact',
      metadata: tamperMetadata,
    });
    sqlite.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run(JSON.stringify(tamperMetadata), ID_TAMPER_MEMORY);
    const forgedMetadata = { ...tamperMetadata, sourceId: 'source-forged' };
    sqlite.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run(JSON.stringify(forgedMetadata), ID_TAMPER_MEMORY);
    for (const [id, sourceMemoryId, content] of [
      ['strict-belief-public', ID_READ_MEMORY, 'public derived belief provenance isolation'],
      ['strict-belief-private', ID_PRIVATE_MEMORY, 'private derived belief provenance isolation'],
    ]) {
      const sourceScope = sqlite.prepare('SELECT user_id, team_id FROM memories WHERE id = ?').get(sourceMemoryId) as { user_id: string | null; team_id: string | null };
      const metadata: Record<string, unknown> = {
        sourceMemoryId,
        sourceId: sourceMemoryId,
        observedAt: new Date().toISOString(),
        derivation: { kind: 'extracted_belief', jobId: 'acl-wiring-fixture', index: 0, beliefType: 'belief', confidence: 0.9,
          status: 'active', reason: null, evidenceSummary: null },
      };
      metadata.__squishProvenance = signMemoryProvenance({
        content, projectId: null, type: 'belief', ownerId: sourceScope.user_id, teamId: sourceScope.team_id, sourceMemoryId, metadata,
      });
      sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, confidence, status, is_active, metadata)
        VALUES (?, 'belief', 'belief', ?, 0.9, 'active', 1, ?)`)
        .run(id, content, JSON.stringify(metadata));
    }
    const tamperedBeliefMetadata: Record<string, unknown> = {
      sourceMemoryId: ID_READ_MEMORY,
      derivation: { kind: 'extracted_belief', jobId: 'test-job', index: 0, beliefType: 'belief', confidence: 0.9,
        status: 'active', reason: null, evidenceSummary: null },
    };
    const tamperedSourceScope = sqlite.prepare('SELECT user_id, team_id FROM memories WHERE id = ?').get(ID_READ_MEMORY) as { user_id: string | null; team_id: string | null };
    tamperedBeliefMetadata.__squishProvenance = signMemoryProvenance({ content: 'signed belief confidence tamper fixture',
      projectId: null, type: 'belief', ownerId: tamperedSourceScope.user_id, teamId: tamperedSourceScope.team_id,
      sourceMemoryId: ID_READ_MEMORY, metadata: { ...tamperedBeliefMetadata,
        derivation: { ...(tamperedBeliefMetadata.derivation as object), confidence: 0.7 } } });
    sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, confidence, status, is_active, metadata)
      VALUES ('strict-belief-tampered-confidence', 'belief', 'belief', 'signed belief confidence tamper fixture', 0.9, 'active', 1, ?)`)
      .run(JSON.stringify(tamperedBeliefMetadata));
    const { buildAutoAclContext } = await import('../../../core/acl/read-gate.js');
    await expect(buildAutoAclContext()).rejects.toThrow('authenticated caller identity');

    const client = new SquishClient({ dataDir: testDataDir });
    const strictAdapterMemory = await client.remember('Signed adapter context fixture for strict session injection.', {
      type: 'fact', project: testDataDir, user: 'strict-test-caller',
    });
    const [claude, opencode, cursor, windsurf] = await Promise.all([
      import('../../../core/adapters/config/claude-code.js'),
      import('../../../core/adapters/config/opencode.js'),
      import('../../../core/adapters/config/cursor.js'),
      import('../../../core/adapters/config/windsurf.js'),
    ]);
    const strictAdapters: import('../../../core/adapters/types.js').AgentAdapter[] = [];
    const captureAdapter = (adapter: import('../../../core/adapters/types.js').AgentAdapter) => strictAdapters.push(adapter);
    claude.registerClaudeCodeAdapter(captureAdapter);
    opencode.registerOpenCodeAdapter(captureAdapter);
    cursor.registerCursorAdapter(captureAdapter);
    windsurf.registerWindsurfAdapter(captureAdapter);
    expect(strictAdapters).toHaveLength(4);
    const { recordSessionSignal } = await import('../../../core/session/working-set.js');
    await recordSessionSignal({
      sessionId: 'adapter-session-a', projectPath: testDataDir, classification: 'session-only',
      distilledContent: 'SESSION_A_CONTEXT_ONLY', toolName: 'test-session-a',
    });
    await recordSessionSignal({
      sessionId: 'adapter-session-b', projectPath: testDataDir, classification: 'session-only',
      distilledContent: 'SESSION_B_CONTEXT_ONLY', toolName: 'test-session-b',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Unexpected network request in local strict adapter flow'); };
    try {
      for (const strictAdapter of strictAdapters) {
        const adapterBootstrap = await strictAdapter.getSessionContext({ project: testDataDir, mode: 'startup' });
        expect(adapterBootstrap.memories).toContain(strictAdapterMemory.content);
        expect(adapterBootstrap.count).toBeGreaterThan(0);
        const selectedSessionA = await strictAdapter.getSessionContext({
          project: testDataDir, mode: 'startup', sessionId: 'adapter-session-a',
        });
        expect(selectedSessionA.memories).toContain('SESSION_A_CONTEXT_ONLY');
        expect(selectedSessionA.memories).not.toContain('SESSION_B_CONTEXT_ONLY');
        const selectedSessionB = await strictAdapter.getSessionContext({
          project: testDataDir, mode: 'startup', sessionId: 'adapter-session-b',
        });
        expect(selectedSessionB.memories).toContain('SESSION_B_CONTEXT_ONLY');
        expect(selectedSessionB.memories).not.toContain('SESSION_A_CONTEXT_ONLY');
        const unknownSession = await strictAdapter.getSessionContext({
          project: testDataDir, mode: 'startup', sessionId: 'adapter-session-unknown',
        });
        expect(unknownSession.memories).not.toContain('SESSION_A_CONTEXT_ONLY');
        expect(unknownSession.memories).not.toContain('SESSION_B_CONTEXT_ONLY');
        const adapterTimeline = await strictAdapter.getTimeline('ID read access fixture', 'detail', 5);
        expect(JSON.stringify(adapterTimeline)).toContain(ID_READ_MEMORY);
        await expect(strictAdapter.getSessionContext({
          project: testDataDir, mode: 'startup', user: 'different-principal',
        })).rejects.toThrow('does not match');
        const observation = await strictAdapter.recordObservation({
          toolName: 'Read', toolInput: { filePath: 'src/runtime.ts' },
          toolResult: { success: true, output: 'STRICT_SECRET_OUTPUT_DO_NOT_STORE' },
          project: testDataDir, sessionId: 'adapter-session',
        });
        const observationRow = sqlite.prepare('SELECT id, content, type, project_id, user_id, team_id, metadata FROM memories WHERE id = ?')
          .get(observation.memoryId) as { id: string; content: string; type: string; project_id: string | null; user_id: string; team_id: string | null; metadata: string };
        const observationMetadata = JSON.parse(observationRow.metadata) as Record<string, unknown>;
        expect(observationRow.content).toContain('src/runtime.ts');
        expect(observationRow.content).toContain('outcome: success=true');
        expect(observationRow.content).not.toContain('STRICT_SECRET_OUTPUT_DO_NOT_STORE');
        expect(observationRow.user_id).toBeTruthy();
        expect(observationMetadata.sourceId).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(String(observationMetadata.memoryContext)).not.toContain('STRICT_SECRET_OUTPUT_DO_NOT_STORE');
        expect(verifyMemoryProvenance({ content: observationRow.content, projectId: observationRow.project_id,
          type: observationRow.type, ownerId: observationRow.user_id, teamId: observationRow.team_id,
          sourceMemoryId: observationRow.id, metadata: observationMetadata })).toBe(true);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    const { getMemoryTimeline } = await import('../../../core/adapters/timeline.js');
    expect(JSON.stringify(await getMemoryTimeline(ID_READ_MEMORY, 'detail'))).toContain(ID_READ_MEMORY);
    process.env.SQUISH_PROFILE = 'high-recall';
    process.env.SQUISH_GRAPH_EXPANSION = 'true';
    process.env.SQUISH_GRAPH_BOOST_LEGACY = 'true';
    process.env.SQUISH_RERANKER_ENABLED = 'false';
    process.env.SQUISH_SEARCH_BELIEFS = 'true';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
    const { getGraphBackend } = await import('../../../core/search/graph-boost.js');
    const graphBackend = await getGraphBackend();
    await graphBackend.createEdge(ID_READ_MEMORY, ID_PRIVATE_MEMORY, {
      weight: 1,
      coactivationCount: 20,
      lastAccessedAt: new Date(),
      associationType: 'relates_to',
    });
    const strictGraphResults = await client.search('ID read access fixture', {
      user: 'strict-test-caller', limit: 50,
    });
    const authorizedGraphResult = strictGraphResults.find((result: any) => result.memory?.id === ID_READ_MEMORY);
    expect(authorizedGraphResult).toBeDefined();
    expect(authorizedGraphResult?.scoreBreakdown?.graph ?? 0).toBe(0);

    const results = await client.search('confidential roadmap', { user: 'strict-test-caller', limit: 50 });
    expect(results.map((r: any) => r.memory?.id)).not.toContain('mem-wired-private');

    const { buildStrictMemoryCandidateFilter } = await import('../../../core/acl/read-gate.js');
    const { beliefSearch } = await import('../../../core/memory/belief-search.js');
    const strictFilter = await buildStrictMemoryCandidateFilter({ userId: 'strict-test-caller' });
    const beliefCandidates = await beliefSearch({ query: 'public derived belief provenance isolation' }, 50, undefined, strictFilter);
    expect(beliefCandidates.some((result: any) => result.id === 'strict-belief-public')).toBe(true);
    expect(beliefCandidates.some((result: any) => result.id === 'strict-belief-private')).toBe(false);
    expect(beliefCandidates.some((result: any) => result.id === 'strict-belief-tampered-confidence')).toBe(false);

    const previousEmbeddingProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    const previousOpenAiKey = process.env.SQUISH_OPENAI_API_KEY;
    const previousOpenAiModel = process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
    const previousFetch = globalThis.fetch;
    const embeddingInputs: string[] = [];
    const { clearEmbeddingCache } = await import('../../../core/embeddings/embeddings.js');
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'openai';
    process.env.SQUISH_OPENAI_API_KEY = 'test-only-key';
    process.env.SQUISH_OPENAI_EMBEDDING_MODEL = 'strict-belief-cache-test';
    clearEmbeddingCache();
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      embeddingInputs.push(body.input);
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const cacheQuery = 'strict belief cache partition query';
      const sharedBeliefContent = 'public derived belief provenance isolation';
      const ownerResults = await beliefSearch({ query: cacheQuery }, 50, undefined, strictFilter);
      expect(ownerResults.some((result: any) => result.id === 'strict-belief-public')).toBe(true);
      expect(embeddingInputs.filter((input) => input === sharedBeliefContent)).toHaveLength(1);

      process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-second-caller';
      const secondCallerFilter = await buildStrictMemoryCandidateFilter({ userId: 'strict-second-caller' });
      const secondCallerResults = await beliefSearch({ query: cacheQuery }, 50, undefined, secondCallerFilter);
      expect(secondCallerResults.some((result: any) => result.id === 'strict-belief-public')).toBe(true);
      expect(embeddingInputs.filter((input) => input === sharedBeliefContent)).toHaveLength(2);

      process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-test-caller';
      await beliefSearch({ query: cacheQuery }, 50, undefined, strictFilter);
      expect(embeddingInputs.filter((input) => input === sharedBeliefContent)).toHaveLength(2);
    } finally {
      globalThis.fetch = previousFetch;
      clearEmbeddingCache();
      if (previousEmbeddingProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousEmbeddingProvider;
      if (previousOpenAiKey === undefined) delete process.env.SQUISH_OPENAI_API_KEY;
      else process.env.SQUISH_OPENAI_API_KEY = previousOpenAiKey;
      if (previousOpenAiModel === undefined) delete process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
      else process.env.SQUISH_OPENAI_EMBEDDING_MODEL = previousOpenAiModel;
      process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-test-caller';
    }

    const tamperedRow = sqlite.prepare("SELECT confidence, metadata FROM knowledge WHERE id='strict-belief-public'").get() as { confidence: number; metadata: string };
    sqlite.prepare("UPDATE knowledge SET confidence=0.2 WHERE id='strict-belief-public'").run();
    const tamperedProjectionCandidates = await beliefSearch({ query: 'public derived belief provenance isolation' }, 50, undefined, strictFilter);
    expect(tamperedProjectionCandidates.some((result: any) => result.id === 'strict-belief-public')).toBe(false);
    sqlite.prepare("UPDATE knowledge SET confidence=?, metadata=? WHERE id='strict-belief-public'").run(tamperedRow.confidence, tamperedRow.metadata);

    const eligibleCandidates = sqlite.prepare(`SELECT m.id FROM memories m WHERE ${strictFilter.sql}`)
      .all(...strictFilter.params) as Array<{ id: string }>;
    expect(eligibleCandidates.map((row) => row.id)).toContain(ID_READ_MEMORY);
    expect(eligibleCandidates.map((row) => row.id)).not.toContain(ID_PRIVATE_MEMORY);

    expect(await client.getById(ID_READ_MEMORY)).not.toBeNull();
    expect(await client.getById(ID_READ_MEMORY, { userId: 'strict-test-caller' })).not.toBeNull();
    expect(await client.getById(ID_TAMPER_MEMORY, { userId: 'strict-test-caller' })).toBeNull();
    expect(await client.getById(ID_PRIVATE_MEMORY, { userId: 'strict-test-caller' })).toBeNull();
    await expect(client.forget(ID_PRIVATE_MEMORY)).rejects.toThrow('denied deletion');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(ID_READ_MEMORY).count).toBe(1);
    await expect(client.forget(ID_PRIVATE_MEMORY, { userId: 'strict-test-caller' })).rejects.toThrow('denied deletion');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(ID_PRIVATE_MEMORY).count).toBe(1);
    expect((await client.getMemoriesByIds([ID_READ_MEMORY])).map((memory) => memory.id)).toEqual([ID_READ_MEMORY]);
    const batch = await client.getMemoriesByIds([ID_TAMPER_MEMORY, ID_READ_MEMORY, ID_PRIVATE_MEMORY], { userId: 'strict-test-caller' });
    expect(batch.map((memory) => memory.id)).toEqual([ID_READ_MEMORY]);
    const tamperedSearch = await client.search('Tamper evidence fixture', { user: 'strict-test-caller', limit: 20 });
    expect(tamperedSearch.map((result: any) => result.memory?.id)).not.toContain(ID_TAMPER_MEMORY);
    const authorizedSearch = await client.search('ID read access fixture', { user: 'strict-test-caller', limit: 20 });
    const authorizedSearchMemory = authorizedSearch.find((result) => result.memory.id === ID_READ_MEMORY)?.memory;
    expect(authorizedSearchMemory).toBeDefined();
    expect(authorizedSearchMemory?.createdAt).toBeUndefined();
    expect(authorizedSearchMemory?.updatedAt).toBeUndefined();

    await recordSessionSignal({
      sessionId: 'strict-context-session', projectPath: testDataDir, classification: 'session-only',
      distilledContent: 'private cross-agent working-set secret', toolName: 'test',
    });
    const { buildContextState, buildStatsState } = await import('../../../core/runtime/trust-state.js');
    await expect(buildContextState()).rejects.toThrow('authenticated caller identity');
    const context = await buildContextState(undefined, 10, { userId: 'strict-test-caller' });
    expect(context.runtime.sessionSummary).toContain('private cross-agent working-set secret');
    expect(context.beliefs).toEqual([]);
    expect(JSON.stringify(context)).not.toContain('confidential roadmap details');
    const { resolveTrustedCallerId } = await import('../../../core/acl/trust-policy.js');
    const boundCaller = resolveTrustedCallerId();
    process.env.SQUISH_TRUSTED_CALLER_ID = 'another-context-caller';
    const otherContext = await buildContextState(testDataDir, 10, { userId: 'another-context-caller' });
    expect(otherContext.runtime.sessionSummary).toBe('');
    expect(JSON.stringify(otherContext)).not.toContain('private cross-agent working-set secret');
    process.env.SQUISH_TRUSTED_CALLER_ID = boundCaller;
    expect(JSON.stringify(context)).toContain('private cross-agent working-set secret');
    expect((await buildStatsState(testDataDir) as any).wakeUp).toBe('No working set yet');
    expect(await client.getContext({ project: testDataDir })).toEqual([]);
    const implicitlyBoundRecall = await client.recall('confidential roadmap');
    expect(implicitlyBoundRecall.memories.map((memory) => memory.id)).not.toContain('mem-wired-private');
    const recalled = await client.recall('confidential roadmap', { user: 'strict-test-caller' });
    expect(recalled.memories.map((memory) => memory.id)).not.toContain('mem-wired-private');
    await expect(client.traverseGraph('Alice', testDataDir)).rejects.toThrow('authenticated caller identity');
    await expect(client.traverseGraph('Alice', testDataDir, { userId: 'strict-test-caller' })).rejects.toThrow('Raw graph traversal is disabled');
    await expect(client.getEntity('Alice', testDataDir)).rejects.toThrow('authenticated caller identity');
    await expect(client.getEntity('Alice', testDataDir, { userId: 'strict-test-caller' })).rejects.toThrow('Raw graph entity reads are disabled');
    await expect(client.getStats()).rejects.toThrow('Aggregate memory statistics are disabled');
    await expect(client.getPinnedMemories()).rejects.toThrow('Pinned-memory listing is disabled');
    await expect(client.getTierStats()).rejects.toThrow('Aggregate tier statistics are disabled');
    await expect(client.getMemorySnapshot()).rejects.toThrow('Raw memory snapshots are disabled');
    const { getMemorySnapshot } = await import('../../../core/runtime/squish-runtime.js');
    const { getMemoryHistory } = await import('../../../core/snapshots/retrieval.js');
    const { allAgentStores: getRawAgentStores, createAssociation: createRawAssociation, createLearning: createRawLearning, getMemory: getRawMemory, getSessionChunks: getRawSessionChunks, listSessions: listRawSessions, migrateMemories: migrateRawMemories, pinMemory: pinRawMemory, searchChunks: searchRawChunks, unpinMemory: unpinRawMemory, promoteToSturdy: promoteRawMemory } = await import('../../../core/runtime/squish-runtime.js');
    const { findRelatedSessions: findRawRelatedSessions } = await import('../../../core/sessions/store.js');
    await expect(getMemorySnapshot('unscoped-snapshot-id')).rejects.toThrow('Raw memory snapshots are disabled');
    await expect(getMemoryHistory('unscoped-memory-id')).rejects.toThrow('Raw memory history is disabled');
    await expect(getRawMemory(strictAdapterMemory.id, false)).rejects.toThrow('Unscoped raw memory reads are disabled');
    await expect(createRawAssociation(strictAdapterMemory.id, strictAdapterMemory.id, 'relates_to')).rejects.toThrow('Association writes are disabled');
    await pinRawMemory(strictAdapterMemory.id);
    await unpinRawMemory(strictAdapterMemory.id);
    await expect(promoteRawMemory(strictAdapterMemory.id)).rejects.toThrow('Memory tier promotion is disabled');
    await expect(createRawLearning({ type: 'insight', content: 'strict unscoped learning must not persist' })).rejects.toThrow('Unscoped learning writes are disabled');
    await expect(migrateRawMemories('missing-source', 'missing-target')).rejects.toThrow('Memory migration is disabled');
    await expect(listRawSessions()).rejects.toThrow('Raw external session history is disabled');
    await expect(getRawSessionChunks('untrusted-session')).rejects.toThrow('Raw external session history is disabled');
    await expect(searchRawChunks({ query: 'private session evidence' })).rejects.toThrow('Raw external session history is disabled');
    await expect(findRawRelatedSessions({ repo_path: 'untrusted-project' })).rejects.toThrow('Raw external session history is disabled');
    expect(() => getRawAgentStores()).toThrow('Raw agent session stores are unavailable under strict trust');
    const readableCreatedAt = Math.floor(Date.now() / 1000) - 100;
    const insertHiddenRecent = sqlite.prepare(`
      INSERT INTO memories (id, project_id, user_id, type, content, status, is_active, created_at)
      SELECT ?, project_id, NULL, 'fact', 'new private recent candidate', 'active', 1, ?
      FROM memories WHERE id = ?
    `);
    for (let index = 0; index < 12; index += 1) {
      const suffix = index.toString(16).padStart(12, '0');
      insertHiddenRecent.run(`a9b5cbce-23f0-4c8f-82b9-${suffix}`, Math.floor(Date.now() / 1000) + index, strictAdapterMemory.id);
    }
    const insertHiddenGlobal = sqlite.prepare(`
      INSERT INTO memories (id, project_id, user_id, type, content, status, is_active, created_at)
      VALUES (?, NULL, NULL, 'fact', 'new private global candidate', 'active', 1, ?)
    `);
    for (let index = 0; index < 12; index += 1) {
      const suffix = index.toString(16).padStart(12, '0');
      insertHiddenGlobal.run(`b9b5cbce-23f0-4c8f-82b9-${suffix}`, Math.floor(Date.now() / 1000) + index);
    }
    sqlite.prepare("UPDATE memories SET created_at = ? WHERE content <> 'new private recent candidate'")
      .run(readableCreatedAt - 10);
    sqlite.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(readableCreatedAt, strictAdapterMemory.id);
    const recentIds = (await client.getRecent(1, testDataDir)).map((memory) => memory.id);
    const listedRecentIds = (await client.listRecent({ limit: 1, project: testDataDir })).map((memory) => memory.id);
    expect(recentIds).toEqual([strictAdapterMemory.id]);
    expect(listedRecentIds).toContain(ID_READ_MEMORY);
    expect(recentIds).not.toContain(ID_PRIVATE_MEMORY);
    expect(listedRecentIds).not.toContain(ID_PRIVATE_MEMORY);
    await expect(client.listProjects()).rejects.toThrow('owner-scoped visibility');

    const audit = sqlite.prepare(
      "SELECT decision, reason FROM trust_audit_log WHERE decision = 'deny' AND reason = 'acl_rule'"
    ).all() as Array<{ decision: string; reason: string }>;
    expect(audit.length).toBeGreaterThan(0);

    const publicBelief = beliefCandidates.find((result: any) => result.id === 'strict-belief-public');
    expect(publicBelief).toBeDefined();
    const { applyAclReadGate } = await import('../../../core/acl/read-gate.js');
    const expectExpiredSourceBeliefDenied = async () => {
      const lifecycleFilter = await buildStrictMemoryCandidateFilter({ userId: 'strict-test-caller' });
      const lifecycleCandidates = await beliefSearch(
        { query: 'public derived belief provenance isolation' }, 50, undefined, lifecycleFilter,
      );
      expect(lifecycleCandidates.some((result: any) => result.id === 'strict-belief-public')).toBe(false);
      const finalGate = await applyAclReadGate(
        [publicBelief], { userId: 'strict-test-caller' }, () => 'knowledge',
      );
      expect(finalGate).toHaveLength(0);
    };
    sqlite.prepare("UPDATE memories SET expires_at = CAST(strftime('%s','now') AS INTEGER) - 1 WHERE id = ?")
      .run(ID_READ_MEMORY);
    await expectExpiredSourceBeliefDenied();
    sqlite.prepare('UPDATE memories SET expires_at = NULL, is_active = 0 WHERE id = ?').run(ID_READ_MEMORY);
    await expectExpiredSourceBeliefDenied();
    sqlite.prepare("UPDATE memories SET is_active = 1, status = 'archived' WHERE id = ?").run(ID_READ_MEMORY);
    await expectExpiredSourceBeliefDenied();
  }, 30_000);
});
