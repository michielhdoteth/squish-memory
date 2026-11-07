/**
 * Edit workflow coverage: propose -> list -> preview -> approve (content
 * change, version++, snapshot, confirm applied) -> reject -> stale-content
 * conflict -> expiry.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-edit-workflow-'));
const savedEnv = new Map<string, string | undefined>();
const envKeys = ['SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_TRUST_POLICY', 'SQUISH_PROVENANCE_PRIVATE_KEY', 'SQUISH_PROVENANCE_PUBLIC_KEY', 'SQUISH_PROVENANCE_KEY_ID', 'SQUISH_ENCRYPTION_ENABLED', 'SQUISH_ENCRYPTION_PASSPHRASE'] as const;
for (const key of envKeys) savedEnv.set(key, process.env[key]);
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_TRUST_POLICY = 'local-compatible';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
process.env.SQUISH_PROVENANCE_KEY_ID = 'edit-workflow-test';

const { resetDb, getDb } = await import('../../../db/index.js');
const { rememberMemory } = await import('../../../core/memory/memories.js');
const {
  createEditProposal,
  getEditProposals,
  approveEditProposal,
  rejectEditProposal,
  correctMemory,
  expireStaleEditProposals,
} = await import('../../../core/memory/edit-workflow.js');
const { verifyMemoryProvenance } = await import('../../../core/acl/provenance.js');
const { TrustBoundaryError } = await import('../../../core/acl/trust-policy.js');
const { getMemoryHistory, getMemorySnapshot, getStrictCorrectionHistory } = await import('../../../core/snapshots/retrieval.js');
const { createAfterSnapshot } = await import('../../../core/snapshots/creation.js');

afterAll(async () => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function ensureEditTables() {
  const sqlite = (await getDb()).$client;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory_edit_proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT,
      memory_id TEXT NOT NULL,
      current_content TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      reason TEXT NOT NULL,
      conflict_warnings TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      reviewed_at INTEGER,
      review_notes TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_snapshots (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      diff TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `);
}

describe('edit workflow', () => {
  let memoryId: string;

  beforeAll(async () => {
    resetDb();
    await ensureEditTables();
    const mem = await rememberMemory({ content: 'original content', type: 'fact' });
    memoryId = mem.id;
  });

  test('propose stages an edit proposal', async () => {
    const proposal = await createEditProposal(memoryId, 'new content', 'fix wording');
    expect(proposal.id).toBeTruthy();
    expect(proposal.status).toBe('pending');
    expect(proposal.currentContent).toBe('original content');
    expect(proposal.proposedContent).toBe('new content');
  });

  test('list returns pending proposals', async () => {
    const proposals = await getEditProposals({ memoryId, status: 'pending' });
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals[0].proposedContent).toBe('new content');
  });

  test('approve applies content change, version++, snapshot, confirm applied', async () => {
    const listed = await getEditProposals({ memoryId, status: 'pending' });
    const proposalId = listed[0].id;
    const { findOrCreateCluster, getClusterForMemory, clearClusters } = await import('../../../core/clustering/cluster-engine.js');
    clearClusters();
    await findOrCreateCluster(memoryId, [1, 0, 0]);
    expect(getClusterForMemory(memoryId)).toBeTruthy();

    const result = await approveEditProposal(proposalId, 'reviewed');
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBeTruthy();
    expect(getClusterForMemory(memoryId)).toBeNull();

    const sqlite = (await getDb()).$client;
    const row = sqlite.prepare('SELECT content, version, project_id, type, metadata, user_id, team_id, valid_from, valid_to, recorded_at FROM memories WHERE id = ?').get(memoryId);
    const scope = { ownerId: row.user_id, teamId: row.team_id, sourceMemoryId: memoryId };
    expect(row.content).toBe('new content');
    expect(row.version).toBeGreaterThanOrEqual(1);
    expect(verifyMemoryProvenance({
      content: row.content,
      projectId: row.project_id,
      type: row.type,
      ...scope,
      metadata: JSON.parse(row.metadata),
    })).toBe(true);

    const projection = sqlite.prepare(`
      SELECT content, project_id, knowledge_type, metadata, valid_from, recorded_at FROM knowledge
      WHERE knowledge_kind = 'memory' AND json_extract(metadata, '$.sourceMemoryId') = ?
    `).get(memoryId);
    expect(projection.content).toBe('new content');
    expect(projection.valid_from).toBe(row.valid_from);
    expect(projection.recorded_at).toBe(row.recorded_at);
    expect(verifyMemoryProvenance({
      content: projection.content,
      projectId: projection.project_id,
      type: projection.knowledge_type,
      ...scope,
      metadata: JSON.parse(projection.metadata),
    })).toBe(true);

    const snap = sqlite.prepare('SELECT snapshot_type, content FROM memory_snapshots WHERE memory_id = ?').get(memoryId);
    expect(snap.snapshot_type).toBe('before_update');
    expect(snap.content).toBe('original content');
  });

  test('after-snapshot creation rejects a before-snapshot from another memory', async () => {
    const target = await rememberMemory({ content: 'target memory content', type: 'fact' });
    const sqlite = (await getDb()).$client;
    const beforeSnapshotId = 'cross-memory-before-snapshot';
    sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content, metadata, diff, created_at)
      VALUES (?, ?, 'before_update', ?, '{}', '{}', ?)`)
      .run(beforeSnapshotId, memoryId, 'private source snapshot text', Math.floor(Date.now() / 1000));

    await expect(createAfterSnapshot(target.id, beforeSnapshotId))
      .rejects.toThrow('Before snapshot belongs to a different memory or is not a before-update snapshot');
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM memory_snapshots
      WHERE memory_id=? AND snapshot_type='after_update'`).get(target.id).count).toBe(0);

    const validAfter = await createAfterSnapshot(memoryId, beforeSnapshotId);
    expect(validAfter.snapshotId).toBeTruthy();
    const afterRow = sqlite.prepare('SELECT metadata, diff FROM memory_snapshots WHERE id=?').get(validAfter.snapshotId);
    expect(JSON.parse(afterRow.metadata)).toBeDefined();
    expect(JSON.parse(afterRow.diff)).toHaveProperty('removed');
  });

  test('reject closes proposal without applying', async () => {
    const proposal = await createEditProposal(memoryId, 'other content', 'reject me');
    const result = await rejectEditProposal(proposal.id, 'no longer needed');
    expect(result.ok).toBe(true);
    expect(result.proposal.status).toBe('rejected');

    const { getDb } = await import('../../../db/index.js');
    const sqlite = (await getDb()).$client;
    const row = sqlite.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId);
    expect(row.content).toBe('new content');
  });

  test('correct applies direct correction with correction snapshot', async () => {
    const { findOrCreateCluster, getClusterForMemory, clearClusters } = await import('../../../core/clustering/cluster-engine.js');
    clearClusters();
    await findOrCreateCluster(memoryId, [1, 0, 0]);
    expect(getClusterForMemory(memoryId)).toBeTruthy();
    const sqlite = (await getDb()).$client;
    const intervalStart = 1_704_067_200;
    const intervalEnd = 2_208_988_800;
    const expiresAt = 2_398_291_200;
    sqlite.prepare('UPDATE memories SET valid_from=?, valid_to=?, expires_at=? WHERE id=?').run(intervalStart, intervalEnd, expiresAt, memoryId);
    sqlite.prepare(`UPDATE knowledge SET valid_from=?, valid_to=? WHERE knowledge_kind='memory'
      AND json_extract(metadata, '$.sourceMemoryId')=?`).run(intervalStart, intervalEnd, memoryId);
    const prior = sqlite.prepare('SELECT valid_from, valid_to, recorded_at FROM memories WHERE id=?').get(memoryId);
    const result = await correctMemory(memoryId, 'corrected content', 'agent had it wrong');
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBeTruthy();
    expect(getClusterForMemory(memoryId)).toBeNull();
    expect(result.priorContent).toBe('new content');
    expect(result).toMatchObject({
      priorValidFrom: new Date(intervalStart * 1000).toISOString(),
      priorValidTo: new Date(intervalEnd * 1000).toISOString(),
      priorRecordedAt: new Date(prior.recorded_at * 1000).toISOString(),
      priorExpiresAt: new Date(expiresAt * 1000).toISOString(),
    });

    const row = sqlite.prepare('SELECT content, version, project_id, type, metadata, user_id, team_id, valid_from, valid_to, expires_at, recorded_at FROM memories WHERE id = ?').get(memoryId);
    const scope = { ownerId: row.user_id, teamId: row.team_id, sourceMemoryId: memoryId };
    expect(row.content).toBe('corrected content');
    expect(row.valid_from).toBe(intervalStart);
    expect(row.valid_to).toBe(intervalEnd);
    expect(row.expires_at).toBe(expiresAt);
    expect(verifyMemoryProvenance({
      content: row.content,
      projectId: row.project_id,
      type: row.type,
      ...scope,
      metadata: JSON.parse(row.metadata),
    })).toBe(true);

    const projection = sqlite.prepare(`
      SELECT content, project_id, knowledge_type, metadata, valid_from, valid_to, recorded_at FROM knowledge
      WHERE knowledge_kind = 'memory'
        AND json_extract(metadata, '$.sourceMemoryId') = ?
    `).get(memoryId);
    expect(projection.content).toBe('corrected content');
    expect(projection.valid_from).toBe(intervalStart);
    expect(projection.valid_to).toBe(intervalEnd);
    expect(projection.recorded_at).toBe(row.recorded_at);
    expect(verifyMemoryProvenance({
      content: projection.content,
      projectId: projection.project_id,
      type: projection.knowledge_type,
      ...scope,
      metadata: JSON.parse(projection.metadata),
    })).toBe(true);

    const snap = sqlite
      .prepare("SELECT content, metadata FROM memory_snapshots WHERE memory_id = ? AND snapshot_type = 'correction'")
      .get(memoryId);
    expect(snap.content).toBe('new content');
    expect(JSON.parse(snap.metadata).reason).toBe('agent had it wrong');
    expect(JSON.parse(snap.metadata)).toMatchObject({
      priorValidFrom: new Date(intervalStart * 1000).toISOString(),
      priorValidTo: new Date(intervalEnd * 1000).toISOString(),
      priorRecordedAt: new Date(prior.recorded_at * 1000).toISOString(),
      priorExpiresAt: new Date(expiresAt * 1000).toISOString(),
    });
  });

  test('direct correction updates a legacy canonical projection keyed by the source id', async () => {
    const memory = await rememberMemory({ content: 'legacy projection original content', type: 'fact' });
    const sqlite = (await getDb()).$client;
    const source = sqlite.prepare('SELECT project_id, type FROM memories WHERE id = ?').get(memory.id);
    sqlite.prepare(`DELETE FROM knowledge WHERE id = ? OR json_extract(metadata, '$.sourceMemoryId') = ?`)
      .run(memory.id, memory.id);
    sqlite.prepare(`INSERT INTO knowledge
      (id, project_id, knowledge_kind, knowledge_type, content, status, is_active, metadata)
      VALUES (?, ?, 'memory', ?, ?, 'active', 1, '{}')`)
      .run(memory.id, source.project_id, source.type, 'legacy projection original content');

    const result = await correctMemory(memory.id, 'corrected legacy projection content', 'legacy projection regression');

    expect(result.ok).toBe(true);
    expect(sqlite.prepare('SELECT content FROM knowledge WHERE id = ?').get(memory.id).content)
      .toBe('corrected legacy projection content');
  });

  test('direct correction clears stale persisted embeddings from the SQLite source and projection', async () => {
    const memory = await rememberMemory({ content: 'content before vector correction', type: 'fact' });
    const sqlite = (await getDb()).$client;
    const projection = sqlite.prepare(`SELECT id FROM knowledge
      WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`).get(memory.id) as { id: string };
    const vector = Buffer.from([0, 0, 128, 63, 0, 0, 0, 0]);
    sqlite.prepare(`UPDATE memories SET embedding_json='[1,0]', embedding=?, embedding_blob=?,
      embedding_model='fixture-model', embedding_dim=2 WHERE id=?`).run(vector, vector, memory.id);
    sqlite.prepare(`UPDATE knowledge SET embedding_json='[1,0]', embedding=?, embedding_blob=?,
      embedding_model='fixture-model', embedding_dim=2 WHERE id=?`).run(vector, vector, projection.id);

    expect((await correctMemory(memory.id, 'corrected content with a different meaning', 'stale vector regression')).ok).toBe(true);

    for (const [table, id] of [['memories', memory.id], ['knowledge', projection.id]] as const) {
      const row = sqlite.prepare(`SELECT embedding_json, embedding, embedding_blob, embedding_model, embedding_dim FROM ${table} WHERE id=?`).get(id);
      expect(row).toEqual({ embedding_json: null, embedding: null, embedding_blob: null, embedding_model: null, embedding_dim: null });
    }
  });

  test('direct correction replaces old source and projection terms in SQLite FTS', async () => {
    const oldTerm = 'squisholdtermcorrection';
    const newTerm = 'squishnewtermcorrection';
    const memory = await rememberMemory({ content: `The deployment uses ${oldTerm}.`, type: 'fact' });
    const sqlite = (await getDb()).$client;
    const projection = sqlite.prepare(`SELECT id FROM knowledge
      WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`).get(memory.id) as { id: string };
    const countMatch = (table: 'memories_fts' | 'knowledge_fts', rowId: number, term: string) =>
      sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table} MATCH ? AND rowid=?`).get(term, rowId).count as number;
    const sourceRowId = sqlite.prepare('SELECT rowid FROM memories WHERE id=?').get(memory.id).rowid as number;
    const projectionRowId = sqlite.prepare('SELECT rowid FROM knowledge WHERE id=?').get(projection.id).rowid as number;
    expect(countMatch('memories_fts', sourceRowId, oldTerm)).toBe(1);
    expect(countMatch('knowledge_fts', projectionRowId, oldTerm)).toBe(1);

    expect((await correctMemory(memory.id, `The deployment uses ${newTerm}.`, 'FTS correction regression')).ok).toBe(true);

    expect(countMatch('memories_fts', sourceRowId, oldTerm)).toBe(0);
    expect(countMatch('knowledge_fts', projectionRowId, oldTerm)).toBe(0);
    expect(countMatch('memories_fts', sourceRowId, newTerm)).toBe(1);
    expect(countMatch('knowledge_fts', projectionRowId, newTerm)).toBe(1);
  });

  test('concurrent corrections compare against the content they reviewed', async () => {
    const memory = await rememberMemory({ content: 'original concurrent claim', type: 'fact' });
    const results = await Promise.all([
      correctMemory(memory.id, 'first reviewed replacement', 'concurrent correction one'),
      correctMemory(memory.id, 'second reviewed replacement', 'concurrent correction two'),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.error === 'stale_content')).toHaveLength(1);

    const sqlite = (await getDb()).$client;
    const current = sqlite.prepare('SELECT content FROM memories WHERE id=?').get(memory.id).content as string;
    const correctionSnapshots = sqlite.prepare(`SELECT content FROM memory_snapshots
      WHERE memory_id=? AND snapshot_type='correction'`).all(memory.id) as Array<{ content: string }>;
    expect(current).not.toBe('original concurrent claim');
    expect(correctionSnapshots).toHaveLength(1);
    expect(correctionSnapshots[0].content).toBe('original concurrent claim');
  });

  test('correction retracts stale extracted facts and beliefs and requeues analysis', async () => {
    const { processMemoryAnalysisJobs } = await import('../../../core/memory/fact-extraction-worker.js');
    const source = await rememberMemory({
      content: 'I prefer SQLite because it is reliable. Additional context for durable memory correction analysis.',
      type: 'preference',
      project: '/edit-derived-invalidation',
    });
    const sqlite = (await getDb()).$client;
    const evidence = 'I prefer SQLite because it is reliable.';
    await processMemoryAnalysisJobs({ extract: async (text) => {
      const evidenceStart = text.indexOf(evidence);
      return {
        facts: [{
          content: 'The user prefers SQLite.', evidence, evidenceStart,
          evidenceEnd: evidenceStart + evidence.length, confidence: 0.8, entities: ['SQLite'],
        }],
        summary: 'Database preference.',
        entities: ['SQLite'],
      };
    } });
    const oldDerived = sqlite.prepare(`SELECT id FROM knowledge WHERE
      (knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=? AND json_extract(metadata, '$.derivation.kind')='extracted_fact')
      OR (knowledge_kind='belief' AND json_extract(metadata, '$.sourceMemoryId')=?)`).all(source.id, source.id) as Array<{ id: string }>;
    expect(oldDerived.length).toBeGreaterThanOrEqual(2);

    const correctedContent = 'I prefer PostgreSQL because it is reliable. Additional context for durable memory correction analysis.';
    await (await import('../../../core/knowledge/audit.js')).ensureAuditTable();
    sqlite.exec(`CREATE TRIGGER reject_source_correction_projection_audit BEFORE INSERT ON audit_log
      WHEN json_extract(NEW.details, '$.reason')='source_corrected'
      BEGIN SELECT RAISE(ABORT, 'source correction projection audit failure regression'); END;`);
    try {
      await expect(correctMemory(source.id, correctedContent, 'The original storage choice changed'))
        .rejects.toThrow('source correction projection audit failure regression');
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS reject_source_correction_projection_audit');
    }
    expect(sqlite.prepare('SELECT content FROM memories WHERE id=?').get(source.id).content)
      .toBe('I prefer SQLite because it is reliable. Additional context for durable memory correction analysis.');
    expect(sqlite.prepare("SELECT status FROM memory_analysis_jobs WHERE source_memory_id=?").get(source.id).status).toBe('completed');
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId')=?").get(source.id).count)
      .toBeGreaterThanOrEqual(3);

    const corrected = await correctMemory(source.id, correctedContent, 'The original storage choice changed');
    expect(corrected.ok).toBe(true);

    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM knowledge WHERE
      (knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=? AND json_extract(metadata, '$.derivation.kind')='extracted_fact')
      OR (knowledge_kind='belief' AND json_extract(metadata, '$.sourceMemoryId')=?)`).get(source.id, source.id).count).toBe(0);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM knowledge_edges
      WHERE edge_type='sourced_from' AND to_id=? AND recorded_to IS NOT NULL`).get(source.id).count).toBeGreaterThanOrEqual(1);
    expect(sqlite.prepare(`SELECT status, attempts, last_error_code FROM memory_analysis_jobs
      WHERE source_memory_id=? AND job_kind='analyze_memory'`).get(source.id))
      .toEqual({ status: 'pending', attempts: 0, last_error_code: null });
    expect(sqlite.prepare(`SELECT content FROM knowledge WHERE knowledge_kind='memory'
      AND json_extract(metadata, '$.sourceMemoryId')=? AND json_extract(metadata, '$.analysisJobId') IS NULL`).get(source.id).content)
      .toContain('PostgreSQL');
  });

  test('direct correction stays attached to its source memory and does not generalize to neighbors', async () => {
    const target = await rememberMemory({ content: 'The Atlas service runs in region north.', type: 'fact' });
    const neighbor = await rememberMemory({ content: 'The Atlas service uses PostgreSQL for sessions.', type: 'fact' });
    const sqlite = (await getDb()).$client;
    const neighborBefore = sqlite.prepare('SELECT content, metadata FROM memories WHERE id = ?').get(neighbor.id);

    const result = await correctMemory(target.id, 'The Atlas service runs in region west.', 'The source record was outdated');
    expect(result).toMatchObject({ ok: true, priorContent: 'The Atlas service runs in region north.' });
    expect(sqlite.prepare('SELECT content FROM memories WHERE id = ?').get(target.id).content)
      .toBe('The Atlas service runs in region west.');
    expect(sqlite.prepare('SELECT content, metadata FROM memories WHERE id = ?').get(neighbor.id))
      .toEqual(neighborBefore);

    const neighborProjection = sqlite.prepare(`
      SELECT content FROM knowledge
      WHERE knowledge_kind = 'memory' AND json_extract(metadata, '$.sourceMemoryId') = ?
    `).get(neighbor.id);
    expect(neighborProjection.content).toBe(neighborBefore.content);
  });

  test('correct refuses a tampered knowledge projection and leaves memory unchanged', async () => {
    const memory = await rememberMemory({ content: 'signed source memory', type: 'fact' });
    const sqlite = (await getDb()).$client;
    sqlite.prepare(`
      UPDATE knowledge SET content = ?
      WHERE knowledge_kind = 'memory' AND json_extract(metadata, '$.sourceMemoryId') = ?
    `).run('tampered projection', memory.id);

    const result = await correctMemory(memory.id, 'reviewed replacement', 'do not bless tampered projection');
    expect(result).toMatchObject({ ok: false, error: 'invalid_provenance' });
    expect(sqlite.prepare('SELECT content FROM memories WHERE id = ?').get(memory.id).content).toBe('signed source memory');
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_snapshots WHERE memory_id = ? AND snapshot_type = 'correction'").get(memory.id).count).toBe(0);
  });

  test('correct refuses a signed revision when the local signing key is unavailable', async () => {
    const memory = await rememberMemory({ content: 'signed memory without a correction yet', type: 'fact' });
    const signingKey = process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
    delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
    try {
      const result = await correctMemory(memory.id, 'replacement requiring a signature', 'key missing');
      expect(result).toMatchObject({ ok: false, error: 'provenance_signing_unavailable' });
      const sqlite = (await getDb()).$client;
      expect(sqlite.prepare('SELECT content FROM memories WHERE id = ?').get(memory.id).content).toBe('signed memory without a correction yet');
    } finally {
      if (signingKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = signingKey;
    }
  });

  test('encrypted memories reject plaintext proposals, approval, and corrections without changing ciphertext', async () => {
    const previousEnabled = process.env.SQUISH_ENCRYPTION_ENABLED;
    const previousPassphrase = process.env.SQUISH_ENCRYPTION_PASSPHRASE;
    process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'edit-workflow-encryption-test-only';
    try {
      const secretContent = 'encrypted source must never enter plaintext edit history';
      const encrypted = await rememberMemory({ content: secretContent, type: 'fact' });
      const sqlite = (await getDb()).$client;
      const sourceBefore = sqlite.prepare(`SELECT content, encrypted_content AS encryptedContent,
        encryption_nonce AS encryptionNonce, is_encrypted AS isEncrypted, version
        FROM memories WHERE id=?`).get(encrypted.id);
      expect(sourceBefore).toMatchObject({ content: '', isEncrypted: 1 });
      expect(sourceBefore.encryptedContent).toBeTruthy();
      expect(sourceBefore.encryptedContent).not.toContain(secretContent);

      await expect(createEditProposal(encrypted.id, 'plaintext proposal payload', 'test'))
        .rejects.toThrow('Edit proposals for encrypted memories are unavailable');
      const legacyProposalId = 'encrypted-memory-legacy-proposal';
      sqlite.prepare(`INSERT INTO memory_edit_proposals
        (id, project_id, user_id, memory_id, current_content, proposed_content, reason, status, version, created_at)
        VALUES (?, NULL, NULL, ?, '', ?, 'legacy plaintext proposal', 'pending', 1, ?)`)
        .run(legacyProposalId, encrypted.id, 'plaintext proposal payload', Math.floor(Date.now() / 1000));
      expect(await approveEditProposal(legacyProposalId)).toMatchObject({
        ok: false,
        error: 'encrypted_memory_unsupported',
      });
      expect(await correctMemory(encrypted.id, 'plaintext correction payload', 'test')).toMatchObject({
        ok: false,
        error: 'encrypted_memory_unsupported',
      });

      const sourceAfter = sqlite.prepare(`SELECT content, encrypted_content AS encryptedContent,
        encryption_nonce AS encryptionNonce, is_encrypted AS isEncrypted, version
        FROM memories WHERE id=?`).get(encrypted.id);
      expect(sourceAfter).toEqual(sourceBefore);
      const projection = sqlite.prepare(`SELECT content, encrypted_content AS encryptedContent,
        encryption_nonce AS encryptionNonce, is_encrypted AS isEncrypted
        FROM knowledge WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`)
        .get(encrypted.id);
      expect(projection.isEncrypted).toBe(1);
      expect(projection.content).toBe('');
      expect(projection.encryptedContent).toBeTruthy();
      expect(projection.encryptedContent).not.toContain(secretContent);
      const legacySnapshotId = 'legacy-encrypted-source-snapshot';
      sqlite.prepare(`INSERT INTO memory_snapshots
        (id, memory_id, snapshot_type, content, metadata, diff, created_at)
        VALUES (?, ?, 'correction', ?, '{}', ?, ?)`)
        .run(legacySnapshotId, encrypted.id, secretContent,
          JSON.stringify({ from: secretContent, to: 'plaintext corrected value' }), Math.floor(Date.now() / 1000));
      expect(await getMemoryHistory(encrypted.id)).toEqual([]);
      expect(await getMemorySnapshot(legacySnapshotId)).toBeNull();
      expect(sqlite.prepare('SELECT status FROM memory_edit_proposals WHERE id=?').get(legacyProposalId).status)
        .toBe('pending');
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_snapshots WHERE memory_id=?').get(encrypted.id).count)
        .toBe(1);
    } finally {
      if (previousEnabled === undefined) delete process.env.SQUISH_ENCRYPTION_ENABLED;
      else process.env.SQUISH_ENCRYPTION_ENABLED = previousEnabled;
      if (previousPassphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
      else process.env.SQUISH_ENCRYPTION_PASSPHRASE = previousPassphrase;
    }
  });

  test('edit SDK entry points stay withheld under strict trust without caller-bound authorization', async () => {
    const proposal = await createEditProposal(memoryId, 'strict expiry must not change this', 'strict expiry regression');
    const sqlite = (await getDb()).$client;
    sqlite.prepare('UPDATE memory_edit_proposals SET created_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60, proposal.id);
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    try {
      await expect(createEditProposal(memoryId, 'strict proposal', 'no caller ACL')).rejects.toBeInstanceOf(TrustBoundaryError);
      await expect(correctMemory(memoryId, 'strict correction', 'no caller ACL')).rejects.toBeInstanceOf(TrustBoundaryError);
      await expect(getEditProposals({ memoryId })).rejects.toBeInstanceOf(TrustBoundaryError);
      await expect(expireStaleEditProposals()).rejects.toBeInstanceOf(TrustBoundaryError);
      expect(sqlite.prepare('SELECT status FROM memory_edit_proposals WHERE id = ?').get(proposal.id).status).toBe('pending');
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  });

  test('strict correction is owner-only, v3-signed, atomic, and audited', async () => {
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
    };
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'correction-owner';
    try {
      const owned = await rememberMemory({ content: 'signed before correction', type: 'fact' });
      const sqlite = (await getDb()).$client;
      const ownedProjection = sqlite.prepare(`SELECT id FROM knowledge
        WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`).get(owned.id) as { id: string };
      const vector = Buffer.from([0, 0, 128, 63, 0, 0, 0, 0]);
      sqlite.prepare(`UPDATE memories SET embedding_json='[1,0]', embedding=?, embedding_blob=?,
        embedding_model='fixture-model', embedding_dim=2 WHERE id=?`).run(vector, vector, owned.id);
      sqlite.prepare(`UPDATE knowledge SET embedding_json='[1,0]', embedding=?, embedding_blob=?,
        embedding_model='fixture-model', embedding_dim=2 WHERE id=?`).run(vector, vector, ownedProjection.id);
      const strictValidFrom = 1_704_067_200;
      const strictValidTo = 2_208_988_800;
      const strictExpiresAt = 2_398_291_200;
      sqlite.prepare('UPDATE memories SET valid_from=?, valid_to=?, expires_at=? WHERE id=?').run(strictValidFrom, strictValidTo, strictExpiresAt, owned.id);
      sqlite.prepare('UPDATE knowledge SET valid_from=?, valid_to=? WHERE id=?').run(strictValidFrom, strictValidTo, ownedProjection.id);
      const strictPrior = sqlite.prepare('SELECT valid_from, valid_to, recorded_at FROM memories WHERE id=?').get(owned.id);
      const { findOrCreateCluster, getClusterForMemory, clearClusters } = await import('../../../core/clustering/cluster-engine.js');
      clearClusters();
      await findOrCreateCluster(owned.id, [1, 0, 0]);
      const result = await correctMemory(owned.id, 'signed after correction', 'verified correction', 'correction-owner');
      expect(result).toMatchObject({ ok: true, priorContent: 'signed before correction' });
      expect(result).toMatchObject({
        priorValidFrom: new Date(strictValidFrom * 1000).toISOString(),
        priorValidTo: new Date(strictValidTo * 1000).toISOString(),
        priorRecordedAt: new Date(strictPrior.recorded_at * 1000).toISOString(),
        priorExpiresAt: new Date(strictExpiresAt * 1000).toISOString(),
      });
      expect(getClusterForMemory(owned.id)).toBeNull();
      const row = sqlite.prepare(`SELECT content, metadata, valid_from AS validFrom, valid_to AS validTo,
        expires_at AS expiresAt,
        user_id AS userId, team_id AS teamId, project_id AS projectId, type,
        embedding_json, embedding, embedding_blob, embedding_model, embedding_dim FROM memories WHERE id=?`).get(owned.id);
      expect(row.content).toBe('signed after correction');
      expect(row).toMatchObject({ validFrom: strictValidFrom, validTo: strictValidTo, expiresAt: strictExpiresAt });
      expect(row).toMatchObject({ embedding_json: null, embedding: null, embedding_blob: null, embedding_model: null, embedding_dim: null });
      expect(JSON.parse(row.metadata).__squishProvenance.version).toBe(3);
      expect(verifyMemoryProvenance({ content: row.content, projectId: row.projectId, type: row.type,
        ownerId: row.userId, teamId: row.teamId, sourceMemoryId: owned.id, metadata: JSON.parse(row.metadata) })).toBe(true);
      const projection = sqlite.prepare(`SELECT content, project_id AS projectId, knowledge_type AS type, metadata,
        valid_from AS validFrom, valid_to AS validTo,
        embedding_json, embedding, embedding_blob, embedding_model, embedding_dim
        FROM knowledge WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`).get(owned.id);
      expect(projection.content).toBe('signed after correction');
      expect(projection).toMatchObject({ validFrom: strictValidFrom, validTo: strictValidTo });
      expect(projection).toMatchObject({ embedding_json: null, embedding: null, embedding_blob: null, embedding_model: null, embedding_dim: null });
      expect(verifyMemoryProvenance({ content: projection.content, projectId: projection.projectId, type: projection.type,
        ownerId: row.userId, teamId: row.teamId, sourceMemoryId: owned.id, metadata: JSON.parse(projection.metadata) })).toBe(true);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_snapshots WHERE memory_id=? AND snapshot_type='correction'").get(owned.id).count).toBe(1);
      const strictSnapshot = sqlite.prepare(`SELECT content, metadata FROM memory_snapshots WHERE memory_id=? AND snapshot_type='correction'`).get(owned.id);
      expect(JSON.parse(strictSnapshot.metadata)).toMatchObject({
        kind: 'correction_snapshot_v3',
        priorValidFrom: new Date(strictValidFrom * 1000).toISOString(),
        priorValidTo: new Date(strictValidTo * 1000).toISOString(),
        priorRecordedAt: new Date(strictPrior.recorded_at * 1000).toISOString(),
        priorExpiresAt: new Date(strictExpiresAt * 1000).toISOString(),
      });
      expect(sqlite.prepare("SELECT decision, reason FROM trust_audit_log WHERE resource_hash=? ORDER BY created_at DESC LIMIT 1")
        .get((await import('node:crypto')).createHash('sha256').update(owned.id).digest('hex'))).toEqual({ decision: 'allow', reason: 'memory_correct' });
      const { getStrictCorrectionHistory } = await import('../../../core/snapshots/retrieval.js');
      const returnedStrictHistory = await getStrictCorrectionHistory(owned.id, 'correction-owner');
      expect(returnedStrictHistory.entries[0]).toMatchObject({
        priorValidFrom: new Date(strictValidFrom * 1000).toISOString(),
        priorValidTo: new Date(strictValidTo * 1000).toISOString(),
        priorRecordedAt: new Date(strictPrior.recorded_at * 1000).toISOString(),
        priorExpiresAt: new Date(strictExpiresAt * 1000).toISOString(),
        temporalStateComplete: true,
      });
      expect(returnedStrictHistory.temporalStateComplete).toBe(true);

      const historyMemory = await rememberMemory({ content: 'revision zero', type: 'fact' });
      const firstRevision = await correctMemory(historyMemory.id, 'revision one', 'first correction', 'correction-owner');
      const secondRevision = await correctMemory(historyMemory.id, 'revision two', 'second correction', 'correction-owner');
      expect(firstRevision).toMatchObject({ ok: true, priorContent: 'revision zero' });
      expect(secondRevision).toMatchObject({ ok: true, priorContent: 'revision one' });
      const historySnapshots = sqlite.prepare(`SELECT id, content, metadata FROM memory_snapshots
        WHERE memory_id=? AND snapshot_type='correction'`).all(historyMemory.id) as Array<{ id: string; content: string; metadata: string }>;
      expect(historySnapshots.map((snapshot) => snapshot.content).sort()).toEqual(['revision one', 'revision zero'].sort());
      expect(historySnapshots.map((snapshot) => JSON.parse(snapshot.metadata).reasoning).sort())
        .toEqual(['first correction', 'second correction'].sort());
      const historyRow = sqlite.prepare('SELECT content, metadata, user_id AS userId, team_id AS teamId, project_id AS projectId, type FROM memories WHERE id=?').get(historyMemory.id);
      expect(historyRow.content).toBe('revision two');
      expect(verifyMemoryProvenance({ content: historyRow.content, projectId: historyRow.projectId, type: historyRow.type,
        ownerId: historyRow.userId, teamId: historyRow.teamId, sourceMemoryId: historyMemory.id, metadata: JSON.parse(historyRow.metadata) })).toBe(true);
      const historyProjection = sqlite.prepare(`SELECT content, project_id AS projectId, knowledge_type AS type, metadata
        FROM knowledge WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`).get(historyMemory.id);
      expect(historyProjection.content).toBe('revision two');
      expect(verifyMemoryProvenance({ content: historyProjection.content, projectId: historyProjection.projectId,
        type: historyProjection.type, ownerId: historyRow.userId, teamId: historyRow.teamId,
        sourceMemoryId: historyMemory.id, metadata: JSON.parse(historyProjection.metadata) })).toBe(true);

      const verifiedHistory = await getStrictCorrectionHistory(historyMemory.id, 'correction-owner');
      expect(verifiedHistory.complete).toBe(true);
      expect(verifiedHistory.unverifiedLegacyCount).toBe(0);
      expect(verifiedHistory.entries.map((entry) => [entry.priorContent, entry.correctedContent, entry.reason]))
        .toEqual([
          ['revision zero', 'revision one', 'first correction'],
          ['revision one', 'revision two', 'second correction'],
        ]);
      await expect(getStrictCorrectionHistory(historyMemory.id, 'different-principal'))
        .rejects.toBeInstanceOf(TrustBoundaryError);
      const projectionToTamper = sqlite.prepare(`SELECT id, content FROM knowledge
        WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=? LIMIT 1`)
        .get(historyMemory.id) as { id: string; content: string };
      sqlite.prepare('UPDATE knowledge SET content=? WHERE id=?').run('tampered current projection', projectionToTamper.id);
      await expect(getStrictCorrectionHistory(historyMemory.id, 'correction-owner'))
        .rejects.toThrow('valid source and projection provenance');
      sqlite.prepare('UPDATE knowledge SET content=? WHERE id=?').run(projectionToTamper.content, projectionToTamper.id);
      const snapshotToTamper = historySnapshots[0];
      sqlite.prepare('UPDATE memory_snapshots SET content=? WHERE id=?').run('tampered correction history', snapshotToTamper.id);
      await expect(getStrictCorrectionHistory(historyMemory.id, 'correction-owner'))
        .rejects.toThrow('tampered correction snapshot');
      sqlite.prepare('UPDATE memory_snapshots SET content=? WHERE id=?').run(snapshotToTamper.content, snapshotToTamper.id);
      sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content, metadata, diff, created_at)
        VALUES ('legacy-correction-history', ?, 'correction', 'legacy unsigned snapshot', '{}', ?, ?)`)
        .run(historyMemory.id, JSON.stringify({ from: 'legacy unsigned snapshot', to: 'revision zero' }), Math.floor(Date.now() / 1000));
      const historyWithLegacy = await getStrictCorrectionHistory(historyMemory.id, 'correction-owner');
      expect(historyWithLegacy.complete).toBe(false);
      expect(historyWithLegacy.unverifiedLegacyCount).toBe(1);
      expect(historyWithLegacy.entries).toHaveLength(2);
      const historyAudit = sqlite.prepare(`SELECT decision, reason FROM trust_audit_log
        WHERE resource_hash=? AND asset_type='correction_history' ORDER BY created_at DESC LIMIT 1`)
        .get((await import('node:crypto')).createHash('sha256').update(historyMemory.id).digest('hex'));
      expect(historyAudit).toEqual({ decision: 'allow', reason: 'memory_history_read' });

      await expect(correctMemory(owned.id, 'forged identity revision', 'caller mismatch', 'different-principal'))
        .rejects.toBeInstanceOf(TrustBoundaryError);
      expect(sqlite.prepare("SELECT decision, reason FROM trust_audit_log WHERE resource_hash=? ORDER BY created_at DESC LIMIT 1")
        .get((await import('node:crypto')).createHash('sha256').update(owned.id).digest('hex'))).toEqual({ decision: 'deny', reason: 'caller_mismatch' });
      process.env.SQUISH_TRUST_POLICY = 'local-compatible';
      const stranger = await rememberMemory({ content: 'unowned signed memory', type: 'fact', user: 'another-owner' });
      process.env.SQUISH_TRUST_POLICY = 'strict';
      await expect(correctMemory(stranger.id, 'forged replacement', 'not authorized', 'correction-owner'))
        .rejects.toBeInstanceOf(TrustBoundaryError);
      expect(sqlite.prepare('SELECT content FROM memories WHERE id=?').get(stranger.id).content).toBe('unowned signed memory');
      expect(sqlite.prepare("SELECT decision, reason FROM trust_audit_log WHERE resource_hash=? ORDER BY created_at DESC LIMIT 1")
        .get((await import('node:crypto')).createHash('sha256').update(stranger.id).digest('hex'))).toEqual({ decision: 'deny', reason: 'strict_write' });

      const tampered = await rememberMemory({ content: 'strict source before tamper', type: 'fact' });
      sqlite.prepare(`UPDATE knowledge SET content='tampered strict projection'
        WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`).run(tampered.id);
      await expect(correctMemory(tampered.id, 'must not re-sign tampered projection', 'projection check', 'correction-owner'))
        .rejects.toBeInstanceOf(TrustBoundaryError);
      expect(sqlite.prepare('SELECT content FROM memories WHERE id=?').get(tampered.id).content).toBe('strict source before tamper');
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_snapshots WHERE memory_id=? AND snapshot_type='correction'").get(tampered.id).count).toBe(0);

      const auditFailure = await rememberMemory({ content: 'source before audit failure', type: 'fact' });
      sqlite.exec(`CREATE TRIGGER correction_audit_failure BEFORE INSERT ON trust_audit_log
        WHEN NEW.reason='memory_correct' BEGIN SELECT RAISE(ABORT, 'correction audit failure regression'); END;`);
      try {
        await expect(correctMemory(auditFailure.id, 'must roll back without audit', 'audit rollback', 'correction-owner'))
          .rejects.toThrow('correction audit failure regression');
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS correction_audit_failure');
      }
      expect(sqlite.prepare('SELECT content FROM memories WHERE id=?').get(auditFailure.id).content).toBe('source before audit failure');
      expect(sqlite.prepare(`SELECT content FROM knowledge WHERE knowledge_kind='memory'
        AND json_extract(metadata, '$.sourceMemoryId')=?`).get(auditFailure.id).content).toBe('source before audit failure');
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_snapshots WHERE memory_id=? AND snapshot_type='correction'").get(auditFailure.id).count).toBe(0);
      expect(row.userId).toBeTruthy();
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
    }
  });

  test('strict correction resolves the caller external ID before a colliding email', async () => {
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
    };
    const callerPrincipal = 'correction-collision@example.test';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = callerPrincipal;
    try {
      const sqlite = (await getDb()).$client;
      sqlite.prepare('INSERT INTO users (id, external_id, email) VALUES (?, ?, ?)')
        .run('correction-email-owner', 'correction-email-owner-principal', callerPrincipal);
      sqlite.prepare('INSERT INTO users (id, external_id, email) VALUES (?, ?, ?)')
        .run('correction-external-principal', callerPrincipal, 'correction-principal@example.test');
      const legacyResolution = sqlite.prepare('SELECT id FROM users WHERE id=? OR external_id=? OR email=? LIMIT 1')
        .get(callerPrincipal, callerPrincipal, callerPrincipal) as { id: string };
      expect(legacyResolution.id).toBe('correction-email-owner');

      const memory = await rememberMemory({ content: 'before collision-safe correction', type: 'fact' });
      const corrected = await correctMemory(memory.id, 'after collision-safe correction', 'verified principal resolution');
      expect(corrected).toMatchObject({ ok: true, priorContent: 'before collision-safe correction' });
      expect(sqlite.prepare('SELECT content FROM memories WHERE id=?').get(memory.id))
        .toEqual({ content: 'after collision-safe correction' });
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
    }
  });

  test('strict correction preserves encryption and records authenticated encrypted history', async () => {
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      encryptionEnabled: process.env.SQUISH_ENCRYPTION_ENABLED,
      passphrase: process.env.SQUISH_ENCRYPTION_PASSPHRASE,
    };
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'encrypted-correction-owner';
    process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'strict-edit-workflow-test-only';
    try {
      const memory = await rememberMemory({ content: 'strict encrypted source', type: 'fact' });
      const sqlite = (await getDb()).$client;
      const before = sqlite.prepare(`SELECT content, encrypted_content AS encryptedContent,
        encryption_nonce AS encryptionNonce, version FROM memories WHERE id=?`).get(memory.id);
      await expect(correctMemory(memory.id, 'plaintext strict correction', 'verified encrypted correction', 'encrypted-correction-owner'))
        .resolves.toMatchObject({ ok: true, priorContent: 'strict encrypted source' });
      const after = sqlite.prepare(`SELECT content, encrypted_content AS encryptedContent,
        encryption_nonce AS encryptionNonce, version FROM memories WHERE id=?`).get(memory.id);
      expect(after.content).toBe('');
      expect(after.encryptedContent).toBeTruthy();
      expect(after.encryptedContent).not.toContain('plaintext strict correction');
      expect(after.encryptedContent).not.toBe(before.encryptedContent);
      expect(after.encryptionNonce).not.toBe(before.encryptionNonce);
      expect(after.version).toBe(before.version + 1);
      const snapshot = sqlite.prepare(`SELECT content, encrypted_payload AS encryptedPayload,
        encrypted_nonce AS encryptedNonce FROM memory_snapshots
        WHERE memory_id=? AND snapshot_type='correction'`).get(memory.id);
      expect(snapshot.content).toBe('');
      expect(snapshot.encryptedPayload).toBeTruthy();
      expect(snapshot.encryptedPayload).not.toContain('strict encrypted source');
      expect(await getStrictCorrectionHistory(memory.id, 'encrypted-correction-owner'))
        .toMatchObject({ complete: true, entries: [{
          priorContent: 'strict encrypted source',
          correctedContent: 'plaintext strict correction',
          reason: 'verified encrypted correction',
        }] });
      expect(sqlite.prepare(`SELECT decision, reason FROM trust_audit_log
        WHERE resource_hash=? AND reason='memory_correct' ORDER BY created_at DESC LIMIT 1`)
        .get((await import('node:crypto')).createHash('sha256').update(memory.id).digest('hex')))
        .toEqual({ decision: 'allow', reason: 'memory_correct' });
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
      if (previous.encryptionEnabled === undefined) delete process.env.SQUISH_ENCRYPTION_ENABLED;
      else process.env.SQUISH_ENCRYPTION_ENABLED = previous.encryptionEnabled;
      if (previous.passphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
      else process.env.SQUISH_ENCRYPTION_PASSPHRASE = previous.passphrase;
    }
  });

  test('strict correction removes source-derived facts and beliefs and retracts their FTS terms', async () => {
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
    };
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-derived-correction-owner';
    try {
      const oldTerm = 'squisholdstrictderivedterm';
      const newTerm = 'squishnewstrictderivedterm';
      const source = await rememberMemory({ content: `The service uses ${oldTerm}.`, type: 'fact' });
      const sqlite = (await getDb()).$client;
      const factId = `strict-derived-fact-${source.id}`;
      const beliefId = `strict-derived-belief-${source.id}`;
      const derivedMetadata = (jobId: string) => JSON.stringify({
        sourceMemoryId: source.id,
        analysisJobId: jobId,
        derivation: { kind: 'extracted_fact' },
      });
      sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata)
        VALUES (?, ?, 'memory', 'fact', ?, ?), (?, ?, 'belief', 'fact', ?, ?)`)
        .run(factId, source.projectId ?? null, `Derived fact mentions ${oldTerm}.`, derivedMetadata(`job-${factId}`),
          beliefId, source.projectId ?? null, `Derived belief mentions ${oldTerm}.`, derivedMetadata(`job-${beliefId}`));
      sqlite.prepare(`INSERT INTO knowledge_edges
        (id, from_id, from_kind, to_id, to_kind, edge_type, metadata)
        VALUES (?, ?, 'knowledge', ?, 'knowledge', 'sourced_from', '{}')`)
        .run(`strict-derived-edge-${source.id}`, beliefId, source.id);
      const derivedRows = sqlite.prepare('SELECT id, rowid FROM knowledge WHERE id IN (?, ?)').all(factId, beliefId) as Array<{ id: string; rowid: number }>;
      const countMatch = (rowId: number, term: string) =>
        sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_fts WHERE knowledge_fts MATCH ? AND rowid=?').get(term, rowId).count as number;
      expect(derivedRows).toHaveLength(2);
      for (const row of derivedRows) expect(countMatch(row.rowid, oldTerm)).toBe(1);

      const result = await correctMemory(source.id, `The service uses ${newTerm}.`, 'strict derived cleanup regression', 'strict-derived-correction-owner');

      expect(result.ok).toBe(true);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge WHERE id IN (?, ?)').get(factId, beliefId).count).toBe(0);
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM knowledge_edges
        WHERE id=? AND recorded_to IS NOT NULL`).get(`strict-derived-edge-${source.id}`).count).toBe(1);
      for (const row of derivedRows) expect(countMatch(row.rowid, oldTerm)).toBe(0);
      const sourceRow = sqlite.prepare('SELECT rowid FROM memories WHERE id=?').get(source.id) as { rowid: number };
      const sourceProjection = sqlite.prepare(`SELECT rowid FROM knowledge WHERE knowledge_kind='memory'
        AND json_extract(metadata, '$.sourceMemoryId')=?`).get(source.id) as { rowid: number };
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories_fts WHERE memories_fts MATCH ? AND rowid=?').get(oldTerm, sourceRow.rowid).count).toBe(0);
      expect(countMatch(sourceProjection.rowid, oldTerm)).toBe(0);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories_fts WHERE memories_fts MATCH ? AND rowid=?').get(newTerm, sourceRow.rowid).count).toBe(1);
      expect(countMatch(sourceProjection.rowid, newTerm)).toBe(1);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
    }
  });

  test('approve rejects stale content when memory changed', async () => {
    const proposal = await createEditProposal(memoryId, 'stale target', 'will fail');
    const { getDb } = await import('../../../db/index.js');
    const sqlite = (await getDb()).$client;
    sqlite.prepare('UPDATE memories SET content = ? WHERE id = ?').run('changed under it', memoryId);

    const result = await approveEditProposal(proposal.id);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('stale_content');
  });

  test('expire marks old pending proposals as expired', async () => {
    const proposal = await createEditProposal(memoryId, 'old proposal', 'expires');
    const { getDb } = await import('../../../db/index.js');
    const sqlite = (await getDb()).$client;
    const oldCutoff = Math.floor(Date.now() / 1000) - 20 * 24 * 60 * 60;
    sqlite.prepare('UPDATE memory_edit_proposals SET created_at = ? WHERE id = ?').run(oldCutoff, proposal.id);

    const expired = await expireStaleEditProposals(14);
    expect(expired).toBeGreaterThanOrEqual(1);

    const row = sqlite.prepare('SELECT status FROM memory_edit_proposals WHERE id = ?').get(proposal.id);
    expect(row.status).toBe('expired');
  });

  test('rejects generated context from proposal, approval, and direct correction paths', async () => {
    const echo = '# Session bootstrap\r\n\r\n## Verified memories\r\n- [fact] The service is active (memory:01234567-89ab-cdef-0123-456789abcdef)';
    await expect(createEditProposal(memoryId, echo, 'echo rejection'))
      .rejects.toThrow('Generated context cannot be stored as an edit proposal');
    await expect(correctMemory(memoryId, echo, 'echo rejection'))
      .rejects.toThrow('Generated context cannot replace stored memory');

    const proposal = await createEditProposal(memoryId, 'safe pending revision', 'legacy proposal check');
    const sqlite = (await getDb()).$client;
    sqlite.prepare('UPDATE memory_edit_proposals SET proposed_content = ? WHERE id = ?').run(echo, proposal.id);
    const before = sqlite.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId).content;
    const result = await approveEditProposal(proposal.id);
    expect(result).toEqual({ ok: false, error: 'generated_context', detail: 'generated context cannot replace a stored memory' });
    expect(sqlite.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId).content).toBe(before);
  });
});
