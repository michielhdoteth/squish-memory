import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-strict-encrypted-history-'));
const envKeys = [
  'SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID',
  'SQUISH_PROVENANCE_PRIVATE_KEY', 'SQUISH_PROVENANCE_PUBLIC_KEY', 'SQUISH_PROVENANCE_KEY_ID',
  'SQUISH_ENCRYPTION_ENABLED', 'SQUISH_ENCRYPTION_PASSPHRASE',
] as const;
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_TRUST_POLICY = 'strict';
process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-encrypted-history-owner';
process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'strict-encrypted-history-test-only';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-encrypted-history-test';

const { getDb, resetDb } = await import('../../db/index.js');
const { rememberMemory } = await import('../../core/memory/memories.js');
const { correctMemory } = await import('../../core/memory/edit-workflow.js');
const { getStrictCorrectionHistory } = await import('../../core/snapshots/retrieval.js');
const { TrustBoundaryError } = await import('../../core/acl/trust-policy.js');
const { signMemoryProvenance } = await import('../../core/acl/provenance.js');

afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('strict encrypted correction history', () => {
  beforeAll(() => resetDb());

  test('returns empty owner history for an encrypted memory with no correction snapshots', async () => {
    const secret = 'strict encrypted history must remain ciphertext';
    const memory = await rememberMemory({ content: secret, type: 'fact' });
    const db = await getDb();
    const source = db.$client.prepare(`SELECT content, encrypted_content AS encryptedContent,
      is_encrypted AS isEncrypted FROM memories WHERE id=?`).get(memory.id) as {
        content: string; encryptedContent: string; isEncrypted: number;
      };

    expect(source.content).toBe('');
    expect(source.isEncrypted).toBe(1);
    expect(source.encryptedContent).toBeTruthy();
    expect(source.encryptedContent).not.toContain(secret);
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM memory_snapshots WHERE memory_id=?').get(memory.id))
      .toEqual({ count: 0 });

    await expect(getStrictCorrectionHistory(memory.id, 'strict-encrypted-history-owner'))
      .resolves.toMatchObject({ entries: [], complete: true });
    expect(db.$client.prepare(`SELECT decision, reason FROM trust_audit_log
      WHERE resource_hash=? AND asset_type='correction_history' ORDER BY created_at DESC LIMIT 1`)
      .get((await import('node:crypto')).createHash('sha256').update(memory.id).digest('hex')))
      .toEqual({ decision: 'allow', reason: 'memory_history_read' });
  });

  test('denies signed legacy correction snapshots after the source is encrypted', async () => {
    const priorSecret = 'plaintext legacy correction snapshot must stay private';
    const memory = await rememberMemory({ content: 'current encrypted source', type: 'fact' });
    const db = await getDb();
    const source = db.$client.prepare(`SELECT content, metadata, project_id AS projectId, type,
      user_id AS ownerId FROM memories WHERE id=?`).get(memory.id) as {
        content: string; metadata: string; projectId: string | null; type: string; ownerId: string;
      };
    const { verifyMemoryProvenance } = await import('../../core/acl/provenance.js');
    const sourceMetadata = JSON.parse(source.metadata) as Record<string, unknown>;
    const encryptedSourceSignature = signMemoryProvenance({
      content: '', projectId: source.projectId, type: source.type, ownerId: source.ownerId,
      teamId: null, sourceMemoryId: memory.id, metadata: sourceMetadata,
    });
    expect(encryptedSourceSignature?.version).toBe(3);
    const encryptedSourceMetadata = JSON.stringify({ ...sourceMetadata, __squishProvenance: encryptedSourceSignature });
    db.$client.prepare(`UPDATE memories SET content='', is_encrypted=1, encrypted_content=?,
      encryption_nonce='fixture-nonce', metadata=? WHERE id=?`)
      .run('fixture-ciphertext', encryptedSourceMetadata, memory.id);

    const projection = db.$client.prepare(`SELECT id, content, metadata, project_id AS projectId,
      knowledge_type AS type FROM knowledge
      WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`).get(memory.id) as {
        id: string; content: string; metadata: string; projectId: string | null; type: string;
      };
    const projectionMetadata = JSON.parse(projection.metadata) as Record<string, unknown>;
    const encryptedProjectionSignature = signMemoryProvenance({
      content: '', projectId: projection.projectId, type: projection.type, ownerId: source.ownerId,
      teamId: null, sourceMemoryId: memory.id, metadata: projectionMetadata,
    });
    expect(encryptedProjectionSignature?.version).toBe(3);
    db.$client.prepare('UPDATE knowledge SET content=?, metadata=? WHERE id=?')
      .run('', JSON.stringify({ ...projectionMetadata, __squishProvenance: encryptedProjectionSignature }), projection.id);
    expect(verifyMemoryProvenance({ content: '', projectId: source.projectId, type: source.type,
      ownerId: source.ownerId, teamId: null, sourceMemoryId: memory.id,
      metadata: JSON.parse(encryptedSourceMetadata) })).toBe(true);

    const snapshotId = `legacy-encrypted-correction-${memory.id}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const reason = 'correction before encryption';
    const correctedContent = '';
    const snapshotMetadata: Record<string, unknown> = {
      kind: 'correction_snapshot_v1',
      sourceId: `sha256:${createHash('sha256').update(JSON.stringify([
        snapshotId, memory.id, 'correction', createdAt, reason, priorSecret, correctedContent,
      ])).digest('hex')}`,
      observedAt: new Date(createdAt * 1000).toISOString(),
      reasoning: reason,
    };
    const snapshotSignature = signMemoryProvenance({
      content: priorSecret, projectId: source.projectId, type: 'correction_snapshot',
      ownerId: source.ownerId, teamId: null, sourceMemoryId: memory.id, metadata: snapshotMetadata,
    });
    expect(snapshotSignature?.version).toBe(3);
    db.$client.prepare(`INSERT INTO memory_snapshots
      (id, memory_id, snapshot_type, content, metadata, diff, created_at)
      VALUES (?, ?, 'correction', ?, ?, ?, ?)`)
      .run(snapshotId, memory.id, priorSecret,
        JSON.stringify({ ...snapshotMetadata, __squishProvenance: snapshotSignature }),
        JSON.stringify({ from: priorSecret, to: correctedContent }), createdAt);

    await expect(getStrictCorrectionHistory(memory.id, 'strict-encrypted-history-owner'))
      .rejects.toBeInstanceOf(TrustBoundaryError);
    expect(db.$client.prepare(`SELECT decision, reason FROM trust_audit_log
      WHERE resource_hash=? AND asset_type='correction_history' ORDER BY created_at DESC LIMIT 1`)
      .get(createHash('sha256').update(memory.id).digest('hex')))
      .toEqual({ decision: 'deny', reason: 'memory_history_read' });
  });

  test('corrects encrypted source and projection atomically and returns only owner history', async () => {
    const before = 'encrypted correction prior secret';
    const after = 'encrypted correction replacement secret';
    const memory = await rememberMemory({ content: before, type: 'fact' });
    const result = await correctMemory(memory.id, after, 'user correction', 'strict-encrypted-history-owner');
    expect(result.ok).toBe(true);
    const db = await getDb();
    const source = db.$client.prepare(`SELECT content, encrypted_content AS ciphertext, encryption_nonce AS nonce
      FROM memories WHERE id=?`).get(memory.id) as { content: string; ciphertext: string; nonce: string };
    expect(source.content).toBe('');
    expect((await import('../../core/security/encrypt.js')).decrypt(source.ciphertext, source.nonce)).toBe(after);
    const projection = db.$client.prepare(`SELECT content, encrypted_content AS ciphertext, encryption_nonce AS nonce
      FROM knowledge WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`).get(memory.id) as { content: string; ciphertext: string; nonce: string };
    expect(projection.content).toBe('');
    expect((await import('../../core/security/encrypt.js')).decrypt(projection.ciphertext, projection.nonce)).toBe(after);
    const snapshot = db.$client.prepare(`SELECT content, metadata, diff, encrypted_payload AS payload,
      encrypted_nonce AS nonce, encryption_format AS format FROM memory_snapshots WHERE memory_id=?`).get(memory.id) as { content: string; metadata: string; diff: string | null; payload: string; nonce: string; format: string };
    expect(snapshot.content).toBe('');
    expect(snapshot.metadata).not.toContain(before);
    expect(snapshot.diff).toBeNull();
    expect(snapshot.payload).not.toContain(before);
    expect(snapshot.format).toBe('squish-aesgcm-aad-v1');
    const history = await getStrictCorrectionHistory(memory.id, 'strict-encrypted-history-owner');
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.priorContent).toBe(before);
    expect(history.entries[0]?.correctedContent).toBe(after);
    await expect(getStrictCorrectionHistory(memory.id, 'someone-else')).rejects.toThrow('does not match the authenticated principal');
  });

  test('rolls back encrypted correction snapshot and source when a projection write fails', async () => {
    const prior = 'rollback keeps encrypted source unchanged';
    const memory = await rememberMemory({ content: prior, type: 'fact' });
    const db = await getDb();
    db.$client.exec(`CREATE TRIGGER fail_encrypted_correction_projection BEFORE UPDATE OF encrypted_content ON knowledge
      WHEN json_extract(NEW.metadata, '$.sourceMemoryId') = '${memory.id}'
      BEGIN SELECT RAISE(ABORT, 'injected encrypted projection failure'); END`);
    await expect(correctMemory(memory.id, 'must not commit', 'rollback test', 'strict-encrypted-history-owner'))
      .rejects.toThrow('injected encrypted projection failure');
    db.$client.exec('DROP TRIGGER fail_encrypted_correction_projection');
    const source = db.$client.prepare(`SELECT content, encrypted_content AS ciphertext,
      encryption_nonce AS nonce FROM memories WHERE id=?`).get(memory.id) as { content: string; ciphertext: string; nonce: string };
    expect(source.content).toBe('');
    expect((await import('../../core/security/encrypt.js')).decrypt(source.ciphertext, source.nonce)).toBe(prior);
    expect(db.$client.prepare('SELECT id FROM memory_snapshots WHERE memory_id=?').all(memory.id)).toHaveLength(0);
  });

  test('fails closed for wrong or missing keys and rejects tampered or transplanted snapshot envelopes', async () => {
    const first = await rememberMemory({ content: 'first encrypted source', type: 'fact' });
    const second = await rememberMemory({ content: 'second encrypted source', type: 'fact' });
    await correctMemory(first.id, 'first replacement', 'correction', 'strict-encrypted-history-owner');
    await correctMemory(second.id, 'second replacement', 'correction', 'strict-encrypted-history-owner');
    const db = await getDb();
    const rows = db.$client.prepare(`SELECT id, memory_id AS memoryId, encrypted_payload AS payload,
      encrypted_nonce AS nonce FROM memory_snapshots WHERE memory_id IN (?, ?) ORDER BY memory_id`)
      .all(first.id, second.id) as Array<{ id: string; memoryId: string; payload: string; nonce: string }>;
    const original = rows.find((row) => row.memoryId === first.id)!;
    const target = rows.find((row) => row.memoryId === second.id)!;
    const originalPassphrase = process.env.SQUISH_ENCRYPTION_PASSPHRASE;
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'incorrect-key';
    await expect(getStrictCorrectionHistory(first.id, 'strict-encrypted-history-owner')).rejects.toBeInstanceOf(TrustBoundaryError);
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = '';
    await expect(getStrictCorrectionHistory(first.id, 'strict-encrypted-history-owner')).rejects.toBeInstanceOf(TrustBoundaryError);
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = originalPassphrase;
    db.$client.prepare('UPDATE memory_snapshots SET encrypted_payload=? WHERE id=?').run(original.payload.slice(0, -4) + 'AAAA', original.id);
    await expect(getStrictCorrectionHistory(first.id, 'strict-encrypted-history-owner')).rejects.toBeInstanceOf(TrustBoundaryError);
    db.$client.prepare('UPDATE memory_snapshots SET encrypted_payload=? WHERE id=?').run(original.payload, original.id);
    db.$client.prepare('UPDATE memory_snapshots SET encrypted_payload=?, encrypted_nonce=? WHERE id=?')
      .run(original.payload, original.nonce, target.id);
    await expect(getStrictCorrectionHistory(second.id, 'strict-encrypted-history-owner')).rejects.toBeInstanceOf(TrustBoundaryError);
  });

  test('rejects a valid encrypted source transplanted across authenticated memory identities', async () => {
    const first = await rememberMemory({ content: 'first authenticated source', type: 'fact' });
    const second = await rememberMemory({ content: 'second authenticated source', type: 'fact' });
    await correctMemory(first.id, 'first corrected value', 'correction', 'strict-encrypted-history-owner');
    const db = await getDb();
    const source = db.$client.prepare(`SELECT encrypted_content AS ciphertext, encryption_nonce AS nonce
      FROM memories WHERE id=?`).get(second.id) as { ciphertext: string; nonce: string };
    db.$client.prepare('UPDATE memories SET encrypted_content=?, encryption_nonce=? WHERE id=?')
      .run(source.ciphertext, source.nonce, first.id);

    await expect(getStrictCorrectionHistory(first.id, 'strict-encrypted-history-owner'))
      .rejects.toBeInstanceOf(TrustBoundaryError);
    await expect(correctMemory(first.id, 'poisoned replacement', 'must reject transplant', 'strict-encrypted-history-owner'))
      .rejects.toBeInstanceOf(TrustBoundaryError);
    expect(db.$client.prepare('SELECT content FROM memories WHERE id=?').get(first.id)).toEqual({ content: '' });
  });

  test('owner denial happens before decrypt and memory deletion cascades encrypted snapshots', async () => {
    const memory = await rememberMemory({ content: 'private encrypted correction', type: 'fact' });
    await correctMemory(memory.id, 'corrected private memory', 'correction', 'strict-encrypted-history-owner');
    const db = await getDb();
    const originalPassphrase = process.env.SQUISH_ENCRYPTION_PASSPHRASE;
    const originalCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'wrong-key';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'unpersisted-caller';
    await expect(getStrictCorrectionHistory(memory.id, 'unpersisted-caller')).rejects.toThrow('persisted owner identity');
    process.env.SQUISH_TRUSTED_CALLER_ID = originalCaller;
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = originalPassphrase;
    db.$client.prepare('DELETE FROM memories WHERE id=?').run(memory.id);
    expect(db.$client.prepare('SELECT id FROM memory_snapshots WHERE memory_id=?').all(memory.id)).toHaveLength(0);
  });

  test('audits owner-identity lookup failures before denying strict correction history', async () => {
    const memory = await rememberMemory({ content: 'owner lookup failure stays private', type: 'fact' });
    const db = await getDb();
    const resourceHash = createHash('sha256').update(memory.id).digest('hex');
    const before = db.$client.prepare(`SELECT COUNT(*) AS count FROM trust_audit_log
      WHERE resource_hash=? AND asset_type='correction_history' AND decision='deny'`).get(resourceHash) as { count: number };

    db.$client.exec('ALTER TABLE users RENAME TO users_unavailable');
    await expect(getStrictCorrectionHistory(memory.id, 'strict-encrypted-history-owner')).rejects.toThrow();

    const after = db.$client.prepare(`SELECT COUNT(*) AS count FROM trust_audit_log
      WHERE resource_hash=? AND asset_type='correction_history' AND decision='deny'`).get(resourceHash) as { count: number };
    expect(after.count).toBe(before.count + 1);
  });
});
