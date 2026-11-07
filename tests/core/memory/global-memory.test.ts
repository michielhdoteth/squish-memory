/**
 * Tests for global memory operations
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let search: typeof import('../../../core/memory/memories.js').search;
let getMemory: typeof import('../../../core/memory/memories.js').getMemory;
let createAssociation: typeof import('../../../core/associations.js').createAssociation;
let GLOBAL_PROJECT_PATH: string;
let getOrCreateProject: typeof import('../../../core/projects.js').getOrCreateProject;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

describe('Global Memory Operations', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-global-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const memoriesMod = await import('../../../core/memory/memories.js');
    const placesMod = await import('../../../core/places/places.js');
    const associationsMod = await import('../../../core/associations.js');
    const projectsMod = await import('../../../core/projects.js');
    const dbMod = await import('../../../db/index.js');
    rememberMemory = memoriesMod.rememberMemory;
    search = memoriesMod.search;
    getMemory = memoriesMod.getMemory;
    createAssociation = associationsMod.createAssociation;
    getOrCreateProject = projectsMod.getOrCreateProject;
    GLOBAL_PROJECT_PATH = placesMod.GLOBAL_PROJECT_PATH;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;
    resetDb();
  });

  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    const db = await getDb();
    const sqlite = (db as any).$client;
    if (sqlite && typeof sqlite.exec === 'function') {
      sqlite.exec('DELETE FROM memories;');
      sqlite.exec('DELETE FROM places;');
    }
  });

  test('rememberMemory with global project stores memory globally', async () => {
    const result = await rememberMemory({
      content: 'This is a global memory',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    expect(result).toBeDefined();
    expect(result.projectId).toBeDefined();
  });

  test('host capture replay is idempotent, rejects key reuse with changed content, and forget clears its receipt', async () => {
    const captureKey = 'sha256:claude-code/session-27/user-3/assistant-4';
    const input = {
      content: 'User: Remember the service boundary.\n\nAssistant: The API owns durable state.',
      project: GLOBAL_PROJECT_PATH,
      type: 'context' as const,
      sessionId: 'session-27',
      captureKey,
      metadata: { source: 'claude-code' },
    };
    const first = await rememberMemory(input);
    const replay = await rememberMemory(input);
    expect(replay.id).toBe(first.id);

    const sqlite = ((await getDb()) as any).$client;
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(first.id).count).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_capture_receipts WHERE memory_id = ?').get(first.id).count).toBe(1);
    await expect(rememberMemory({ ...input, content: 'same source identity, changed content' }))
      .rejects.toThrow('Capture key was already used for different content or memory scope');

    const { deleteMemoryPermanently } = await import('../../../core/memory/stale-cleaner.js');
    await deleteMemoryPermanently(first.id);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_capture_receipts WHERE memory_id = ?').get(first.id).count).toBe(0);
    const recaptured = await rememberMemory(input);
    expect(recaptured.id).not.toBe(first.id);
  });

  test('strict host capture replay returns only the caller-authorized signed source', async () => {
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
    };
    const { generateKeyPairSync } = await import('node:crypto');
    const keyPair = generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-capture-user';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ 'sqlite-capture-test': publicKey });
    process.env.SQUISH_PROVENANCE_KEY_ID = 'sqlite-capture-test';
    const input = {
      content: 'User: Keep the verified API ownership decision.',
      type: 'fact' as const,
      project: testDataDir,
      user: 'strict-capture-user',
      captureKey: `strict-replay-${Date.now()}`,
    };
    try {
      const first = await rememberMemory(input);
      const replay = await rememberMemory(input);
      expect(replay.id).toBe(first.id);
      expect(replay.content).toBe(input.content);
    } finally {
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
        SQUISH_PROVENANCE_PUBLIC_KEYS: previous.publicKeys,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('client encryption stores no plaintext derivatives and fails closed on a wrong passphrase', { timeout: 15000 }, async () => {
    const previousEnabled = process.env.SQUISH_ENCRYPTION_ENABLED;
    const previousPassphrase = process.env.SQUISH_ENCRYPTION_PASSPHRASE;
    process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'isolated-encryption-test-passphrase';
    try {
      const secret = 'sensitive marker 73QX only in ciphertext';
      const { eventBus } = await import('../../../core/event-bus.js');
      const capturedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const unsubscribe = eventBus.on((event) => {
        if (event.type === 'memory:stored' && event.payload.content === secret) capturedEvents.push(event);
      });
      const memory = await rememberMemory({
        content: secret,
        project: GLOBAL_PROJECT_PATH,
        type: 'fact',
        tags: ['private-marker'],
        metadata: { privateMarker: secret },
      });
      unsubscribe();
      expect(capturedEvents).toHaveLength(0);
      const db = await getDb();
      const sqlite = (db as any).$client;
      const source = sqlite.prepare(`SELECT content, encrypted_content, encryption_nonce, is_encrypted,
        tags, embedding_json, embedding_blob, summary, metadata FROM memories WHERE id = ?`).get(memory.id);
      const projection = sqlite.prepare(`SELECT id, content, encrypted_content, encryption_nonce, is_encrypted,
        embedding_json, embedding_blob, tags, metadata
        FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') = ?`).get(memory.id);

      expect(source.content).toBe('');
      expect(source.encrypted_content).toBeTruthy();
      expect(source.encryption_nonce).toBeTruthy();
      expect(source.is_encrypted).toBe(1);
      expect(String(source.tags ?? '')).not.toContain('private-marker');
      expect(source.embedding_json).toBeNull();
      expect(source.embedding_blob).toBeNull();
      expect(source.summary).toBeNull();
      expect(source.metadata).not.toContain(secret);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM context_sessions WHERE metadata LIKE ?').get(`%${secret}%`).count).toBe(0);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE json_extract(metadata, '$.sourceMemoryIds[0]') = ?").get(memory.id).count).toBe(0);
      expect(projection.content).toBe('');
      expect(projection.encrypted_content).toBe(source.encrypted_content);
      expect(projection.encryption_nonce).toBe(source.encryption_nonce);
      expect(projection.is_encrypted).toBe(1);
      expect(projection.embedding_json).toBeNull();
      expect(projection.embedding_blob).toBeNull();
      expect(String(projection.tags ?? '')).not.toContain('private-marker');
      expect(projection.metadata).not.toContain(secret);
      expect(await search({ query: 'sensitive marker 73QX', project: GLOBAL_PROJECT_PATH })).toHaveLength(0);
      expect((await getMemory(memory.id))?.content).toBe(secret);

      // Simulate derivatives left by an older encrypted-write implementation.
      const projectId = sqlite.prepare('SELECT project_id FROM memories WHERE id = ?').get(memory.id).project_id as string;
      sqlite.prepare(`UPDATE memories SET summary = ?, tags = ?, metadata = ?, tokens_estimate = 8 WHERE id = ?`)
        .run(secret, JSON.stringify(['private-marker']), JSON.stringify({ sourceMemoryId: memory.id, entities: ['EncryptedOnlyEntity', 'SharedEntity'], leak: secret }), memory.id);
      sqlite.prepare(`UPDATE knowledge SET content = ?, summary = ?, tags = ?, metadata = ?, embedding_json = ? WHERE id = ?`)
        .run(secret, secret, JSON.stringify(['private-marker']), JSON.stringify({ sourceMemoryId: memory.id, leak: secret }), '[1]', projection.id);

      // Seed legacy, explicitly source-linked derivatives from before the
      // encrypted-write boundary existed. memory_places is a legacy-only
      // source, so create its fixture explicitly on this fresh database.
      sqlite.exec(`CREATE TABLE IF NOT EXISTS memory_places (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, place_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0, reason TEXT, source TEXT DEFAULT 'heuristic',
        is_primary INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0, place_sort_order INTEGER DEFAULT 0
      )`);
      sqlite.prepare(`INSERT INTO memory_places (id, memory_id, place_type, reason, source)
        VALUES (?, ?, ?, ?, 'legacy')`).run(`enc-place-${memory.id}`, memory.id, 'private-marker', secret);
      sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content, metadata, diff)
        VALUES (?, ?, 'before_update', ?, ?, ?)`)
        .run(`enc-snapshot-${memory.id}`, memory.id, secret, JSON.stringify({ leak: secret }), secret);
      const { encryptBound } = await import('../../../core/security/encrypt.js');
      const encryptedHistoryId = `enc-history-${memory.id}`;
      const encryptedHistory = encryptBound(JSON.stringify({ content: secret, metadata: {}, diff: {} }), {
        format: 'squish-aesgcm-aad-v1', snapshotId: encryptedHistoryId, memoryId: memory.id,
        projectId, ownerId: '',
      });
      sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content, metadata, diff,
        encrypted_payload, encrypted_nonce, encryption_format)
        VALUES (?, ?, 'correction', '', ?, NULL, ?, ?, 'squish-aesgcm-aad-v1')`)
        .run(encryptedHistoryId, memory.id, JSON.stringify({ encryptionFormat: 'squish-aesgcm-aad-v1' }),
          encryptedHistory.ciphertext, encryptedHistory.nonce);
      sqlite.prepare(`INSERT INTO memory_edit_proposals
        (id, project_id, memory_id, current_content, proposed_content, reason)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(`enc-proposal-${memory.id}`, projectId, memory.id, secret, secret, secret);
      sqlite.prepare(`INSERT INTO agent_preferences (id, project_id, key, value, source_memory_id)
        VALUES (?, ?, ?, ?, ?)`)
        .run(`enc-pref-${memory.id}`, projectId, `private-${memory.id}`, secret, memory.id);
      sqlite.prepare(`INSERT INTO entities (id, project_id, name, type, description, properties, aliases)
        VALUES (?, ?, 'EncryptedOnlyEntity', 'person', ?, ?, ?), (?, ?, 'SharedEntity', 'person', ?, ?, ?)`)
        .run(`enc-entity-${memory.id}`, projectId, secret, JSON.stringify({ leak: secret }), JSON.stringify([secret]),
          `shared-entity-${memory.id}`, projectId, secret, JSON.stringify({ leak: secret }), JSON.stringify([secret]));
      sqlite.prepare(`INSERT INTO memories (id, project_id, type, content, metadata, is_encrypted)
        VALUES (?, ?, 'fact', 'SharedEntity is also described by a non-encrypted source', ?, 0)`)
        .run(`plain-support-${memory.id}`, projectId, JSON.stringify({ entities: ['SharedEntity'] }));
      const mergeSiblingId = `plain-merge-sibling-${memory.id}`;
      const mergeCanonicalId = `encrypted-merge-canonical-${memory.id}`;
      const mergeProposalId = `encrypted-merge-proposal-${memory.id}`;
      const mergeHistoryId = `encrypted-merge-history-${memory.id}`;
      sqlite.prepare(`INSERT INTO memories (id, project_id, type, content, metadata, source, is_active, is_canonical,
        merge_source_ids, is_merged, merged_into_id)
        VALUES (?, ?, 'fact', 'Unencrypted sibling must be restored after retracting its mixed merge', '{}', 'mcp', 0, 0, NULL, 1, ?),
          (?, ?, 'fact', ?, ?, 'merge', 1, 1, ?, 0, NULL)`)
        .run(mergeSiblingId, projectId, mergeCanonicalId, mergeCanonicalId, projectId, secret,
          JSON.stringify({ mergedFrom: [memory.id, mergeSiblingId] }), JSON.stringify([memory.id, mergeSiblingId]));
      sqlite.prepare(`INSERT INTO memory_merge_proposals
        (id, project_id, source_memory_ids, proposed_content, detection_method, similarity_score,
          confidence_level, merge_reason)
        VALUES (?, ?, ?, ?, 'simhash', '0.9', 'high', 'legacy encrypted-source proposal')`)
        .run(mergeProposalId, projectId, JSON.stringify([memory.id, mergeSiblingId]), secret);
      sqlite.prepare(`INSERT INTO memory_merge_history
        (id, project_id, source_memory_ids, canonical_memory_id, source_memories_snapshot, merge_strategy)
        VALUES (?, ?, ?, ?, ?, 'union')`)
        .run(mergeHistoryId, projectId, JSON.stringify([memory.id, mergeSiblingId]), mergeCanonicalId,
          JSON.stringify([{ id: memory.id, content: secret }, { id: mergeSiblingId, content: 'Unencrypted sibling' }]));
      sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata)
        VALUES (?, ?, 'memory', 'fact', ?, ?)`)
        .run(mergeCanonicalId, projectId, secret, JSON.stringify({ sourceMemoryId: mergeCanonicalId, mergedFrom: [memory.id, mergeSiblingId] }));
      sqlite.prepare(`INSERT INTO knowledge_edges
        (id, from_id, from_kind, to_id, to_kind, edge_type, metadata)
        VALUES (?, ?, 'entity', ?, 'entity', 'mentioned_together', ?)`)
        .run(`enc-edge-${memory.id}`, `enc-entity-${memory.id}`, `shared-entity-${memory.id}`, JSON.stringify({ sourceMemoryIds: [memory.id], context: secret }));
      sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata)
        VALUES (?, ?, 'memory', 'fact', ?, ?), (?, ?, 'belief', 'preference', ?, ?)`)
        .run(`enc-derived-fact-${memory.id}`, projectId, secret,
          JSON.stringify({ sourceMemoryId: memory.id, analysisJobId: `old-job-${memory.id}`, derivation: { evidence: secret } }),
          `enc-derived-belief-${memory.id}`, projectId, secret,
          JSON.stringify({ sourceMemoryId: memory.id, derivation: { reason: secret } }));
      sqlite.prepare(`INSERT INTO knowledge_edges
        (id, from_id, from_kind, to_id, to_kind, edge_type, metadata)
        VALUES (?, ?, 'knowledge', ?, 'knowledge', 'sourced_from', ?),
          (?, ?, 'knowledge', ?, 'knowledge', 'sourced_from', ?)`)
        .run(`enc-derived-fact-edge-${memory.id}`, `enc-derived-fact-${memory.id}`, projection.id, '{}',
          `enc-derived-belief-edge-${memory.id}`, `enc-derived-belief-${memory.id}`, projection.id, '{}');
      sqlite.exec(`CREATE TABLE IF NOT EXISTS mental_models (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '', source_memory_ids TEXT NOT NULL DEFAULT '[]'
      )`);
      sqlite.prepare(`INSERT INTO mental_models (id, project_id, title, content, source_memory_ids)
        VALUES (?, ?, ?, ?, ?)`)
        .run(`enc-model-${memory.id}`, projectId, secret, secret, JSON.stringify([memory.id]));
      sqlite.exec(`CREATE TABLE IF NOT EXISTS beliefs (id TEXT PRIMARY KEY, statement TEXT NOT NULL)`);
      sqlite.exec(`CREATE TABLE IF NOT EXISTS belief_memory_sources (id TEXT PRIMARY KEY, belief_id TEXT, memory_id TEXT)`);
      sqlite.prepare('INSERT INTO beliefs (id, statement) VALUES (?, ?)').run(`enc-belief-${memory.id}`, secret);
      sqlite.prepare('INSERT INTO belief_memory_sources (id, belief_id, memory_id) VALUES (?, ?, ?)')
        .run(`enc-belief-source-${memory.id}`, `enc-belief-${memory.id}`, memory.id);

      const { runKnowledgeMigrations } = await import('../../../db/migrations/knowledge.js');
      sqlite.exec(`CREATE TRIGGER fail_encrypted_scrub_snapshot BEFORE DELETE ON memory_snapshots
        WHEN OLD.memory_id = '${memory.id}' BEGIN SELECT RAISE(ABORT, 'injected encrypted scrub failure'); END`);
      await expect(runKnowledgeMigrations(sqlite)).rejects.toThrow('injected encrypted scrub failure');
      expect(sqlite.prepare('SELECT summary FROM memories WHERE id = ?').get(memory.id).summary).toBe(secret);
      expect(sqlite.prepare('SELECT id FROM memory_places WHERE memory_id = ?').get(memory.id)).toBeDefined();
      expect(sqlite.prepare('SELECT content FROM knowledge WHERE id = ?').get(projection.id).content).toBe(secret);
      sqlite.exec('DROP TRIGGER fail_encrypted_scrub_snapshot');
      await runKnowledgeMigrations(sqlite);
      const scrubbedSource = sqlite.prepare(`SELECT content, summary, tags, metadata, tokens_estimate FROM memories WHERE id = ?`).get(memory.id);
      const scrubbedProjection = sqlite.prepare(`SELECT content, summary, tags, metadata, embedding_json, encrypted_content, is_encrypted FROM knowledge WHERE id = ?`).get(projection.id);
      expect(scrubbedSource.content).toBe('');
      expect(scrubbedSource.summary).toBeNull();
      expect(scrubbedSource.tags).toBe('[]');
      expect(scrubbedSource.metadata).not.toContain(secret);
      expect(scrubbedSource.tokens_estimate).toBe(0);
      expect(scrubbedProjection.content).toBe('');
      expect(scrubbedProjection.summary).toBeNull();
      expect(scrubbedProjection.tags).toBeNull();
      expect(scrubbedProjection.metadata).not.toContain(secret);
      expect(scrubbedProjection.embedding_json).toBeNull();
      expect(scrubbedProjection.encrypted_content).toBeTruthy();
      expect(scrubbedProjection.is_encrypted).toBe(1);
      expect(sqlite.prepare('SELECT id FROM memory_places WHERE memory_id = ?').get(memory.id)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM memory_snapshots WHERE id = ?').get(`enc-snapshot-${memory.id}`)).toBeNull();
      expect(sqlite.prepare('SELECT id, content, encrypted_payload FROM memory_snapshots WHERE id = ?')
        .get(encryptedHistoryId)).toMatchObject({ id: encryptedHistoryId, content: '', encrypted_payload: encryptedHistory.ciphertext });
      expect(sqlite.prepare('SELECT id FROM memory_edit_proposals WHERE memory_id = ?').get(memory.id)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM agent_preferences WHERE source_memory_id = ?').get(memory.id)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM mental_models WHERE id = ?').get(`enc-model-${memory.id}`)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM beliefs WHERE id = ?').get(`enc-belief-${memory.id}`)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM knowledge_edges WHERE id = ?').get(`enc-edge-${memory.id}`)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(`enc-derived-fact-${memory.id}`)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(`enc-derived-belief-${memory.id}`)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM memory_merge_proposals WHERE id = ?').get(mergeProposalId)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM memory_merge_history WHERE id = ?').get(mergeHistoryId)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(mergeCanonicalId)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(mergeCanonicalId)).toBeNull();
      expect(sqlite.prepare('SELECT is_merged, merged_into_id, is_active FROM memories WHERE id = ?').get(mergeSiblingId))
        .toEqual({ is_merged: 0, merged_into_id: null, is_active: 1 });
      expect(sqlite.prepare('SELECT id FROM knowledge_edges WHERE id = ?').get(`enc-derived-fact-edge-${memory.id}`)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM knowledge_edges WHERE id = ?').get(`enc-derived-belief-edge-${memory.id}`)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM entities WHERE id = ?').get(`enc-entity-${memory.id}`)).toBeNull();
      const sharedEntity = sqlite.prepare('SELECT name, description, properties, aliases FROM entities WHERE id = ?').get(`shared-entity-${memory.id}`);
      expect(sharedEntity.name).toBe('SharedEntity');
      expect(sharedEntity.description).toBeNull();
      expect(sharedEntity.properties).toBe('{}');
      expect(sharedEntity.aliases).toBe('[]');

      process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'isolated-encryption-test-passphrase';
      const { deleteMemoryPermanently } = await import('../../../core/memory/stale-cleaner.js');
      await deleteMemoryPermanently(memory.id);
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memory.id)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(projection.id)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE json_extract(metadata, "$.sourceMemoryId") = ?').get(memory.id)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM memory_snapshots WHERE memory_id = ?').get(memory.id)).toBeNull();
      expect(sqlite.prepare('SELECT capture_key_hash FROM memory_capture_receipts WHERE memory_id = ?').get(memory.id)).toBeNull();

      process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'wrong-isolated-passphrase';
      await expect(getMemory(memory.id)).resolves.toBeNull();
    } finally {
      if (previousEnabled === undefined) delete process.env.SQUISH_ENCRYPTION_ENABLED;
      else process.env.SQUISH_ENCRYPTION_ENABLED = previousEnabled;
      if (previousPassphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
      else process.env.SQUISH_ENCRYPTION_PASSPHRASE = previousPassphrase;
    }
  });

  test('rememberMemory with different project stores locally', async () => {
    const result = await rememberMemory({
      content: 'This is a local memory',
      project: '/local/project',
      type: 'fact',
      user: 'test-user'
    });
    expect(result).toBeDefined();
    expect(result.projectId).toBeDefined();
  });

  test('search with project finds global memories', async () => {
    const mem = await rememberMemory({
      content: 'Findable global memory',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    const results = await search({ query: 'Findable global memory', project: GLOBAL_PROJECT_PATH });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.id === mem.id)).toBe(true);
  });

  test('search with different project does not find global memories', async () => {
    await rememberMemory({
      content: 'Hidden global memory',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    // Create the other project so requireProject doesn't throw
    await getOrCreateProject('/test-other-project');
    // Search a different project - global memories should not appear
    const results = await search({ query: 'Hidden global memory', project: '/test-other-project' });
    // The search may return empty or only project-scoped results
    expect(results.every(r => r.content !== 'Hidden global memory')).toBe(true);
  });

  test('getMemory returns global memory by id', async () => {
    const memory = await rememberMemory({
      content: 'Gettable by id global',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    const found = await getMemory(memory.id);
    expect(found).not.toBeNull();
    expect(found!.content).toContain('Gettable by id global');
  });

  test('getMemory returns null for non-existent id', async () => {
    const found = await getMemory('00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });

  test('createAssociation links two global memories', async () => {
    const m1 = await rememberMemory({
      content: 'First global memory',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    const m2 = await rememberMemory({
      content: 'Second global memory',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });

    await createAssociation(m1.id, m2.id, 'relates_to', 1.0);

    // Verify the association was created by querying raw DB
    const db = await getDb();
    const sqlite = (db as any).$client;
    const rows = sqlite.prepare(`
      SELECT e.id FROM knowledge_edges e
      JOIN knowledge f ON f.id = e.from_id
      JOIN knowledge t ON t.id = e.to_id
      WHERE json_extract(f.metadata, '$.sourceMemoryId') = ?
        AND json_extract(t.metadata, '$.sourceMemoryId') = ?
        AND e.edge_type = 'relates_to'
        AND e.valid_to IS NULL
    `).all(m1.id, m2.id);
    expect(rows.length).toBe(1);
    expect(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_associations'").get()).toBeNull();
  });

  test('search finds memories across global scope', async () => {
    await rememberMemory({
      content: 'Unique search content alpha',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    const results = await search({ query: 'Unique search content alpha' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
