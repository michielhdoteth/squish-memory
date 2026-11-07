import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const dataDir = join(tmpdir(), `squish-acl-write-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const savedEnv = new Map<string, string | undefined>();
const envKeys = [
  'SQUISH_DATA_DIR',
  'DATABASE_URL',
  'SQUISH_TRUST_POLICY',
  'SQUISH_TRUSTED_CALLER_ID',
  'SQUISH_PROVENANCE_PRIVATE_KEY',
  'SQUISH_PROVENANCE_PUBLIC_KEY',
  'SQUISH_PROVENANCE_KEY_ID',
    'SQUISH_EMBEDDINGS_PROVIDER',
  'SQUISH_LOCAL_BUNDLED_MODEL',
  'SQUISH_SKIP_CONTRADICTION',
  'SQUISH_GRAPH_AUTO_BUILD',
  'SQUISH_LLM_ENABLED',
  'SQUISH_GEOMETRY_AUTO_CONSOLIDATE',
  'SQUISH_WRITE_DEDUP',
  'SQUISH_ENCRYPTION_ENABLED',
  'SQUISH_ENCRYPTION_PASSPHRASE',
];

describe('strict trust write gate', () => {
  let rememberMemory: typeof import('../../../core/memory/memory-write.js').rememberMemory;
  let getDb: typeof import('../../../db/index.js').getDb;
  let closeAllDbs: typeof import('../../../db/index.js').closeAllDbs;
  let verifyMemoryProvenance: typeof import('../../../core/acl/provenance.js').verifyMemoryProvenance;
  let signMemoryProvenance: typeof import('../../../core/acl/provenance.js').signMemoryProvenance;
  let verifySignedBeliefProjection: typeof import('../../../core/acl/provenance.js').verifySignedBeliefProjection;
  let createKnowledge: typeof import('../../../core/knowledge/knowledge-crud.js').createKnowledge;
  let applyFeedback: typeof import('../../../core/memory/reinforcement.js').applyFeedback;
  let createKnowledgeEdge: typeof import('../../../core/knowledge/knowledge-edges.js').createKnowledgeEdge;
  let setVisibilityRule: typeof import('../../../core/loadout/loadout.js').setVisibilityRule;
  let updateRetrievalPriority: typeof import('../../../core/memory/feedback-tracker.js').updateRetrievalPriority;
  let recordInjection: typeof import('../../../core/memory/feedback-tracker.js').recordInjection;
  let analyzeAndRecordFeedback: typeof import('../../../core/memory/feedback-tracker.js').analyzeAndRecordFeedback;
  let getMemoryFeedbackStats: typeof import('../../../core/memory/feedback-tracker.js').getMemoryFeedbackStats;
  let recordSessionSignal: typeof import('../../../core/session/working-set.js').recordSessionSignal;
  let getSessionWorkingSet: typeof import('../../../core/session/working-set.js').getSessionWorkingSet;
  let recordFeedback: typeof import('../../../core/memory/retrieval-feedback.js').recordFeedback;
  let recordUsefulRetrieval: typeof import('../../../core/memory/retrieval-feedback.js').recordUsefulRetrieval;
  let recordCitation: typeof import('../../../core/memory/retrieval-feedback.js').recordCitation;
  let getRetrievalStats: typeof import('../../../core/memory/retrieval-feedback.js').getRetrievalStats;
  let getOverallFeedbackStats: typeof import('../../../core/memory/retrieval-feedback.js').getOverallFeedbackStats;
  let flushFeedback: typeof import('../../../core/memory/retrieval-feedback.js').flushFeedback;
  let config: typeof import('../../../config.js').config;

  beforeAll(async () => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    mkdirSync(dataDir, { recursive: true });
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'trusted-memory-writer';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
    process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
    process.env.SQUISH_SKIP_CONTRADICTION = 'true';
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_KEY_ID = 'acl-write-test';

    ({ rememberMemory } = await import('../../../core/memory/memory-write.js'));
    ({ getDb, closeAllDbs } = await import('../../../db/index.js'));
    ({ verifyMemoryProvenance, signMemoryProvenance, verifySignedBeliefProjection } = await import('../../../core/acl/provenance.js'));
    ({ createKnowledge } = await import('../../../core/knowledge/knowledge-crud.js'));
    ({ applyFeedback } = await import('../../../core/memory/reinforcement.js'));
    ({ createKnowledgeEdge } = await import('../../../core/knowledge/knowledge-edges.js'));
    ({ setVisibilityRule } = await import('../../../core/loadout/loadout.js'));
    ({ updateRetrievalPriority, recordInjection, analyzeAndRecordFeedback, getMemoryFeedbackStats } = await import('../../../core/memory/feedback-tracker.js'));
    ({ recordSessionSignal, getSessionWorkingSet } = await import('../../../core/session/working-set.js'));
    ({ recordFeedback, recordUsefulRetrieval, recordCitation, getRetrievalStats, getOverallFeedbackStats, flushFeedback } = await import('../../../core/memory/retrieval-feedback.js'));
    ({ config } = await import('../../../config.js'));
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

  it('does not let a request claim a different writer identity', async () => {
    await expect(rememberMemory({ content: 'forged writer memory', user: 'someone-else' }))
      .rejects.toThrow('does not match the authenticated principal');
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: () => { count: number } } } }).$client;
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories').get().count).toBe(0);
  });

  it('binds owner and provenance to the configured principal on a normal write', async () => {
    const memory = await rememberMemory({ content: 'trusted owner memory', type: 'fact' });
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: (id: string) => { external_id: string; user_id: string; team_id: string | null; project_id: string | null; type: string; content: string; metadata: string } } } }).$client;
    const row = sqlite.prepare('SELECT u.external_id, m.user_id, m.team_id, m.project_id, m.type, m.content, m.metadata FROM memories m JOIN users u ON u.id=m.user_id WHERE m.id=?').get(memory.id);
    expect(row.external_id).toBe('trusted-memory-writer');
    expect(verifyMemoryProvenance({
      content: row.content,
      projectId: row.project_id,
      type: row.type,
      ownerId: row.user_id,
      teamId: row.team_id,
      sourceMemoryId: memory.id,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    })).toBe(true);

    const projection = sqlite.prepare('SELECT id, project_id, knowledge_type, content, metadata FROM knowledge WHERE json_extract(metadata, "$.sourceMemoryId") = ?').get(memory.id) as {
      id: string; project_id: string | null; knowledge_type: string; content: string; metadata: string;
    };
    expect(projection).toBeDefined();
    const projectionMetadata = JSON.parse(projection.metadata) as Record<string, unknown>;
    expect(verifyMemoryProvenance({
      content: projection.content,
      projectId: projection.project_id,
      type: projection.knowledge_type,
      ownerId: row.user_id,
      teamId: row.team_id,
      sourceMemoryId: memory.id,
      metadata: projectionMetadata,
    })).toBe(true);
    expect(projection.id).not.toBe(memory.id);
  });

  it('signs strict encrypted sources while keeping plaintext out of persisted projections', async () => {
    const previousEncryptionEnabled = process.env.SQUISH_ENCRYPTION_ENABLED;
    const previousEncryptionPassphrase = process.env.SQUISH_ENCRYPTION_PASSPHRASE;
    const previousProvenancePrivateKey = process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
    process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'strict-encrypted-write-test-passphrase';
    try {
      const content = 'Strict encrypted source marker 8FQ2';
      const hiddenSessionId = 'encrypted-session-id-marker';
      const hiddenSource = `session_chunk:${hiddenSessionId}`;
      const memory = await rememberMemory({ content, type: 'fact', metadata: { private: content, session_id: hiddenSessionId },
        source: hiddenSource, sessionId: hiddenSessionId });
      const db = await getDb();
      const sqlite = (db as { $client: { prepare: (sql: string) => { get: (...args: string[]) => Record<string, unknown> } } }).$client;
      const source = sqlite.prepare(`SELECT m.content, m.source, m.encrypted_content, m.encryption_nonce, m.is_encrypted,
        m.metadata, m.project_id, m.type, m.user_id, m.team_id FROM memories m WHERE m.id = ?`).get(memory.id);
      const projection = sqlite.prepare(`SELECT content, session_id, encrypted_content, encryption_nonce, is_encrypted, metadata
        FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') = ?`).get(memory.id);

      expect(source.content).toBe('');
      expect(source.source).toBe('client-encrypted');
      expect(source.source).not.toContain(hiddenSessionId);
      expect(source.encrypted_content).toBeTruthy();
      expect(source.encryption_nonce).toBeTruthy();
      expect(source.is_encrypted).toBe(1);
      expect(source.metadata).not.toContain(content);
      expect(verifyMemoryProvenance({
        content,
        projectId: source.project_id,
        type: source.type,
        ownerId: source.user_id,
        teamId: source.team_id,
        sourceMemoryId: memory.id,
        metadata: JSON.parse(source.metadata as string) as Record<string, unknown>,
      })).toBe(true);
      expect(projection.content).toBe('');
      expect(projection.session_id).toBeNull();
      expect(projection.encrypted_content).toBe(source.encrypted_content);
      expect(projection.encryption_nonce).toBe(source.encryption_nonce);
      expect(projection.is_encrypted).toBe(1);
      expect(projection.metadata).not.toContain(content);
      const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
      const client = new SquishRuntime({ dataDir });
      expect((await client.getById(memory.id))?.content).toBe(content);
      expect((await client.getMemoriesByIds([memory.id])).map((item) => item.content)).toEqual([content]);
      expect((await client.search(content, { user: 'trusted-memory-writer', limit: 20 }))
        .some((result) => result.memory?.id === memory.id)).toBe(false);
      const privateSessionId = 'private-session-recovery-id-7DF2';
      const privateSessionContent = 'PRIVATE_SESSION_RECOVERY_MARKER_7DF2';
      const sessionChunk = {
        type: 'summary' as const,
        content: privateSessionContent,
        session_id: privateSessionId,
        session_title: 'Private Session Title 7DF2',
        project: dataDir,
        repo_path: dataDir,
        branch: 'private-branch-7DF2',
        agent: 'codex' as const,
        agent_session_id: 'private-agent-session-7DF2',
        timestamp: new Date().toISOString(),
      };
      const capturedSessionIds = await client.captureSessionChunks([sessionChunk], { project: dataDir, user: 'trusted-memory-writer' });
      expect(capturedSessionIds).toHaveLength(1);
      const indexedSource = sqlite.prepare(`SELECT m.source, m.tags, m.metadata, k.session_id AS projection_session_id
        FROM memories m JOIN knowledge k ON json_extract(k.metadata, '$.sourceMemoryId') = m.id WHERE m.id = ?`)
        .get(capturedSessionIds[0]);
      expect(indexedSource.source).toBe('client-encrypted');
      expect(String(indexedSource.tags)).not.toContain(privateSessionId);
      expect(String(indexedSource.metadata)).not.toContain(privateSessionId);
      expect(String(indexedSource.metadata)).not.toContain('Private Session Title 7DF2');
      expect(indexedSource.projection_session_id).toBeNull();
      const privateIndex = sqlite.prepare(`SELECT session_token, record_mac FROM memory_private_session_index WHERE memory_id = ?`)
        .get(capturedSessionIds[0]);
      expect(String(privateIndex.session_token)).not.toContain(privateSessionId);
      expect(String(privateIndex.record_mac)).not.toContain(privateSessionId);
      sqlite.prepare('UPDATE memory_private_session_index SET record_mac = ? WHERE memory_id = ?')
        .run('v1:tampered-session-index-mac', capturedSessionIds[0]);
      expect((await client.recoverCapturedSession({
        sessionId: privateSessionId, project: dataDir, user: 'trusted-memory-writer',
        query: privateSessionContent, limit: 10,
      })).evidence).toEqual([]);
      expect(sqlite.prepare(`SELECT actor_hash, resource_hash, asset_type, decision, reason
        FROM trust_audit_log WHERE resource_hash = ? AND asset_type = 'encrypted_session_index'
        ORDER BY rowid DESC LIMIT 1`).get(createHash('sha256').update(capturedSessionIds[0]).digest('hex')))
        .toEqual({
          actor_hash: createHash('sha256').update('trusted-memory-writer').digest('hex'),
          resource_hash: createHash('sha256').update(capturedSessionIds[0]).digest('hex'),
          asset_type: 'encrypted_session_index', decision: 'deny', reason: 'invalid_signature',
        });
      sqlite.prepare('UPDATE memory_private_session_index SET record_mac = ? WHERE memory_id = ?')
        .run(privateIndex.record_mac, capturedSessionIds[0]);
      const recoveredSession = await client.recoverCapturedSession({
        sessionId: privateSessionId, project: dataDir, user: 'trusted-memory-writer',
        query: 'PRIVATE_SESSION_RECOVERY_MARKER_7DF2', limit: 10,
      });
      expect(recoveredSession.evidence.map((item) => item.content)).toContain(privateSessionContent);
      const encryptedTreeSessionId = 'private-session-tree-id-5C31';
      const encryptedTreeSources = await client.captureSessionChunks([
        { ...sessionChunk, type: 'summary', session_id: encryptedTreeSessionId,
          content: 'Encrypted tree source one carries authorized project history.', timestamp: new Date(Date.now() - 2_000).toISOString() },
        { ...sessionChunk, type: 'decision', session_id: encryptedTreeSessionId,
          content: 'Encrypted tree source two records the final project decision.', timestamp: new Date().toISOString() },
      ], { project: dataDir, user: 'trusted-memory-writer' });
      expect(encryptedTreeSources).toHaveLength(2);
      const compactEncryptedTree = await client.recoverCapturedSession({
        sessionId: encryptedTreeSessionId, project: dataDir, user: 'trusted-memory-writer',
        query: 'project history decision', budgetTokens: 256, progressiveTree: true,
      });
      expect(compactEncryptedTree.tree?.sourceCount).toBe(2);
      expect(compactEncryptedTree.tree?.estimatedTokens).toBeLessThanOrEqual(compactEncryptedTree.budgetTokens);
      const expandedEncryptedTree = await client.recoverCapturedSession({
        sessionId: encryptedTreeSessionId, project: dataDir, user: 'trusted-memory-writer',
        query: 'project history decision', budgetTokens: 1_200,
        expandNodeId: compactEncryptedTree.tree!.rootId,
      });
      expect(expandedEncryptedTree.tree?.sourceCount).toBe(2);
      expect(expandedEncryptedTree.tree?.items.map((item) => item.sourceId).sort()).toEqual([...encryptedTreeSources].sort());
      expect(JSON.stringify(expandedEncryptedTree.tree)).toContain('Encrypted tree source one');
      expect(JSON.stringify(expandedEncryptedTree.tree)).toContain('Encrypted tree source two');
      const { createTeam: createSessionTeam, addTeamMember: addSessionTeamMember,
        removeTeamMember: removeSessionTeamMember, shareMemoryWithTeam: shareSessionMemory,
        unshareMemory: unshareSessionMemory } = await import('../../../db/team-adapter.js');
      const scopedSessionId = `encrypted-team-scope-${Date.now()}`;
      const scopedSessionSources = await client.captureSessionChunks([
        { ...sessionChunk, session_id: scopedSessionId, type: 'summary',
          content: 'Team alpha only encrypted session detail.', timestamp: new Date().toISOString() },
        { ...sessionChunk, session_id: scopedSessionId, type: 'decision',
          content: 'Team beta only encrypted session detail.', timestamp: new Date().toISOString() },
      ], { project: dataDir, user: 'trusted-memory-writer' });
      const scopedTeamAlpha = await createSessionTeam({ name: `Encrypted scope alpha ${Date.now()}`, ownerId: 'trusted-memory-writer' });
      const scopedTeamBeta = await createSessionTeam({ name: `Encrypted scope beta ${Date.now()}`, ownerId: 'trusted-memory-writer' });
      const scopedMember = `encrypted-scope-member-${Date.now()}`;
      await addSessionTeamMember(scopedTeamAlpha.id, scopedMember);
      await addSessionTeamMember(scopedTeamBeta.id, scopedMember);
      const scopedOwnerId = sqlite.prepare('SELECT user_id FROM memories WHERE id = ?').get(scopedSessionSources[0]).user_id;
      await shareSessionMemory(scopedSessionSources[0]!, scopedTeamAlpha.id, scopedOwnerId, 'read');
      await shareSessionMemory(scopedSessionSources[1]!, scopedTeamBeta.id, scopedOwnerId, 'read');
      const priorScopedCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
      process.env.SQUISH_TRUSTED_CALLER_ID = scopedMember;
      try {
        const scopedRecovery = await client.recoverCapturedSession({
          sessionId: scopedSessionId, project: dataDir, user: scopedMember, teamId: scopedTeamAlpha.id,
          query: 'encrypted session detail', limit: 10,
        });
        expect(scopedRecovery.evidence.map((item) => item.content)).toEqual(['Team alpha only encrypted session detail.']);
      } finally {
        if (priorScopedCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
        else process.env.SQUISH_TRUSTED_CALLER_ID = priorScopedCaller;
      }
      const encryptedTreeTeam = await createSessionTeam({ name: `Encrypted tree share ${Date.now()}`, ownerId: 'trusted-memory-writer' });
      const encryptedTreeMember = `encrypted-tree-member-${Date.now()}`;
      await addSessionTeamMember(encryptedTreeTeam.id, encryptedTreeMember);
      const encryptedTreeOwner = sqlite.prepare('SELECT user_id FROM memories WHERE id = ?').get(encryptedTreeSources[0]).user_id;
      for (const sourceId of encryptedTreeSources) {
        await shareSessionMemory(sourceId, encryptedTreeTeam.id, encryptedTreeOwner, 'read');
      }
      const priorEncryptedTreeCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
      process.env.SQUISH_TRUSTED_CALLER_ID = encryptedTreeMember;
      try {
        const sharedEncryptedTree = await client.recoverCapturedSession({
          sessionId: encryptedTreeSessionId, project: dataDir, user: encryptedTreeMember,
          teamId: encryptedTreeTeam.id, query: 'project history decision', budgetTokens: 256, progressiveTree: true,
        });
        expect(sharedEncryptedTree.tree?.sourceCount).toBe(2);
        const expandedSharedEncryptedTree = await client.recoverCapturedSession({
          sessionId: encryptedTreeSessionId, project: dataDir, user: encryptedTreeMember,
          teamId: encryptedTreeTeam.id, query: 'project history decision', budgetTokens: 1_200,
          expandNodeId: sharedEncryptedTree.tree!.rootId,
        });
        expect(expandedSharedEncryptedTree.tree?.items.map((item) => item.sourceId).sort()).toEqual([...encryptedTreeSources].sort());
        expect(await unshareSessionMemory(encryptedTreeSources[0]!, encryptedTreeTeam.id)).toBe(true);
        const partiallyRevokedTree = await client.recoverCapturedSession({
          sessionId: encryptedTreeSessionId, project: dataDir, user: encryptedTreeMember,
          teamId: encryptedTreeTeam.id, query: 'project history decision', budgetTokens: 256, progressiveTree: true,
        });
        expect(partiallyRevokedTree.tree?.sourceCount).toBe(1);
        expect(partiallyRevokedTree.tree?.items.some((item) => item.sourceId === encryptedTreeSources[0])).toBe(false);
        expect(await unshareSessionMemory(encryptedTreeSources[1]!, encryptedTreeTeam.id)).toBe(true);
        const fullyRevokedTree = await client.recoverCapturedSession({
          sessionId: encryptedTreeSessionId, project: dataDir, user: encryptedTreeMember,
          teamId: encryptedTreeTeam.id, query: 'project history decision', budgetTokens: 256, progressiveTree: true,
        });
        expect(fullyRevokedTree.tree).toBeUndefined();
        expect(await removeSessionTeamMember(encryptedTreeTeam.id, encryptedTreeMember)).toBe(true);
      } finally {
        if (priorEncryptedTreeCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
        else process.env.SQUISH_TRUSTED_CALLER_ID = priorEncryptedTreeCaller;
      }
      const privateSessionTeam = await createSessionTeam({ name: `Encrypted session share ${Date.now()}`, ownerId: 'trusted-memory-writer' });
      const privateSessionMember = `encrypted-session-member-${Date.now()}`;
      await addSessionTeamMember(privateSessionTeam.id, privateSessionMember);
      const indexedOwner = sqlite.prepare('SELECT user_id FROM memories WHERE id = ?').get(capturedSessionIds[0]).user_id;
      await shareSessionMemory(capturedSessionIds[0], privateSessionTeam.id, indexedOwner, 'read');
      const priorTeamSessionCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
      process.env.SQUISH_TRUSTED_CALLER_ID = privateSessionMember;
      try {
        const sharedRecovery = await client.recoverCapturedSession({
          sessionId: privateSessionId, project: dataDir, user: privateSessionMember, teamId: privateSessionTeam.id,
          query: privateSessionContent, limit: 10,
        });
        expect(sharedRecovery.evidence.map((item) => item.content)).toContain(privateSessionContent);
        expect(await unshareSessionMemory(capturedSessionIds[0], privateSessionTeam.id)).toBe(true);
        const revokedRecovery = await client.recoverCapturedSession({
          sessionId: privateSessionId, project: dataDir, user: privateSessionMember, teamId: privateSessionTeam.id,
          query: privateSessionContent, limit: 10,
        });
        expect(revokedRecovery.evidence).toEqual([]);
      } finally {
        if (priorTeamSessionCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
        else process.env.SQUISH_TRUSTED_CALLER_ID = priorTeamSessionCaller;
      }
      const validSessionPassphrase = process.env.SQUISH_ENCRYPTION_PASSPHRASE;
      try {
        process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'incorrect-session-index-passphrase';
        expect((await client.recoverCapturedSession({
          sessionId: privateSessionId, project: dataDir, user: 'trusted-memory-writer',
          query: privateSessionContent, limit: 10,
        })).evidence).toEqual([]);
      } finally {
        if (validSessionPassphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
        else process.env.SQUISH_ENCRYPTION_PASSPHRASE = validSessionPassphrase;
      }
      const boundSessionCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
      process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-encrypted-session-stranger';
      try {
        expect((await client.recoverCapturedSession({
          sessionId: privateSessionId, project: dataDir, user: 'strict-encrypted-session-stranger',
          query: privateSessionContent, limit: 10,
        })).evidence).toEqual([]);
      } finally {
        if (boundSessionCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
        else process.env.SQUISH_TRUSTED_CALLER_ID = boundSessionCaller;
      }
      expect(await client.captureSessionChunks([sessionChunk], { project: dataDir, user: 'trusted-memory-writer' }))
        .toEqual(capturedSessionIds);
      expect(await client.forgetCapturedSession(privateSessionId, { project: dataDir, user: 'trusted-memory-writer' }))
        .toEqual({ deleted: 1 });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_private_session_index WHERE memory_id = ?')
        .get(capturedSessionIds[0]).count).toBe(0);
      expect((await client.recoverCapturedSession({
        sessionId: privateSessionId, project: dataDir, user: 'trusted-memory-writer',
        query: privateSessionContent, limit: 10,
      })).evidence).toEqual([]);
      await client.pinMemory(memory.id);
      const { getPinnedMemoriesForContext } = await import('../../../core/security/governance.js');
      expect(await getPinnedMemoriesForContext(undefined, 'trusted-memory-writer'))
        .toContain(`[Pinned] ${content}`);
      expect(sqlite.prepare('SELECT content, is_encrypted FROM memories WHERE id = ?').get(memory.id))
        .toEqual({ content: '', is_encrypted: 1 });
      await client.unpinMemory(memory.id);

      const caller = process.env.SQUISH_TRUSTED_CALLER_ID;
      const validPassphrase = process.env.SQUISH_ENCRYPTION_PASSPHRASE;
      const deniedReadsBefore = sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'memory' AND decision = 'deny' AND reason = 'private_default'").get().count;
      try {
        process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-encrypted-read-stranger';
        process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'incorrect-test-passphrase';
        expect(await client.getById(memory.id)).toBeNull();
        expect(await client.getMemoriesByIds([memory.id])).toEqual([]);
        await expect(createKnowledge({
          sourceMemoryId: memory.id,
          projectId: source.project_id as string | undefined,
          knowledgeKind: 'memory',
          knowledgeType: 'fact',
          content: 'untrusted encrypted projection attempt',
          ownerId: source.user_id as string,
          metadata: { sourceMemoryId: memory.id, encrypted: true },
        })).rejects.toThrow('not readable by the authenticated principal');
        await expect(client.pinMemory(memory.id)).rejects.toThrow('persisted caller identity');
        const deniedReadsAfter = sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'memory' AND decision = 'deny' AND reason = 'private_default'").get().count;
        expect(deniedReadsAfter).toBe(deniedReadsBefore + 4);
      } finally {
        if (caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
        else process.env.SQUISH_TRUSTED_CALLER_ID = caller;
        if (validPassphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
        else process.env.SQUISH_ENCRYPTION_PASSPHRASE = validPassphrase;
      }

      const sharedCaller = 'strict-encrypted-read-team-member';
      const sharedTeam = 'strict-encrypted-read-team';
      const schema = await (await import('../../../db/schema.js')).getSchema();
      await db.insert(schema.users).values({ id: sharedCaller });
      await db.insert(schema.teams).values({ id: sharedTeam, name: 'Encrypted read team', slug: sharedTeam });
      await db.insert(schema.team_members).values({
        id: 'strict-encrypted-read-membership', teamId: sharedTeam, userId: sharedCaller, role: 'member',
      });
      const { shareMemoryWithTeam } = await import('../../../db/team-adapter.js');
      await shareMemoryWithTeam(memory.id, sharedTeam, source.user_id as string, 'read');
      try {
        process.env.SQUISH_TRUSTED_CALLER_ID = sharedCaller;
        expect((await client.getById(memory.id))?.content).toBe(content);
      } finally {
        if (caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
        else process.env.SQUISH_TRUSTED_CALLER_ID = caller;
      }

      const encryptedCount = sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE is_encrypted = 1').get().count;
      const denialCount = sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'memory' AND decision = 'deny' AND reason = 'strict_surface'").get().count;
      delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      await expect(rememberMemory({ content: 'Unsigned encrypted marker 1KJ9', type: 'fact' }))
        .rejects.toThrow('requires SQUISH_PROVENANCE_PRIVATE_KEY');
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE is_encrypted = 1').get().count).toBe(encryptedCount);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'memory' AND decision = 'deny' AND reason = 'strict_surface'").get().count).toBe(denialCount + 1);
    } finally {
      if (previousEncryptionEnabled === undefined) delete process.env.SQUISH_ENCRYPTION_ENABLED;
      else process.env.SQUISH_ENCRYPTION_ENABLED = previousEncryptionEnabled;
      if (previousEncryptionPassphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
      else process.env.SQUISH_ENCRYPTION_PASSPHRASE = previousEncryptionPassphrase;
      if (previousProvenancePrivateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previousProvenancePrivateKey;
    }
  });

  it('withholds unscoped derived side effects from strict signed captures', async () => {
    process.env.SQUISH_GRAPH_AUTO_BUILD = 'true';
    process.env.SQUISH_LLM_ENABLED = 'true';
    process.env.SQUISH_GEOMETRY_AUTO_CONSOLIDATE = 'true';
    process.env.SQUISH_WRITE_DEDUP = 'link';
    const { eventBus } = await import('../../../core/event-bus.js');
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.on((event) => events.push(event));
    const db = await getDb();
    const sqlite = (db as { $client: {
      prepare: (sql: string) => { get: (...args: string[]) => { count: number } };
    } }).$client;
    const before = sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE edge_type NOT IN ('placed_in', 'located_in') AND from_kind != 'knowledge'").get().count;
    const placeEdgesBefore = sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE from_kind = 'knowledge' AND to_kind = 'place'").get().count;
    const placeDenialsBefore = sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'place' AND reason = 'strict_surface'").get().count;
    const memoryTagsBefore = sqlite.prepare('SELECT COUNT(*) AS count FROM memory_tags').get().count;
    let strictMemoryId = '';
    try {
      const memory = await rememberMemory({
        content: 'Strict procedure outcome must remain an isolated signed source.',
        project: join(dataDir, 'strict-derived-effects'),
        type: 'context',
        source: 'mcp',
        tags: ['strict-private-index-marker'],
        metadata: {
          sourceId: 'strict-derived-source',
          procedureOutcome: { procedureKey: 'strict-derived-procedure', result: 'success', evidenceId: 'strict-derived-evidence' },
        },
      });
      strictMemoryId = memory.id;
      expect(memory.id).toBeTruthy();
      expect(config.graphAutoBuild).toBe(true);
      expect(config.consolidationGeometryAutoConsolidate).toBe(true);
      expect(config.writeDedupMode).toBe('link');
    } finally {
      unsubscribe();
      for (const key of ['SQUISH_GRAPH_AUTO_BUILD', 'SQUISH_LLM_ENABLED', 'SQUISH_GEOMETRY_AUTO_CONSOLIDATE', 'SQUISH_WRITE_DEDUP']) {
        const value = savedEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE edge_type NOT IN ('placed_in', 'located_in') AND from_kind != 'knowledge'").get().count).toBe(before);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE from_kind = 'knowledge' AND to_kind = 'place'").get().count).toBe(placeEdgesBefore);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'place' AND reason = 'strict_surface'").get().count).toBe(placeDenialsBefore);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_tags').get().count).toBe(memoryTagsBefore);
    expect(events.filter((event) => event.type === 'memory:stored')).toHaveLength(0);
    expect(events.some((event) => JSON.stringify(event.payload).includes('Strict procedure outcome'))).toBe(false);

    const { storeMemoryTags } = await import('../../../core/places/memory-places.js');
    await expect(storeMemoryTags(strictMemoryId, ['direct-private-index-marker']))
      .rejects.toThrow('Memory tag indexes are disabled under strict trust');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_tags WHERE memory_id = ?').get(strictMemoryId).count).toBe(0);
    const memoryTagAudit = sqlite.prepare(`SELECT actor_hash, resource_hash, decision, reason
      FROM trust_audit_log WHERE asset_type = 'memory_tag' ORDER BY rowid DESC LIMIT 1`).get() as {
      actor_hash: string; resource_hash: string; decision: string; reason: string;
    };
    expect(memoryTagAudit).toMatchObject({
      actor_hash: createHash('sha256').update('trusted-memory-writer').digest('hex'),
      resource_hash: createHash('sha256').update(strictMemoryId).digest('hex'),
      decision: 'deny',
      reason: 'strict_surface',
    });
  });

  it('stores strict encrypted team memories as ciphertext and authorizes members before decrypting', { timeout: 30000 }, async () => {
    const previousEncryptionEnabled = process.env.SQUISH_ENCRYPTION_ENABLED;
    const previousEncryptionPassphrase = process.env.SQUISH_ENCRYPTION_PASSPHRASE;
    process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'strict-encrypted-team-test-passphrase';
    try {
      const { createTeam, addTeamMember } = await import('../../../db/team-adapter.js');
      const team = await createTeam({ name: 'Encrypted strict team', ownerId: 'trusted-memory-writer' });
      const memberId = `strict-encrypted-member-${Date.now()}`;
      await addTeamMember(team.id, memberId);
      const content = `Encrypted team source ${Date.now()}`;
      const memory = await rememberMemory({ content, type: 'fact', teamId: team.id });
      const db = await getDb();
      const sqlite = (db as { $client: { prepare: (sql: string) => { get: (id: string) => Record<string, unknown> } } }).$client;
      const row = sqlite.prepare(`SELECT content, encrypted_content, encryption_nonce, is_encrypted,
        project_id, type, user_id, team_id, metadata FROM memories WHERE id = ?`).get(memory.id);
      expect(row.content).toBe('');
      expect(row.encrypted_content).toBeTruthy();
      expect(row.encryption_nonce).toBeTruthy();
      expect(row.is_encrypted).toBe(1);
      expect(row.team_id).toBe(team.id);
      expect(row.metadata).not.toContain(content);
      expect(verifyMemoryProvenance({
        content,
        projectId: row.project_id as string | null,
        type: row.type as string,
        ownerId: row.user_id as string,
        teamId: row.team_id as string,
        sourceMemoryId: memory.id,
        metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
      })).toBe(true);

      const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
      const client = new SquishRuntime({ dataDir });
      expect((await client.getById(memory.id))?.content).toBe(content);
      await client.pinMemory(memory.id);
      const { getPinnedMemories, getPinnedMemoriesForContext } = await import('../../../core/security/governance.js');
      expect(await getPinnedMemoriesForContext(undefined, 'trusted-memory-writer'))
        .toContain(`[Pinned] ${content}`);
      const { removeVisibilityRule, setVisibilityRule: addVisibilityRule } = await import('../../../core/loadout/loadout.js');
      await addVisibilityRule({
        assetType: 'memory', assetId: memory.id, ruleType: 'allow',
        granteeType: 'team', granteeId: team.id, permission: 'admin',
      });
      expect((await getPinnedMemories()).some((row) => row.id === memory.id)).toBe(false);
      await removeVisibilityRule('memory', memory.id, 'team', team.id);
      const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
      process.env.SQUISH_TRUSTED_CALLER_ID = memberId;
      try {
        expect((await client.getById(memory.id))?.content).toBe(content);
        expect((await client.getMemoriesByIds([memory.id])).map((item) => item.content)).toEqual([content]);
        expect(await getPinnedMemoriesForContext(undefined, memberId)).toContain(`[Pinned] ${content}`);
        await expect(client.pinMemory(memory.id)).rejects.toThrow('owner or admin role');
        expect(sqlite.prepare('SELECT is_pinned FROM memories WHERE id = ?').get(memory.id).is_pinned).toBe(1);
      } finally {
        if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
        else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
      }
      await client.unpinMemory(memory.id);
    } finally {
      if (previousEncryptionEnabled === undefined) delete process.env.SQUISH_ENCRYPTION_ENABLED;
      else process.env.SQUISH_ENCRYPTION_ENABLED = previousEncryptionEnabled;
      if (previousEncryptionPassphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
      else process.env.SQUISH_ENCRYPTION_PASSPHRASE = previousEncryptionPassphrase;
    }
  });

  it('does not borrow a team owner role from an email-colliding SQLite principal during pinning', async () => {
    const { createTeam } = await import('../../../db/team-adapter.js');
    const teamOwnerIdentity = 'pin-collision-team-owner';
    const callerIdentity = 'pin-collision-caller@example.test';
    const team = await createTeam({ name: 'Pin identity collision', ownerId: teamOwnerIdentity });
    const db = await getDb();
    const sqlite = (db as any).$client;
    const owner = sqlite.prepare('SELECT id FROM users WHERE external_id=?').get(teamOwnerIdentity) as { id: string };
    sqlite.prepare('UPDATE users SET email=? WHERE id=?').run(callerIdentity, owner.id);
    sqlite.prepare('INSERT INTO users (id, external_id, email) VALUES (?, ?, ?)')
      .run('pin-collision-caller', callerIdentity, 'pin-collision-caller-real@example.test');

    const legacyResolution = sqlite.prepare('SELECT id FROM users WHERE id=? OR external_id=? OR email=? LIMIT 1')
      .get(callerIdentity, callerIdentity, callerIdentity) as { id: string };
    expect(legacyResolution.id).toBe(owner.id);

    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUSTED_CALLER_ID = teamOwnerIdentity;
    let memoryId: string;
    try {
      const memory = await rememberMemory({
        content: 'Only the existing team owner may pin this memory', type: 'fact', teamId: team.id,
      });
      memoryId = memory.id;
    } finally {
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }

    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const client = new SquishRuntime({ dataDir });
    process.env.SQUISH_TRUSTED_CALLER_ID = callerIdentity;
    try {
      await expect(client.pinMemory(memoryId)).rejects.toThrow('owner or admin role');
      expect(sqlite.prepare('SELECT is_pinned FROM memories WHERE id=?').get(memoryId).is_pinned).toBe(0);
    } finally {
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('blocks direct unsigned memory projection writes at the knowledge CRUD boundary', async () => {
    await expect(createKnowledge({
      projectId: undefined,
      knowledgeKind: 'memory',
      knowledgeType: 'fact',
      content: 'unsigned projection bypass attempt',
      metadata: {},
    })).rejects.toThrow('Strict trust requires source-linked memory projections');
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: () => { count: number } } } }).$client;
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge WHERE content = 'unsigned projection bypass attempt'").get().count).toBe(0);
  });

  it('blocks a caller from deriving a projection from an unreadable plaintext source', async () => {
    const sourceContent = 'Private source for strict projection authorization';
    const memory = await rememberMemory({ content: sourceContent, type: 'fact' });
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: (...params: string[]) => { user_id: string | null; team_id: string | null; project_id: string | null; count?: number } } } }).$client;
    const source = sqlite.prepare('SELECT user_id, team_id, project_id FROM memories WHERE id = ?').get(memory.id)!;
    const projectionCount = () => sqlite.prepare(
      `SELECT COUNT(*) AS count FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') = ?`,
    ).get(memory.id)!.count;
    const before = projectionCount();
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUSTED_CALLER_ID = 'unrelated-projection-caller';
    try {
      await expect(createKnowledge({
        sourceMemoryId: memory.id,
        projectId: source.project_id ?? undefined,
        knowledgeKind: 'memory',
        knowledgeType: 'fact',
        content: sourceContent,
        ownerId: source.user_id ?? undefined,
        metadata: { sourceMemoryId: memory.id },
      })).rejects.toThrow('Source memory is not readable by the authenticated principal');
    } finally {
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
    expect(projectionCount()).toBe(before);
  });

  it('authorizes encrypted projection sources before decryption when an executor is supplied', async () => {
    const previousEncryptionEnabled = process.env.SQUISH_ENCRYPTION_ENABLED;
    const previousEncryptionPassphrase = process.env.SQUISH_ENCRYPTION_PASSPHRASE;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'strict-executor-projection-test-passphrase';
    try {
      const content = 'Encrypted source cannot be projected through an executor by another caller';
      const memory = await rememberMemory({ content, type: 'fact' });
      const db = await getDb();
      const sqlite = (db as { $client: { prepare: (sql: string) => { get: (...args: string[]) => Record<string, unknown> } } }).$client;
      const source = sqlite.prepare('SELECT user_id, project_id FROM memories WHERE id = ?').get(memory.id) as {
        user_id: string; project_id: string | null;
      };
      const projectionCount = () => sqlite.prepare(
        `SELECT COUNT(*) AS count FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') = ?`,
      ).get(memory.id)!.count as number;
      const before = projectionCount();
      const deniedAuditCount = () => sqlite.prepare(
        "SELECT COUNT(*) AS count FROM trust_audit_log WHERE decision='deny' AND reason='private_default'",
      ).get()!.count as number;
      const auditsBefore = deniedAuditCount();
      await db.transaction(async (tx) => {
        await createKnowledge({
          sourceMemoryId: memory.id,
          projectId: source.project_id ?? undefined,
          knowledgeKind: 'memory',
          knowledgeType: 'fact',
          content,
          ownerId: source.user_id,
          metadata: { sourceMemoryId: memory.id, encrypted: true },
        }, tx);
      });
      expect(projectionCount()).toBe(before + 1);
      const beforeDeniedAttempt = projectionCount();
      process.env.SQUISH_TRUSTED_CALLER_ID = 'unrelated-encrypted-executor-caller';
      process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'incorrect-passphrase-must-not-be-used';

      await db.transaction(async (tx) => {
        await expect(createKnowledge({
          sourceMemoryId: memory.id,
          projectId: source.project_id ?? undefined,
          knowledgeKind: 'memory',
          knowledgeType: 'fact',
          content,
          ownerId: source.user_id,
          metadata: { sourceMemoryId: memory.id, encrypted: true },
        }, tx)).rejects.toThrow('not readable by the authenticated principal');
      });
      expect(projectionCount()).toBe(beforeDeniedAttempt);
      expect(deniedAuditCount()).toBe(auditsBefore + 1);
    } finally {
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
      if (previousEncryptionEnabled === undefined) delete process.env.SQUISH_ENCRYPTION_ENABLED;
      else process.env.SQUISH_ENCRYPTION_ENABLED = previousEncryptionEnabled;
      if (previousEncryptionPassphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
      else process.env.SQUISH_ENCRYPTION_PASSPHRASE = previousEncryptionPassphrase;
    }
  });

  it('denies generic direct knowledge-edge creation and hashes its audit identifiers', async () => {
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: (...params: string[]) => Record<string, unknown> } } }).$client;
    const before = sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges').get() as { count: number };
    const sourceId = 'unscoped-edge-source';

    await expect(createKnowledgeEdge({
      fromId: sourceId,
      fromKind: 'knowledge',
      toId: 'unscoped-edge-target',
      toKind: 'knowledge',
      edgeType: 'supports',
    })).rejects.toThrow('Source-backed graph-edge creation is not authorized under strict trust');

    const after = sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges').get() as { count: number };
    expect(after.count).toBe(before.count);
    const audit = sqlite.prepare(`SELECT actor_hash, resource_hash, decision, reason
      FROM trust_audit_log WHERE asset_type = 'knowledge_edge' AND reason = 'unsigned_legacy'
      ORDER BY created_at DESC LIMIT 1`).get() as { actor_hash: string; resource_hash: string; decision: string; reason: string };
    expect(audit).toMatchObject({
      actor_hash: createHash('sha256').update('trusted-memory-writer').digest('hex'),
      decision: 'deny',
      reason: 'unsigned_legacy',
    });
    expect(audit.resource_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.resource_hash).not.toBe(sourceId);
    expect(audit.resource_hash).not.toBe('unscoped-edge-target');
  });

  it('rolls back source memory and analysis job when canonical projection creation fails', async () => {
    const db = await getDb();
    const sqlite = (db as { $client: {
      exec: (sql: string) => void;
      prepare: (sql: string) => { get: () => { count: number } };
    } }).$client;
    sqlite.exec(`CREATE TRIGGER fail_test_memory_projection BEFORE INSERT ON knowledge
      WHEN NEW.content = 'projection rollback test'
      BEGIN SELECT RAISE(ABORT, 'projection failure regression'); END`);
    const jobsBefore = sqlite.prepare('SELECT COUNT(*) AS count FROM memory_analysis_jobs').get().count;
    try {
      await expect(rememberMemory({
        content: 'projection rollback test',
        project: '/strict-projection-rollback',
        type: 'fact',
      })).rejects.toThrow('projection failure regression');
    } finally {
      sqlite.exec('DROP TRIGGER fail_test_memory_projection');
    }
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memories WHERE content = 'projection rollback test'").get().count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge WHERE content = 'projection rollback test'").get().count).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_analysis_jobs').get().count).toBe(jobsBefore);
  });

  it('withholds unscoped feedback writes and reads under strict trust', async () => {
    const memory = await rememberMemory({ content: 'strict feedback cannot change this memory', type: 'fact' });
    const db = await getDb();
    const sqlite = (db as { $client: {
      prepare: (sql: string) => { get: (id: string) => { retrieval_priority: number | null } | undefined; all: (id: string) => unknown[] };
    } }).$client;
    const before = sqlite.prepare('SELECT retrieval_priority FROM memories WHERE id = ?').get(memory.id)!;
    await recordInjection('session-reused-cross-agent', [memory.id], new Map([[memory.id, memory.content]]));
    await analyzeAndRecordFeedback('session-reused-cross-agent', `I used ${memory.content}`);
    await updateRetrievalPriority(memory.id, 50);
    const after = sqlite.prepare('SELECT retrieval_priority FROM memories WHERE id = ?').get(memory.id)!;
    expect(after.retrieval_priority).toBe(before.retrieval_priority);
    expect(sqlite.prepare('SELECT id FROM memory_feedback WHERE memory_id = ?').all(memory.id)).toHaveLength(0);
    await expect(getMemoryFeedbackStats(memory.id)).rejects.toThrow('caller-scoped provenance');
  });

  it('binds strict session working sets to the persisted owner and rejects another owner', async () => {
    const projectPath = join(dataDir, 'session-scope-project');
    await recordSessionSignal({
      sessionId: 'shared-session-id', projectPath, classification: 'session-only',
      distilledContent: 'private hypothesis belongs to trusted owner', toolName: 'test',
    });
    expect((await getSessionWorkingSet('shared-session-id', projectPath)).currentHypotheses).toHaveLength(1);

    process.env.SQUISH_TRUSTED_CALLER_ID = 'different-session-caller';
    await expect(getSessionWorkingSet('shared-session-id', projectPath)).rejects.toThrow('outside its persisted owner');
    await expect(recordSessionSignal({
      sessionId: 'shared-session-id', projectPath, classification: 'session-only',
      distilledContent: 'attacker overwrite attempt', toolName: 'test',
    })).rejects.toThrow('owned by another principal');
    process.env.SQUISH_TRUSTED_CALLER_ID = 'trusted-memory-writer';

    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: (id: string) => { user_id: string } } } }).$client;
    const owner = sqlite.prepare('SELECT user_id FROM context_sessions WHERE session_id = ?').get('shared-session-id');
    expect(owner.user_id).toBeTruthy();
  });

  it('requires project scope when reading a strict session working set', { timeout: 30000 }, async () => {
    const projectPath = join(dataDir, 'session-required-project');
    await recordSessionSignal({
      sessionId: 'strict-session-requires-project', projectPath, classification: 'session-only',
      distilledContent: 'project-bound private working-set marker', toolName: 'test',
    });

    await expect(getSessionWorkingSet('strict-session-requires-project'))
      .rejects.toThrow('project scope');
    await expect(getSessionWorkingSet('strict-session-requires-project', join(dataDir, 'unknown-project')))
      .rejects.toThrow('project scope');
    await expect(getSessionWorkingSet('strict-session-requires-project', projectPath))
      .resolves.toMatchObject({ recentAttempts: ['project-bound private working-set marker'] });
  });

  it('strict session writes require a project before creating session state', async () => {
    await expect(recordSessionSignal({
      sessionId: 'unscoped-session-write', projectPath: '', classification: 'session-only',
      distilledContent: 'must not be retained without project scope', toolName: 'test',
    })).rejects.toThrow('requires project scope');
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: (id: string) => { count: number; content?: string } } } }).$client;
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM context_sessions WHERE session_id = ?').get('unscoped-session-write').count).toBe(0);
  });

  it('withholds process-local retrieval feedback under strict trust', async () => {
    recordFeedback('guessed-memory-id', 'private query', { sessionId: 'reused-feedback-session' });
    recordUsefulRetrieval('guessed-memory-id', 'private query', { sessionId: 'reused-feedback-session', cited: true });
    await recordCitation('guessed-memory-id', 'private-response', { sessionId: 'reused-feedback-session' });
    expect(getRetrievalStats('guessed-memory-id').totalRetrievals).toBe(0);
    expect(getOverallFeedbackStats().totalRetrievals).toBe(0);
    expect(await flushFeedback()).toEqual({ strengthened: 0, weakened: 0, total: 0 });
  });

  it('allows audited owner pin transitions and denies unrelated strict governance mutations', async () => {
    const first = await rememberMemory({ content: 'strict mutation source', type: 'fact' });
    const second = await rememberMemory({ content: 'strict mutation target', type: 'fact' });
    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const client = new SquishRuntime({ dataDir });
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: (...args: string[]) => Record<string, unknown> | undefined; all: (...args: string[]) => Array<Record<string, unknown>>; run: (...args: unknown[]) => { changes: number } }; exec: (sql: string) => void } }).$client;
    const before = sqlite.prepare('SELECT is_pinned, tier FROM memories WHERE id = ?').get(first.id)!;

    await client.pinMemory(first.id);
    expect(sqlite.prepare('SELECT is_pinned, importance_score FROM memories WHERE id = ?').get(first.id)).toMatchObject({ is_pinned: 1, importance_score: 100 });
    await client.unpinMemory(first.id);
    expect(sqlite.prepare('SELECT is_pinned FROM memories WHERE id = ?').get(first.id)?.is_pinned).toBe(0);
    const audits = sqlite.prepare("SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log WHERE asset_type = 'memory' AND reason IN ('memory_pin', 'memory_unpin') ORDER BY rowid DESC LIMIT 2").all();
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit.actor_hash).toBe(createHash('sha256').update('trusted-memory-writer').digest('hex'));
      expect(audit.resource_hash).toBe(createHash('sha256').update(first.id).digest('hex'));
    }
    const denialCount = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE decision = 'deny'").get()?.count);
    process.env.SQUISH_TRUSTED_CALLER_ID = 'different-pin-caller';
    try {
      await expect(client.pinMemory(first.id)).rejects.toThrow('persisted caller identity');
    } finally {
      process.env.SQUISH_TRUSTED_CALLER_ID = 'trusted-memory-writer';
    }
    expect(Number(sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE decision = 'deny'").get()?.count)).toBe(denialCount + 1);

    const hidden = await rememberMemory({ content: 'strict hidden pin target', type: 'fact' });
    await setVisibilityRule({ assetType: 'memory', assetId: hidden.id, ruleType: 'share', granteeType: 'user', granteeId: 'someone-else', permission: 'read' });
    await expect(client.pinMemory(hidden.id)).rejects.toThrow('not visible to the authenticated principal');
    const unsigned = await rememberMemory({ content: 'strict tampered pin target', type: 'fact' });
    sqlite.prepare('UPDATE memories SET content = ? WHERE id = ?').run('tampered pin content', unsigned.id);
    await expect(client.pinMemory(unsigned.id)).rejects.toThrow('valid signed provenance');
    const archived = await rememberMemory({ content: 'strict archived pin target', type: 'fact' });
    sqlite.prepare("UPDATE memories SET status = 'archived', is_active = 0 WHERE id = ?").run(archived.id);
    await expect(client.pinMemory(archived.id)).rejects.toThrow('active, unexpired personal memory');

    sqlite.exec(`CREATE TRIGGER fail_pin_audit BEFORE INSERT ON trust_audit_log
      WHEN NEW.reason = 'memory_pin' BEGIN SELECT RAISE(ABORT, 'injected pin audit failure'); END`);
    try {
      await expect(client.pinMemory(second.id)).rejects.toThrow('injected pin audit failure');
    } finally {
      sqlite.exec('DROP TRIGGER fail_pin_audit');
    }
    expect(sqlite.prepare('SELECT is_pinned FROM memories WHERE id = ?').get(second.id)?.is_pinned).toBe(0);

    await expect(client.promoteToSturdy(first.id)).rejects.toThrow('disabled under strict trust');
    await expect(client.createAssociation(first.id, second.id, 'relates_to')).rejects.toThrow('disabled under strict trust');

    const after = sqlite.prepare('SELECT is_pinned, tier FROM memories WHERE id = ?').get(first.id)!;
    expect(after.is_pinned).toBe(before.is_pinned);
    expect(after.tier).toBe(before.tier);
    const edgeCount = sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE from_id = (SELECT id FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') = ?) AND to_id = (SELECT id FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') = ?)").get(first.id, second.id) as { count: number };
    expect(edgeCount.count).toBe(0);
  });

  it('prefilters strict pinned context by owner and ACL before its candidate limit', async () => {
    const ownerPin = await rememberMemory({ content: 'owner pin survives inaccessible pinned candidates', type: 'fact' });
    const { pinMemory, getPinnedMemoriesForContext } = await import('../../../core/security/governance.js');
    await pinMemory(ownerPin.id);
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client;
    for (let index = 0; index < 60; index += 1) {
      sqlite.prepare(`INSERT INTO memories (id, type, content, user_id, team_id, is_pinned, status, is_active,
        created_at, metadata, tokens_estimate, importance_score)
        VALUES (?, 'fact', ?, NULL, NULL, 1, 'active', 1, ?, '{}', 0, 50)`)
        .run(`pinned-hidden-${index}`, `inaccessible pinned candidate ${index}`, Math.floor(Date.now() / 1000));
    }
    const visible = await getPinnedMemoriesForContext(undefined, 'trusted-memory-writer');
    expect(visible).toContain('[Pinned] owner pin survives inaccessible pinned candidates');
  });

  it('denies strict feedback for archived or inactive memories without changing lifecycle state', { timeout: 30000 }, async () => {
    const archived = await rememberMemory({ content: 'strict feedback archived fixture', type: 'fact' });
    const inactive = await rememberMemory({ content: 'strict feedback inactive fixture', type: 'fact' });
    const expired = await rememberMemory({ content: 'strict feedback expired fixture', type: 'fact' });
    const closed = await rememberMemory({ content: 'strict feedback closed fixture', type: 'fact' });
    const future = await rememberMemory({ content: 'strict feedback future fixture', type: 'fact' });
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: (...args: string[]) => any; run: (...args: unknown[]) => unknown }; exec: (sql: string) => void } }).$client;
    sqlite.prepare("UPDATE memories SET status = 'archived', context_status = 'archived', is_active = 0 WHERE id = ?").run(archived.id);
    sqlite.prepare('UPDATE memories SET is_active = 0 WHERE id = ?').run(inactive.id);
    sqlite.prepare("UPDATE memories SET expires_at = (CAST(strftime('%s','now') AS INTEGER) - 1) * 1000 WHERE id = ?").run(expired.id);
    sqlite.prepare("UPDATE memories SET valid_to = (CAST(strftime('%s','now') AS INTEGER) - 1) * 1000 WHERE id = ?").run(closed.id);
    sqlite.prepare("UPDATE memories SET valid_from = (CAST(strftime('%s','now') AS INTEGER) + 60) * 1000 WHERE id = ?").run(future.id);
    const before = sqlite.prepare('SELECT status, is_active, expires_at, valid_from, valid_to, access_count, usage_count, confidence_level FROM memories WHERE id = ?');
    const archivedBefore = before.get(archived.id);
    const inactiveBefore = before.get(inactive.id);
    const expiredBefore = before.get(expired.id);
    const closedBefore = before.get(closed.id);
    const futureBefore = before.get(future.id);
    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const client = new SquishRuntime({ dataDir });

    await expect(client.feedback('memory', archived.id, 'used')).rejects.toThrow('not readable by the authenticated principal');
    await expect(client.feedback('memory', inactive.id, 'confirm')).rejects.toThrow('not readable by the authenticated principal');
    await expect(client.feedback('memory', expired.id, 'contradict')).rejects.toThrow('not readable by the authenticated principal');
    await expect(client.feedback('memory', closed.id, 'used')).rejects.toThrow('not readable by the authenticated principal');
    await expect(client.feedback('memory', future.id, 'confirm')).rejects.toThrow('not readable by the authenticated principal');

    expect(before.get(archived.id)).toEqual(archivedBefore);
    expect(before.get(inactive.id)).toEqual(inactiveBefore);
    expect(before.get(expired.id)).toEqual(expiredBefore);
    expect(before.get(closed.id)).toEqual(closedBefore);
    expect(before.get(future.id)).toEqual(futureBefore);
    const denials = sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE decision = 'deny' AND reason = 'private_default'").get().count;
    expect(denials).toBeGreaterThanOrEqual(5);
  });

  it('audits denied strict strategy and direct feedback entrypoints without mutating memory', async () => {
    const memory = await rememberMemory({ content: 'direct strict feedback must remain unavailable', type: 'fact' });
    const strategyId = 'strict-strategy-fixture';
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown>; all: (...args: unknown[]) => Array<Record<string, unknown>>; run: (...args: unknown[]) => unknown }; exec: (sql: string) => void } }).$client;
    const beforeMemory = sqlite.prepare('SELECT usage_count, access_count, confidence_level FROM memories WHERE id = ?').get(memory.id);
    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const client = new SquishRuntime({ dataDir });
    sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, confidence, usage_count, success_count, failure_count, status, is_active, metadata, created_at, updated_at)
      VALUES (?, 'strategy', 'procedure', ?, 0.5, 0, 0, 0, 'active', 1, '{}', ?, ?)`)
      .run(strategyId, 'strict strategy feedback requires verified source lineage', Date.now(), Date.now());
    const beforeStrategy = sqlite.prepare('SELECT usage_count, success_count, failure_count, confidence FROM knowledge WHERE id = ?').get(strategyId);
    const beforeAuditCount = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE reason = 'strict_surface'").get().count);

    await expect(client.feedback('strategy', strategyId, 'used'))
      .rejects.toThrow('Strict strategy feedback requires signed single-source lineage');
    await expect(applyFeedback({ targetType: 'memory', id: memory.id, signal: 'used' }))
      .rejects.toThrow('Direct feedback application is disabled under strict trust');

    expect(sqlite.prepare('SELECT usage_count, access_count, confidence_level FROM memories WHERE id = ?').get(memory.id)).toEqual(beforeMemory);
    expect(sqlite.prepare('SELECT usage_count, success_count, failure_count, confidence FROM knowledge WHERE id = ?').get(strategyId)).toEqual(beforeStrategy);
    expect(Number(sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE reason = 'strict_surface'").get().count)).toBe(beforeAuditCount + 2);
    const expectedActorHash = createHash('sha256').update('trusted-memory-writer').digest('hex');
    const strategyHash = createHash('sha256').update(strategyId).digest('hex');
    const strategyAudit = sqlite.prepare("SELECT actor_hash, resource_hash, asset_type, decision, reason FROM trust_audit_log WHERE reason = 'strict_surface' AND resource_hash = ?").get(strategyHash);
    expect(strategyAudit).toEqual({ actor_hash: expectedActorHash, resource_hash: strategyHash, asset_type: 'knowledge', decision: 'deny', reason: 'strict_surface' });
    expect(JSON.stringify(strategyAudit)).not.toContain(strategyId);

    const memoryHash = createHash('sha256').update(memory.id).digest('hex');
    const memoryAudits = sqlite.prepare("SELECT actor_hash, resource_hash, asset_type, decision FROM trust_audit_log WHERE reason = 'strict_surface' AND resource_hash = ? ORDER BY rowid DESC LIMIT 2").all(memoryHash);
    expect(memoryAudits).toHaveLength(1);
    expect(memoryAudits.every((row) => row.actor_hash === expectedActorHash && row.resource_hash === memoryHash && row.asset_type === 'memory' && row.decision === 'deny')).toBe(true);
    expect(JSON.stringify(memoryAudits)).not.toContain(memory.id);

    sqlite.exec(`CREATE TRIGGER reject_strategy_denial_audit BEFORE INSERT ON trust_audit_log
      WHEN NEW.resource_hash = '${strategyHash}'
      BEGIN SELECT RAISE(ABORT, 'strategy denial audit failure regression'); END;`);
    try {
      await expect(client.feedback('strategy', strategyId, 'contradict'))
        .rejects.toThrow('Strict strategy feedback is denied and its audit record could not be persisted');
    } finally {
      sqlite.exec('DROP TRIGGER reject_strategy_denial_audit');
    }
    expect(sqlite.prepare('SELECT usage_count, success_count, failure_count, confidence FROM knowledge WHERE id = ?').get(strategyId)).toEqual(beforeStrategy);
  });
  it('fails closed on SDK edit, graph, project, place, and raw session surfaces under strict trust', async () => {
    const memory = await rememberMemory({ content: 'strict unavailable SDK surfaces', type: 'fact' });
    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const client = new SquishRuntime({ dataDir });
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: (id: string) => { count: number } } } }).$client;
    const projectsBefore = sqlite.prepare('SELECT COUNT(*) AS count FROM projects').get('').count;

    await expect(client.createEditProposal({ memoryId: memory.id, proposedContent: 'forged', reason: 'test' })).rejects.toThrow('disabled under strict trust');
    await expect(client.listEditProposals()).rejects.toThrow('disabled under strict trust');
    await expect(client.previewEditProposal('proposal-id')).rejects.toThrow('disabled under strict trust');
    await expect(client.approveEditProposal('proposal-id')).rejects.toThrow('disabled under strict trust');
    await expect(client.rejectEditProposal('proposal-id')).rejects.toThrow('disabled under strict trust');
    const correction = await client.correctMemory(memory.id, 'owner-authorized correction', 'owner review');
    expect(correction).toMatchObject({ ok: true, priorContent: 'strict unavailable SDK surfaces' });
    expect(sqlite.prepare('SELECT content FROM memories WHERE id=?').get(memory.id).content).toBe('owner-authorized correction');
    await expect(client.stalenessReport()).rejects.toThrow('disabled under strict trust');
    await expect(client.buildGraph(dataDir)).rejects.toThrow('disabled under strict trust');
    await expect(client.getRelatedMemories(memory.id, { userId: 'trusted-memory-writer' })).rejects.toThrow('Unscoped memory-association reads are disabled');
    const { getRelatedMemories } = await import('../../../core/associations.js');
    await expect(getRelatedMemories(memory.id)).rejects.toThrow('Unscoped memory-association reads are disabled');
    await expect(client.getPlaces(dataDir)).rejects.toThrow('disabled under strict trust');
    await expect(client.listSessions()).rejects.toThrow('disabled under strict trust');
    await expect(client.getSessionChunks('guessed-session')).rejects.toThrow('disabled under strict trust');
    await expect(client.getSession('guessed-session')).rejects.toThrow('disabled under strict trust');
    await expect(client.searchChunks('private session')).rejects.toThrow('disabled under strict trust');
    const { captureChunk } = await import('../../../core/sessions/index.js');
    const capturedSessionId = 'strict-sdk-forget-captured-session';
    const capturedMemoryId = await captureChunk({
      type: 'summary',
      content: 'Owner-authorized captured episodic source for forget coverage',
      session_id: capturedSessionId,
      session_title: 'Strict forget regression',
      project: '',
      repo_path: dataDir,
      branch: 'main',
      agent: 'cli',
      agent_session_id: 'strict-sdk-forget-agent-session',
      timestamp: new Date().toISOString(),
    });
    expect(await client.forgetCapturedSession(capturedSessionId))
      .toEqual({ deleted: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id=?').get(capturedMemoryId).count).toBe(0);
    await expect(client.findRelatedSessions({ repo_path: dataDir })).rejects.toThrow('disabled under strict trust');
    await expect(client.dedupScan()).rejects.toThrow('disabled under strict trust');
    await expect(client.listMergeProposals({ projectId: 'untrusted-project' })).rejects.toThrow('disabled under strict trust');
    await expect(client.previewMerge('untrusted-proposal')).rejects.toThrow('disabled under strict trust');
    await expect(client.approveMerge({ proposalId: 'untrusted-proposal' })).rejects.toThrow('disabled under strict trust');
    await expect(client.rejectMerge({ proposalId: 'untrusted-proposal' })).rejects.toThrow('disabled under strict trust');
    await expect(client.reverseMerge({ mergeHistoryId: 'untrusted-history' })).rejects.toThrow('disabled under strict trust');
    await expect(client.recoverCapturedSession({ sessionId: 'untrusted-session' })).rejects.toThrow('authenticated caller identity');
    await expect(client.feedback('memory', memory.id, 'confirm', { userId: 'someone-else' })).rejects.toThrow('does not match the authenticated principal');
    await expect(client.deleteProject('guessed-project')).rejects.toThrow('disabled under strict trust');
    await expect(client.runMaintenance({ dryRun: true })).rejects.toThrow('disabled under strict trust');
    await expect(client.fixSchemaIssues()).rejects.toThrow('disabled under strict trust');
    await expect(client.migrateMemories()).rejects.toThrow('disabled under strict trust');
    await expect(client.createLearning({ type: 'insight', content: 'unsigned learning bypass' })).rejects.toThrow('disabled under strict trust');
    await expect(client.buildStatsState()).rejects.toThrow('disabled under strict trust');
    await expect(client.resolveProjectScope()).rejects.toThrow('disabled under strict trust');
    process.env.SQUISH_DEDUP_AUTO = 'true';
    try {
      await expect(client.dedupAutoMerge()).rejects.toThrow('disabled under strict trust');
    } finally {
      delete process.env.SQUISH_DEDUP_AUTO;
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM projects').get('').count).toBe(projectsBefore);
  });

  it('keeps project context and progressive recovery bound to the strict memory owner', async () => {
    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const { captureChunk } = await import('../../../core/sessions/index.js');
    const client = new SquishRuntime({ dataDir });
    const project = join(dataDir, 'strict-recovery-owner-project');
    const privateMarker = 'STRICT_RECOVERY_OWNER_ONLY_7F3A';
    const sessionId = 'strict-project-context-owner-session';
    const originalProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    const priorCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'trusted-memory-writer';
    try {
      const privateProjectMemory = await rememberMemory({
        content: `Strict SDK owner-bound memory ${privateMarker}: preserve the verified source boundary.`,
        type: 'fact',
        project,
      });
      expect(await client.getMemoriesByIds([privateProjectMemory.id])).toHaveLength(1);
      await captureChunk({
        type: 'decision',
        content: `Episodic session detail ${privateMarker}: retain the verified source boundary.`,
        session_id: sessionId,
        session_title: 'Strict project context owner test',
        project,
        repo_path: project,
        branch: 'main',
        agent: 'cli',
        agent_session_id: 'strict-project-context-owner-agent-session',
        timestamp: new Date().toISOString(),
      }, { project, user: 'trusted-memory-writer' });

      const ownerRecovery = await client.recoverCapturedSession({
        sessionId,
        query: 'verified source boundary',
        project,
        user: 'trusted-memory-writer',
        budgetTokens: 1_200,
        progressiveTree: true,
        includeProjectContext: true,
      });
      expect(ownerRecovery.sessionId).toBe(sessionId);
      expect(ownerRecovery.tree?.sourceCount).toBe(1);
      expect(ownerRecovery.projectContext).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining(privateMarker) }),
      ]));

      process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-recovery-other-caller';
      expect(await client.getMemoriesByIds([privateProjectMemory.id])).toHaveLength(0);
      const otherRecovery = await client.recoverCapturedSession({
        sessionId,
        query: 'verified source boundary',
        project,
        user: 'strict-recovery-other-caller',
        budgetTokens: 1_200,
        progressiveTree: true,
        includeProjectContext: true,
      });
      expect(JSON.stringify(otherRecovery)).not.toContain(privateMarker);
      expect(otherRecovery.evidence).toHaveLength(0);
      expect(otherRecovery.projectContext ?? []).toHaveLength(0);
      expect(otherRecovery.tree).toBeUndefined();
    } finally {
      if (originalProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = originalProvider;
      if (priorCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = priorCaller;
    }
  });

  it('rechecks progressive session tree access after share and membership revocation', async () => {
    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const { captureChunk } = await import('../../../core/sessions/index.js');
    const { createTeam, addTeamMember, removeTeamMember, shareMemoryWithTeam, unshareMemory } = await import('../../../db/team-adapter.js');
    const client = new SquishRuntime({ dataDir });
    const project = join(dataDir, 'strict-shared-tree-project');
    const sessionId = `strict-shared-tree-session-${Date.now()}`;
    const marker = `SHARED_TREE_MEMBER_ONLY_${Date.now()}`;
    const memberId = `strict-shared-tree-member-${Date.now()}`;
    const previousProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'trusted-memory-writer';
    try {
      const team = await createTeam({ name: `Strict shared tree ${Date.now()}`, ownerId: 'trusted-memory-writer' });
      await addTeamMember(team.id, memberId);
      const memoryId = await captureChunk({
        type: 'decision',
        content: `Shared episodic evidence ${marker}: authorized members may recover this source.`,
        session_id: sessionId,
        session_title: 'Strict shared tree member test',
        project,
        repo_path: project,
        branch: 'main',
        agent: 'cli',
        agent_session_id: `agent-${sessionId}`,
        timestamp: new Date().toISOString(),
      }, { project, user: 'trusted-memory-writer' });
      const db = await getDb();
      const sqlite = (db as { $client: { prepare: (sql: string) => { get: (id: string) => { user_id: string } } } }).$client;
      const ownerId = sqlite.prepare('SELECT user_id FROM memories WHERE id = ?').get(memoryId).user_id;
      await shareMemoryWithTeam(memoryId, team.id, ownerId, 'read');

      process.env.SQUISH_TRUSTED_CALLER_ID = memberId;
      const memberRecovery = await client.recoverCapturedSession({
        sessionId,
        query: 'authorized members recover source',
        project,
        user: memberId,
        teamId: team.id,
        progressiveTree: true,
        budgetTokens: 1_200,
      });
      expect(memberRecovery.tree?.sourceCount).toBe(1);
      expect(JSON.stringify(memberRecovery.tree)).toContain(marker);

      expect(await unshareMemory(memoryId, team.id)).toBe(true);
      const revokedRecovery = await client.recoverCapturedSession({
        sessionId,
        query: 'authorized members recover source',
        project,
        user: memberId,
        teamId: team.id,
        progressiveTree: true,
        budgetTokens: 1_200,
      });
      expect(JSON.stringify(revokedRecovery)).not.toContain(marker);
      expect(revokedRecovery.tree).toBeUndefined();

      process.env.SQUISH_TRUSTED_CALLER_ID = 'trusted-memory-writer';
      await shareMemoryWithTeam(memoryId, team.id, ownerId, 'read');
      process.env.SQUISH_TRUSTED_CALLER_ID = memberId;
      expect(await removeTeamMember(team.id, memberId)).toBe(true);
      const removedMemberRecovery = await client.recoverCapturedSession({
        sessionId,
        query: 'authorized members recover source',
        project,
        user: memberId,
        teamId: team.id,
        progressiveTree: true,
        budgetTokens: 1_200,
      });
      expect(JSON.stringify(removedMemberRecovery)).not.toContain(marker);
      expect(removedMemberRecovery.tree).toBeUndefined();

      process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-shared-tree-stranger';
      const strangerRecovery = await client.recoverCapturedSession({
        sessionId,
        query: 'authorized members recover source',
        project,
        user: 'strict-shared-tree-stranger',
        progressiveTree: true,
        budgetTokens: 1_200,
      });
      expect(JSON.stringify(strangerRecovery)).not.toContain(marker);
      expect(strangerRecovery.tree).toBeUndefined();
    } finally {
      if (previousProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousProvider;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('audits and denies direct unscoped place catalogs, membership, rules, and walking under strict trust', async () => {
    const sqlite = ((await getDb()) as { $client: { prepare: (sql: string) => { get: () => { count: number }; all: () => Array<{ actor_hash: string; resource_hash: string; decision: string }> } } }).$client;
    const before = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'place' AND reason = 'strict_surface'").get().count);
    const { getProjectPlaces, getPlaceByType } = await import('../../../core/places/places.js');
    const { getPlaceMemories } = await import('../../../core/places/memory-places.js');
    const { getProjectRules } = await import('../../../core/places/rules.js');
    const { quickTour } = await import('../../../core/places/walking.js');

    await expect(getProjectPlaces('private-project')).rejects.toThrow('disabled under strict trust');
    await expect(getPlaceByType('private-project', 'inbox')).rejects.toThrow('disabled under strict trust');
    await expect(getPlaceMemories('wip')).rejects.toThrow('disabled under strict trust');
    await expect(getProjectRules('private-project')).rejects.toThrow('disabled under strict trust');
    await expect(quickTour('private-project')).rejects.toThrow('disabled under strict trust');

    const rows = sqlite.prepare("SELECT actor_hash, resource_hash, decision FROM trust_audit_log WHERE asset_type = 'place' AND reason = 'strict_surface' ORDER BY rowid DESC LIMIT 5").all();
    expect(Number(sqlite.prepare("SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'place' AND reason = 'strict_surface'").get().count)).toBe(before + 5);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.actor_hash === createHash('sha256').update('trusted-memory-writer').digest('hex')
      && row.resource_hash.length === 64 && row.decision === 'deny')).toBe(true);
  });

  it('binds ordinary SDK capture and retrieval to the configured strict principal', { timeout: 30000 }, async () => {
    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const client = new SquishRuntime({ dataDir });
    await expect(client.remember('forged SDK owner memory', { user: 'someone-else' }))
      .rejects.toThrow('does not match the authenticated principal');
    await expect(client.search('private SDK memory', { user: 'someone-else' }))
      .rejects.toThrow('does not match the authenticated principal');
    await expect(client.recall('private SDK memory', { user: 'someone-else' }))
      .rejects.toThrow('does not match the authenticated principal');

    const memory = await client.remember('strict SDK owner-bound memory', { type: 'fact' });
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: (id: string, reason?: string) => { external_id: string | null; access_count: number; usage_count: number; confidence_level: string; decision?: string; reason?: string } } } }).$client;
    const owner = sqlite.prepare('SELECT users.external_id FROM memories JOIN users ON users.id = memories.user_id WHERE memories.id = ?').get(memory.id).external_id;
    expect(owner).toBe('trusted-memory-writer');

    await expect(client.captureSessionChunks([{
      type: 'summary', content: 'Forged SDK capture owner must be rejected',
      session_id: 'strict-runtime-capture-forged', session_title: 'Strict runtime capture',
      project: '', repo_path: dataDir, branch: 'main', agent: 'cli',
      agent_session_id: 'strict-runtime-capture-agent', timestamp: new Date().toISOString(),
    }], { user: 'someone-else' })).rejects.toThrow('does not match the authenticated principal');
    const capturedSessionIds = await client.captureSessionChunks([{
      type: 'summary', content: 'Strict runtime capture stays an episodic source',
      session_id: 'strict-runtime-capture-owner', session_title: 'Strict runtime capture',
      project: '', repo_path: dataDir, branch: 'main', agent: 'cli',
      agent_session_id: 'strict-runtime-capture-agent', timestamp: new Date().toISOString(),
    }]);
    expect(capturedSessionIds).toHaveLength(1);
    const capturedOwner = sqlite.prepare('SELECT users.external_id FROM memories JOIN users ON users.id = memories.user_id WHERE memories.id = ?')
      .get(capturedSessionIds[0]).external_id;
    expect(capturedOwner).toBe('trusted-memory-writer');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_analysis_jobs WHERE source_memory_id = ?')
      .get(capturedSessionIds[0]).count).toBe(0);
    const results = await client.search('strict SDK owner-bound memory');
    expect(results.some((result) => result.memory.id === memory.id)).toBe(true);

    const before = sqlite.prepare('SELECT access_count FROM memories WHERE id = ?').get(memory.id).access_count;
    const feedback = await client.feedback('memory', memory.id, 'used');
    expect(feedback.applied).toBe(true);
    expect(sqlite.prepare('SELECT access_count FROM memories WHERE id = ?').get(memory.id).access_count).toBe(before + 1);
    const audit = sqlite.prepare("SELECT decision, reason, actor_hash, resource_hash FROM trust_audit_log WHERE asset_type = 'memory' AND reason = 'memory_feedback_used' ORDER BY created_at DESC LIMIT 1").get() as { decision: string; reason: string; actor_hash: string; resource_hash: string };
    expect(audit.decision).toBe('allow');
    expect(audit.reason).toBe('memory_feedback_used');
    expect(audit.actor_hash).not.toBe('trusted-memory-writer');
    expect(audit.resource_hash).not.toBe(memory.id);

    const usageBeforeConfirm = sqlite.prepare('SELECT usage_count FROM memories WHERE id = ?').get(memory.id).usage_count;
    const confirmed = await client.feedback('memory', memory.id, 'confirm');
    expect(confirmed.applied).toBe(true);
    expect(sqlite.prepare('SELECT usage_count FROM memories WHERE id = ?').get(memory.id).usage_count).toBe(usageBeforeConfirm + 1);
    const contradicted = await client.feedback('memory', memory.id, 'contradict');
    expect(contradicted.applied).toBe(true);
    expect(sqlite.prepare('SELECT confidence_level FROM memories WHERE id = ?').get(memory.id).confidence_level).toBe('outdated');
    for (const reason of ['memory_feedback_confirm', 'memory_feedback_contradict']) {
      const signalAudit = sqlite.prepare("SELECT decision, reason FROM trust_audit_log WHERE asset_type = 'memory' AND resource_hash = ? AND reason = ? ORDER BY created_at DESC LIMIT 1")
        .get(createHash('sha256').update(memory.id).digest('hex'), reason);
      expect(signalAudit).toEqual({ decision: 'allow', reason });
    }

    const beforeRollback = sqlite.prepare('SELECT access_count FROM memories WHERE id = ?').get(memory.id).access_count;
    (sqlite as any).exec(`CREATE TRIGGER reject_feedback_audit BEFORE INSERT ON trust_audit_log
      WHEN NEW.reason = 'memory_feedback_used' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;`);
    try {
      await expect(client.feedback('memory', memory.id, 'used')).rejects.toThrow('Failed to apply feedback');
    } finally {
      (sqlite as any).exec('DROP TRIGGER reject_feedback_audit');
    }
    expect(sqlite.prepare('SELECT access_count FROM memories WHERE id = ?').get(memory.id).access_count).toBe(beforeRollback);
  });

  it('rechecks strict team-memory feedback after membership revocation', async () => {
    const { createTeam, addTeamMember, shareMemoryWithTeam, unshareMemory } = await import('../../../db/team-adapter.js');
    const team = await createTeam({ name: 'Strict feedback revocation', ownerId: 'trusted-memory-writer' });
    const memberId = 'strict-feedback-revocation-member';
    await addTeamMember(team.id, memberId);
    const memory = await rememberMemory({
      content: 'Team member feedback is revoked with membership',
      type: 'fact',
      teamId: team.id,
    });
    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const client = new SquishRuntime({ dataDir });
    const db = await getDb();
    const sqlite = (db as unknown as { $client: {
      prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined };
      exec: (sql: string) => unknown;
    } }).$client;
    const resourceHash = createHash('sha256').update(memory.id).digest('hex');
    const memberHash = createHash('sha256').update(memberId).digest('hex');
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUSTED_CALLER_ID = memberId;
    try {
      const before = sqlite.prepare('SELECT access_count FROM memories WHERE id=?').get(memory.id)!;
      const allowed = await client.feedback('memory', memory.id, 'used');
      expect(allowed.applied).toBe(true);
      expect(Number(sqlite.prepare('SELECT access_count FROM memories WHERE id=?').get(memory.id)!.access_count))
        .toBe(Number(before.access_count) + 1);

      const allowAudit = sqlite.prepare("SELECT decision, reason, actor_hash, resource_hash FROM trust_audit_log WHERE asset_type='memory' AND resource_hash=? AND reason='memory_feedback_used' ORDER BY created_at DESC LIMIT 1")
        .get(resourceHash)!;
      expect(allowAudit.decision).toBe('allow');
      expect(allowAudit.actor_hash).toBe(memberHash);

      process.env.SQUISH_TRUSTED_CALLER_ID = 'trusted-memory-writer';
      const sharedMemory = await rememberMemory({
        content: 'Explicit private-memory share grants team feedback access',
        type: 'fact',
      });
      await shareMemoryWithTeam(sharedMemory.id, team.id, 'trusted-memory-writer', 'read');
      process.env.SQUISH_TRUSTED_CALLER_ID = memberId;
      const sharedAccess = await client.feedback('memory', sharedMemory.id, 'used');
      expect(sharedAccess.applied).toBe(true);
      await setVisibilityRule({ assetType: 'memory', assetId: sharedMemory.id, ruleType: 'allow',
        granteeType: 'user', granteeId: 'trusted-memory-writer', permission: 'read' });
      const restrictedBeforeDenial = sqlite.prepare('SELECT access_count, usage_count FROM memories WHERE id=?').get(sharedMemory.id);
      await expect(client.feedback('memory', sharedMemory.id, 'confirm'))
        .rejects.toThrow('not readable by the authenticated principal');
      expect(sqlite.prepare('SELECT access_count, usage_count FROM memories WHERE id=?').get(sharedMemory.id))
        .toEqual(restrictedBeforeDenial);
      const { removeVisibilityRule } = await import('../../../core/loadout/loadout.js');
      await removeVisibilityRule('memory', sharedMemory.id, 'user', 'trusted-memory-writer');
      expect(await unshareMemory(sharedMemory.id, team.id)).toBe(true);
      const sharedBeforeDenial = sqlite.prepare('SELECT access_count, usage_count FROM memories WHERE id=?').get(sharedMemory.id)!;
      await expect(client.feedback('memory', sharedMemory.id, 'confirm'))
        .rejects.toThrow('not readable by the authenticated principal');
      expect(sqlite.prepare('SELECT access_count, usage_count FROM memories WHERE id=?').get(sharedMemory.id))
        .toEqual(sharedBeforeDenial);
      const sharedDenyAudit = sqlite.prepare("SELECT decision, actor_hash, resource_hash FROM trust_audit_log WHERE asset_type='memory' AND resource_hash=? AND actor_hash=? AND decision='deny' ORDER BY created_at DESC LIMIT 1")
        .get(createHash('sha256').update(sharedMemory.id).digest('hex'), memberHash)!;
      expect(sharedDenyAudit.decision).toBe('deny');

      const lockMarker = join(dataDir, 'feedback-membership-revoke-ready');
      const revokerScript = [
        "import { Database } from 'bun:sqlite';",
        "import { writeFileSync } from 'node:fs';",
        `const db = new Database(${JSON.stringify(join(dataDir, 'squish.db'))});`,
        "db.exec('PRAGMA busy_timeout = 5000');",
        "db.exec('BEGIN IMMEDIATE');",
        `db.prepare('DELETE FROM team_members WHERE team_id=? AND user_id=(SELECT id FROM users WHERE external_id=?)').run(${JSON.stringify(team.id)}, ${JSON.stringify(memberId)});`,
        `writeFileSync(${JSON.stringify(lockMarker)}, 'ready');`,
        'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);',
        "db.exec('COMMIT');",
        'db.close();',
      ].join('\n');
      const revoker = spawn(process.execPath, ['-e', revokerScript], { stdio: ['ignore', 'ignore', 'pipe'] });
      let revokerError = '';
      revoker.stderr?.on('data', (chunk: Buffer) => { revokerError += chunk.toString(); });
      const revokerExit = new Promise<{ code: number | null }>((resolve) => {
        revoker.once('exit', (code) => resolve({ code }));
      });
      try {
        for (let attempt = 0; attempt < 100 && !existsSync(lockMarker); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(lockMarker), revokerError).toBe(true);
        const beforeDeniedFeedback = sqlite.prepare('SELECT access_count, usage_count FROM memories WHERE id=?').get(memory.id)!;
        await expect(client.feedback('memory', memory.id, 'confirm'))
          .rejects.toThrow('not readable by the authenticated principal');
        expect(sqlite.prepare('SELECT access_count, usage_count FROM memories WHERE id=?').get(memory.id))
          .toEqual(beforeDeniedFeedback);
      } finally {
        if (revoker.exitCode === null) revoker.kill();
        await revokerExit;
      }
      expect((await revokerExit).code).toBe(0);
      expect(revokerError).toBe('');
      const denyAudit = sqlite.prepare("SELECT decision, reason, actor_hash, resource_hash FROM trust_audit_log WHERE asset_type='memory' AND resource_hash=? AND actor_hash=? AND decision='deny' ORDER BY created_at DESC LIMIT 1")
        .get(resourceHash, memberHash)!;
      expect(denyAudit.decision).toBe('deny');
      expect(denyAudit.reason).toBe('private_default');

      await addTeamMember(team.id, memberId);
      const feedbackLockMarker = join(dataDir, 'feedback-first-revocation-attempt');
      const feedbackLockAcquiredMarker = join(dataDir, 'feedback-first-lock-acquired');
      const feedbackFirstRevokerScript = [
        "import { Database } from 'bun:sqlite';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        `const db = new Database(${JSON.stringify(join(dataDir, 'squish.db'))});`,
        "db.exec('PRAGMA busy_timeout = 5000');",
        `writeFileSync(${JSON.stringify(feedbackLockMarker)}, 'attempting');`,
        `for (let attempt = 0; attempt < 500 && !existsSync(${JSON.stringify(feedbackLockAcquiredMarker)}); attempt++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
        `if (!existsSync(${JSON.stringify(feedbackLockAcquiredMarker)})) throw new Error('feedback did not acquire the database lock');`,
        "db.exec('BEGIN IMMEDIATE');",
        `db.prepare('DELETE FROM team_members WHERE team_id=? AND user_id=(SELECT id FROM users WHERE external_id=?)').run(${JSON.stringify(team.id)}, ${JSON.stringify(memberId)});`,
        "db.exec('COMMIT');",
        'db.close();',
      ].join('\n');
      const feedbackFirstRevoker = spawn(process.execPath, ['-e', feedbackFirstRevokerScript], { stdio: ['ignore', 'ignore', 'pipe'] });
      let feedbackFirstRevokerError = '';
      feedbackFirstRevoker.stderr?.on('data', (chunk: Buffer) => { feedbackFirstRevokerError += chunk.toString(); });
      const feedbackFirstRevokerExit = new Promise<{ code: number | null }>((resolve) => {
        feedbackFirstRevoker.once('exit', (code) => resolve({ code }));
      });
      const originalExec = sqlite.exec.bind(sqlite);
      let delayedRevoker = false;
      sqlite.exec = (sql: string) => {
        const result = originalExec(sql);
        if (sql === 'BEGIN IMMEDIATE' && !delayedRevoker) {
          delayedRevoker = true;
          writeFileSync(feedbackLockAcquiredMarker, 'locked');
        }
        return result;
      };
      try {
        const feedbackWonLock = await client.feedback('memory', memory.id, 'confirm');
        expect(feedbackWonLock.applied).toBe(true);
      } finally {
        sqlite.exec = originalExec;
      }
      const feedbackFirstExit = await feedbackFirstRevokerExit;
      expect(feedbackFirstExit.code, feedbackFirstRevokerError).toBe(0);
      expect(feedbackFirstRevokerError).toBe('');
      await expect(client.feedback('memory', memory.id, 'used'))
        .rejects.toThrow('not readable by the authenticated principal');
    } finally {
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('matches strict memory feedback grants against the resolved persisted user ID', async () => {
    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const memory = await rememberMemory({ content: 'Feedback grant uses the persisted caller identity', type: 'fact' });
    const db = await getDb();
    const sqlite = (db as any).$client;
    const callerId = 'feedback-internal-grant-caller';
    const { resolvePersistedUserId } = await import('../../../db/team-adapter.js');
    const persistedUserId = await resolvePersistedUserId(callerId, true);
    expect(persistedUserId).toBeTruthy();
    await setVisibilityRule({
      assetType: 'memory', assetId: memory.id, ruleType: 'allow',
      granteeType: 'user', granteeId: persistedUserId!, permission: 'read',
    });

    const client = new SquishRuntime({ dataDir });
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
    try {
      const before = Number(sqlite.prepare('SELECT access_count FROM memories WHERE id=?').get(memory.id).access_count);
      const result = await client.feedback('memory', memory.id, 'used');
      expect(result.applied).toBe(true);
      expect(Number(sqlite.prepare('SELECT access_count FROM memories WHERE id=?').get(memory.id).access_count)).toBe(before + 1);
    } finally {
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('does not borrow team membership from an email-colliding SQLite principal during strict feedback', async () => {
    const { createTeam, addTeamMember } = await import('../../../db/team-adapter.js');
    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const team = await createTeam({ name: 'Feedback identity collision', ownerId: 'trusted-memory-writer' });
    const collidingEmailUser = 'feedback-email-team-member';
    await addTeamMember(team.id, collidingEmailUser);
    const db = await getDb();
    const sqlite = (db as any).$client;
    const collidingUser = sqlite.prepare('SELECT id FROM users WHERE external_id=?').get(collidingEmailUser) as { id: string };
    const callerPrincipal = 'feedback-collision@example.test';
    sqlite.prepare('UPDATE users SET email=? WHERE id=?').run(callerPrincipal, collidingUser.id);
    sqlite.prepare('INSERT INTO users (id, external_id, email) VALUES (?, ?, ?)')
      .run('feedback-collision-principal', callerPrincipal, 'actual-principal@example.test');

    // This is the ambiguity the old OR/LIMIT 1 identity lookup exposed: the
    // earlier email row is selected before the caller's exact external ID.
    const legacyResolution = sqlite.prepare('SELECT id FROM users WHERE id=? OR external_id=? OR email=? LIMIT 1')
      .get(callerPrincipal, callerPrincipal, callerPrincipal) as { id: string };
    expect(legacyResolution.id).toBe(collidingUser.id);

    const memory = await rememberMemory({
      content: 'Only the email-colliding member can use this team memory',
      type: 'fact',
      teamId: team.id,
    });
    const client = new SquishRuntime({ dataDir });
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUSTED_CALLER_ID = callerPrincipal;
    try {
      const before = sqlite.prepare('SELECT access_count FROM memories WHERE id=?').get(memory.id) as { access_count: number };
      await expect(client.feedback('memory', memory.id, 'used'))
        .rejects.toThrow('not readable by the authenticated principal');
      expect(sqlite.prepare('SELECT access_count FROM memories WHERE id=?').get(memory.id)).toEqual(before);
    } finally {
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('authorizes and atomically re-signs only caller-visible single-source belief feedback', async () => {
    const sourceMemory = await rememberMemory({ content: 'Belief feedback source belongs to trusted owner', type: 'fact' });
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { get: (...args: unknown[]) => any }; exec: (sql: string) => void } }).$client;
    const source = sqlite.prepare('SELECT user_id, team_id, project_id, type FROM memories WHERE id=?').get(sourceMemory.id) as {
      user_id: string; team_id: string | null; project_id: string | null; type: string;
    };
    const content = 'The project retains source-backed beliefs';
    const metadata: Record<string, unknown> = {
      sourceMemoryId: sourceMemory.id,
      derivation: { kind: 'extracted_belief', jobId: 'feedback-job', index: 0, beliefType: 'constraint', confidence: 0.65,
        status: 'active', reason: 'Derived from source', evidenceSummary: 'One source' },
    };
    const provenanceInput = {
      content, projectId: source.project_id, type: 'constraint', ownerId: source.user_id, teamId: source.team_id,
      sourceMemoryId: sourceMemory.id, metadata,
    };
    metadata.__squishProvenance = signMemoryProvenance(provenanceInput);
    const belief = await createKnowledge({ knowledgeKind: 'belief', knowledgeType: 'constraint', content,
      projectId: source.project_id ?? undefined, confidence: 0.65, status: 'active', reason: 'Derived from source',
      evidenceSummary: 'One source', metadata });
    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const client = new SquishRuntime({ dataDir });

    const deniedProjection = { ...metadata, derivation: { ...(metadata.derivation as object), confidence: 0.7 } };
    const deniedSignature = signMemoryProvenance({ ...provenanceInput, metadata: deniedProjection });
    deniedProjection.__squishProvenance = deniedSignature;
    await expect(createKnowledge({ knowledgeKind: 'belief', knowledgeType: 'constraint', content,
      projectId: source.project_id ?? undefined, confidence: 0.65, status: 'active', reason: 'Derived from source',
      evidenceSummary: 'One source', metadata: deniedProjection })).rejects.toThrow('valid signed single-source projection');
    sqlite.prepare('UPDATE knowledge SET metadata=? WHERE id=?').run(JSON.stringify(deniedProjection), belief.id);
    await expect(client.feedback('belief', belief.id, 'used')).rejects.toThrow('authorized, single-source signed belief');
    sqlite.prepare('UPDATE knowledge SET metadata=? WHERE id=?').run(JSON.stringify(metadata), belief.id);
    const unchanged = sqlite.prepare('SELECT confidence, metadata FROM knowledge WHERE id=?').get(belief.id) as { confidence: number; metadata: string };
    expect(unchanged.confidence).toBe(0.65);

    const inactiveMetadata: Record<string, unknown> = {
      ...metadata,
      derivation: { ...(metadata.derivation as object), status: 'superseded' },
    };
    inactiveMetadata.__squishProvenance = signMemoryProvenance({ ...provenanceInput, metadata: inactiveMetadata });
    const inactive = await createKnowledge({ knowledgeKind: 'belief', knowledgeType: 'constraint', content,
      projectId: source.project_id ?? undefined, confidence: 0.65, status: 'superseded', reason: 'Derived from source',
      evidenceSummary: 'One source', metadata: inactiveMetadata });
    await expect(client.feedback('belief', inactive.id, 'confirm')).rejects.toThrow('authorized, single-source signed belief');
    expect((sqlite.prepare('SELECT confidence, status FROM knowledge WHERE id=?').get(inactive.id) as { confidence: number; status: string }))
      .toEqual({ confidence: 0.65, status: 'superseded' });

    sqlite.prepare("UPDATE memories SET expires_at = (CAST(strftime('%s','now') AS INTEGER) - 1) * 1000 WHERE id=?").run(sourceMemory.id);
    await expect(client.feedback('belief', belief.id, 'used')).rejects.toThrow('authorized, single-source signed belief');
    sqlite.prepare("UPDATE memories SET expires_at=NULL, valid_to = (CAST(strftime('%s','now') AS INTEGER) - 1) * 1000 WHERE id=?").run(sourceMemory.id);
    await expect(client.feedback('belief', belief.id, 'used')).rejects.toThrow('authorized, single-source signed belief');
    sqlite.prepare("UPDATE memories SET valid_to=NULL, valid_from = (CAST(strftime('%s','now') AS INTEGER) + 60) * 1000 WHERE id=?").run(sourceMemory.id);
    await expect(client.feedback('belief', belief.id, 'used')).rejects.toThrow('authorized, single-source signed belief');
    sqlite.prepare('UPDATE memories SET valid_from=NULL WHERE id=?').run(sourceMemory.id);

    await setVisibilityRule({ assetType: 'memory', assetId: sourceMemory.id, ruleType: 'allow',
      granteeType: 'user', granteeId: 'another-principal', permission: 'read' });
    try {
      await expect(client.feedback('belief', belief.id, 'used')).rejects.toThrow('authorized, single-source signed belief');
    } finally {
      const { removeVisibilityRule } = await import('../../../core/loadout/loadout.js');
      await removeVisibilityRule('memory', sourceMemory.id, 'user', 'another-principal');
    }
    expect((sqlite.prepare('SELECT confidence FROM knowledge WHERE id=?').get(belief.id) as { confidence: number }).confidence).toBe(0.65);

    const confirmed = await client.feedback('belief', belief.id, 'confirm');
    expect(confirmed.applied).toBe(true);
    expect(confirmed.confidence).toBeCloseTo(0.73);
    const updated = sqlite.prepare('SELECT confidence, status, reason, evidence_summary, source_count, last_confirmed_at, metadata FROM knowledge WHERE id=?').get(belief.id) as {
      confidence: number; status: string; reason: string; evidence_summary: string; source_count: number; last_confirmed_at: number; metadata: string;
    };
    const updatedMetadata = JSON.parse(updated.metadata) as Record<string, unknown>;
    expect(verifySignedBeliefProjection({ content, projectId: source.project_id, type: 'constraint', ownerId: source.user_id,
      teamId: source.team_id, sourceMemoryId: sourceMemory.id, metadata: updatedMetadata, confidence: updated.confidence,
      status: updated.status, reason: updated.reason, evidenceSummary: updated.evidence_summary })).toBe(true);
    expect(updated.source_count).toBe(1);
    expect(updated.last_confirmed_at).toBeGreaterThan(0);
    const firstConfirmationAt = updated.last_confirmed_at;
    await client.feedback('belief', belief.id, 'confirm');
    const repeatedConfirmation = sqlite.prepare('SELECT source_count, last_confirmed_at FROM knowledge WHERE id=?').get(belief.id) as {
      source_count: number; last_confirmed_at: number;
    };
    expect(repeatedConfirmation.source_count).toBe(1);
    expect(repeatedConfirmation.last_confirmed_at).toBeGreaterThanOrEqual(firstConfirmationAt);
    const audit = sqlite.prepare("SELECT decision, reason, asset_type FROM trust_audit_log WHERE resource_hash = ? ORDER BY created_at DESC LIMIT 1")
      .get((await import('node:crypto')).createHash('sha256').update(belief.id).digest('hex')) as { decision: string; reason: string; asset_type: string };
    expect(audit).toEqual({ decision: 'allow', reason: 'belief_feedback_confirm', asset_type: 'knowledge' });

    const beforeRollback = sqlite.prepare('SELECT confidence, metadata FROM knowledge WHERE id=?').get(belief.id) as { confidence: number; metadata: string };
    sqlite.exec(`CREATE TRIGGER reject_belief_feedback_audit BEFORE INSERT ON trust_audit_log
      WHEN NEW.reason = 'belief_feedback_used' BEGIN SELECT RAISE(ABORT, 'belief audit failure regression'); END;`);
    try {
      await expect(client.feedback('belief', belief.id, 'used')).rejects.toThrow('Failed to apply feedback');
    } finally {
      sqlite.exec('DROP TRIGGER reject_belief_feedback_audit');
    }
    expect(sqlite.prepare('SELECT confidence, metadata FROM knowledge WHERE id=?').get(belief.id)).toEqual(beforeRollback);

    const used = await client.feedback('belief', belief.id, 'used');
    expect(used.confidence).toBeCloseTo(0.83);
    const contradicted = await client.feedback('belief', belief.id, 'contradict');
    expect(contradicted.confidence).toBeCloseTo(0.68);
    const contradictedRow = sqlite.prepare('SELECT confidence, status, reason, evidence_summary, metadata FROM knowledge WHERE id=?').get(belief.id) as {
      confidence: number; status: string; reason: string; evidence_summary: string; metadata: string;
    };
    expect(contradictedRow.status).toBe('disputed');
    expect(verifySignedBeliefProjection({ content, projectId: source.project_id, type: 'constraint', ownerId: source.user_id,
      teamId: source.team_id, sourceMemoryId: sourceMemory.id, metadata: JSON.parse(contradictedRow.metadata) as Record<string, unknown>,
      confidence: contradictedRow.confidence, status: contradictedRow.status, reason: contradictedRow.reason,
      evidenceSummary: contradictedRow.evidence_summary })).toBe(true);

    await expect(client.feedback('strategy', 'untrusted-strategy-id', 'used')).rejects.toThrow('requires signed single-source lineage');
  });

  it('requires persisted team membership before writing a team-scoped memory', async () => {
    await expect(rememberMemory({
      content: 'unapproved team memory',
      user: 'trusted-memory-writer',
      teamId: 'team-without-membership',
    })).rejects.toThrow('persisted team membership');
  });

  it('audits denied strict writes without storing raw caller or team identifiers', async () => {
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { all: () => Array<{ actor_hash: string; resource_hash: string; asset_type: string; decision: string; reason: string }>; get: () => { count: number } } } }).$client;
    const rows = sqlite.prepare("SELECT actor_hash, resource_hash, asset_type, decision, reason FROM trust_audit_log WHERE decision='deny'").all();
    const reasons = rows.map((row) => row.reason).filter((reason) => reason !== 'strict_surface');
    expect(reasons).toContain('caller_mismatch');
    expect(reasons).toContain('invalid_signature');
    expect(reasons).toContain('private_default');
    expect(reasons).toContain('unsigned_legacy');
    const placeAudits = rows.filter((row) => row.asset_type === 'place' && row.reason === 'strict_surface');
    expect(placeAudits.length).toBeGreaterThanOrEqual(4);
    expect(placeAudits.every((row) => row.resource_hash.length === 64 && row.decision === 'deny')).toBe(true);
    const associationAudits = rows.filter((row) => row.asset_type === 'memory_association');
    expect(associationAudits.length).toBeGreaterThanOrEqual(3);
    expect(associationAudits.every((row) => row.resource_hash.length === 64
      && row.resource_hash !== 'memory_association_collection'
      && row.resource_hash !== 'memory_related_read')).toBe(true);
    expect(rows.every((row) => row.actor_hash !== 'trusted-memory-writer' && row.resource_hash !== 'team-without-membership')).toBe(true);
  });
});
