import { generateKeyPairSync } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { attestUnsignedLegacyMemories, migrateLegacyMemoryScopes, type AttestationDatabase } from '../../../core/acl/owner-attestation.js';
import { signMemoryProvenance, verifyMemoryProvenance } from '../../../core/acl/provenance.js';

const keyPair = generateKeyPairSync('ed25519');
const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const env = {
  SQUISH_PROVENANCE_PRIVATE_KEY: privatePem,
  SQUISH_PROVENANCE_KEY_ID: 'owner-test-key',
  SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'owner-test-key': publicPem }),
} as NodeJS.ProcessEnv;

let temporaryDirectory: string | undefined;
const databaseByPath = new Map<string, Database>();

function createDb(path = ':memory:'): Database {
  const db = new Database(path);
  databaseByPath.set(path, db);
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get()) {
    db.exec(`
      CREATE TABLE memories (id TEXT PRIMARY KEY, project_id TEXT, type TEXT, content TEXT, metadata TEXT, user_id TEXT, team_id TEXT);
      CREATE TABLE knowledge (id TEXT PRIMARY KEY, project_id TEXT, knowledge_kind TEXT, knowledge_type TEXT, content TEXT, metadata TEXT);
    `);
  }
  return db;
}

afterEach(() => {
  for (const db of databaseByPath.values()) db.close();
  databaseByPath.clear();
  if (temporaryDirectory) {
    try { rmSync(temporaryDirectory, { recursive: true, force: true }); } catch { /* Windows may briefly retain a SQLite handle after close. */ }
    temporaryDirectory = undefined;
  }
});

describe('explicit local-owner legacy memory attestation', () => {
  it('dry-runs by default and reports eligible memory and projection rows', async () => {
    const db = createDb();
    db.prepare('INSERT INTO memories (id, project_id, type, content, metadata, user_id, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m-1', 'p-1', 'fact', 'Legacy memory', '{"sourceId":"msg-1"}', 'u-1', 't-1');
    db.prepare('INSERT INTO knowledge VALUES (?, ?, ?, ?, ?, ?)').run('k-1', 'p-1', 'memory', 'fact', 'Legacy memory', '{"sourceMemoryId":"m-1","sourceId":"msg-1"}');

    const result = await attestUnsignedLegacyMemories(db as unknown as AttestationDatabase, {
      apply: false,
      actorId: 'local-owner-test',
      env,
    });

    expect(result).toMatchObject({ memoryCandidates: 1, knowledgeCandidates: 1, signedMemories: 0, signedKnowledge: 0, dryRun: true });
    expect(db.prepare('SELECT metadata FROM memories WHERE id = ?').get('m-1')).toEqual({ metadata: '{"sourceId":"msg-1"}' });
  });

  it('signs only unsigned memory rows and canonical memory projections, with hashed audit events', async () => {
    const db = createDb();
    db.prepare('INSERT INTO memories (id, project_id, type, content, metadata, user_id, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m-1', 'p-1', 'fact', 'Legacy memory', '{"sourceId":"msg-1"}', 'u-1', 't-1');
    db.prepare('INSERT INTO memories (id, project_id, type, content, metadata) VALUES (?, ?, ?, ?, ?)').run('m-signed', 'p-1', 'fact', 'Existing signed', '{"__squishProvenance":{"version":1,"keyId":"old","signature":"old"}}');
    db.prepare('INSERT INTO memories (id, project_id, type, content, metadata) VALUES (?, ?, ?, ?, ?)').run('m-bad', 'p-1', 'fact', 'Malformed metadata', '{bad');
    db.prepare('INSERT INTO knowledge VALUES (?, ?, ?, ?, ?, ?)').run('k-1', 'p-1', 'memory', 'fact', 'Legacy memory', '{"sourceMemoryId":"m-1","sourceId":"msg-1"}');
    db.prepare('INSERT INTO knowledge VALUES (?, ?, ?, ?, ?, ?)').run('b-1', 'p-1', 'belief', 'belief', 'Unsigned belief', '{}');
    const auditRows: Array<{ assetType: string; resourceId: string; reason: string }> = [];

    const result = await attestUnsignedLegacyMemories(db as unknown as AttestationDatabase, {
      apply: true,
      actorId: 'local-owner-test',
      env,
      audit: async (input) => { auditRows.push(input); },
    });

    expect(result).toMatchObject({ signedMemories: 1, signedKnowledge: 1, skippedMalformed: 1, skippedAlreadySigned: 1, dryRun: false });
    expect(auditRows).toEqual([
      { actorId: 'local-owner-test', resourceId: 'm-1', assetType: 'memory', decision: 'allow', reason: 'owner_attestation' },
      { actorId: 'local-owner-test', resourceId: 'k-1', assetType: 'knowledge', decision: 'allow', reason: 'owner_attestation' },
    ]);
    const memory = db.prepare('SELECT id, project_id, type, content, metadata, user_id, team_id FROM memories WHERE id = ?').get('m-1') as Record<string, unknown>;
    const projection = db.prepare('SELECT k.id, k.project_id, k.knowledge_type, k.content, k.metadata, m.user_id, m.team_id FROM knowledge k LEFT JOIN memories m ON m.id = json_extract(k.metadata, "$.sourceMemoryId") WHERE k.id = ?').get('k-1') as Record<string, unknown>;
    const memoryMetadata = JSON.parse(String(memory.metadata)) as Record<string, unknown>;
    const projectionMetadata = JSON.parse(String(projection.metadata)) as Record<string, unknown>;
    expect(verifyMemoryProvenance({ content: String(memory.content), projectId: String(memory.project_id), type: String(memory.type), ownerId: String(memory.user_id), teamId: String(memory.team_id), sourceMemoryId: String(memory.id), metadata: memoryMetadata }, env)).toBe(true);
    expect(verifyMemoryProvenance({ content: String(projection.content), projectId: String(projection.project_id), type: String(projection.knowledge_type), ownerId: String(projection.user_id), teamId: String(projection.team_id), sourceMemoryId: String(JSON.parse(String(projection.metadata)).sourceMemoryId), metadata: projectionMetadata }, env)).toBe(true);
    expect(db.prepare('SELECT metadata FROM knowledge WHERE id = ?').get('b-1')).toEqual({ metadata: '{}' });
  });

  it('rolls back signatures when audit persistence fails', async () => {
    const db = createDb();
    db.prepare('INSERT INTO memories (id, project_id, type, content, metadata) VALUES (?, ?, ?, ?, ?)').run('m-rollback', 'p-1', 'fact', 'Rollback me', '{}');

    await expect(attestUnsignedLegacyMemories(db as unknown as AttestationDatabase, {
      apply: true,
      actorId: 'local-owner-test',
      env,
      audit: async () => { throw new Error('audit unavailable'); },
    })).rejects.toThrow('audit unavailable');

    expect(db.prepare('SELECT metadata FROM memories WHERE id = ?').get('m-rollback')).toEqual({ metadata: '{}' });
  });

  it('dry-runs and explicitly migrates verified v1/v2 scope to v3 with lineage and audit', async () => {
    const db = createDb();
    const legacyEvidence = { sourceId: 'msg-v2' };
    const legacySignature = signMemoryProvenance({
      content: 'Signed legacy fact', projectId: 'p-1', type: 'fact', metadata: legacyEvidence,
    }, env);
    const legacyMemoryMetadata = { ...legacyEvidence, sourceMemoryId: 'm-v2', __squishProvenance: legacySignature };
    db.prepare('INSERT INTO memories (id, project_id, type, content, metadata, user_id, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('m-v2', 'p-1', 'fact', 'Signed legacy fact', JSON.stringify(legacyMemoryMetadata), 'u-v2', 't-v2');
    db.prepare('INSERT INTO knowledge VALUES (?, ?, ?, ?, ?, ?)')
      .run('k-v2', 'p-1', 'memory', 'fact', 'Signed legacy fact', JSON.stringify(legacyMemoryMetadata));
    const invalid = { ...legacyMemoryMetadata, __squishProvenance: { version: 2, keyId: 'owner-test-key', signature: 'invalid' } };
    db.prepare('INSERT INTO memories (id, project_id, type, content, metadata, user_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('m-invalid-v2', 'p-1', 'fact', 'Tampered signed fact', JSON.stringify(invalid), 'u-v2');

    const dryRun = await migrateLegacyMemoryScopes(db as unknown as AttestationDatabase, {
      apply: false, actorId: 'local-owner-test', env,
    });
    expect(dryRun).toMatchObject({ memoryCandidates: 1, knowledgeCandidates: 1, skippedInvalidSignature: 1, dryRun: true });
    expect(JSON.parse(String((db.prepare('SELECT metadata FROM memories WHERE id = ?').get('m-v2') as { metadata: string }).metadata)).__squishProvenance.version).toBe(2);
    await expect(migrateLegacyMemoryScopes(db as unknown as AttestationDatabase, {
      apply: true, actorId: 'local-owner-test', env,
      audit: async () => { throw new Error('audit unavailable'); },
    })).rejects.toThrow('audit unavailable');
    expect(JSON.parse(String((db.prepare('SELECT metadata FROM memories WHERE id = ?').get('m-v2') as { metadata: string }).metadata)).__squishProvenance.version).toBe(2);

    const auditRows: Array<{ resourceId: string; assetType: string; reason: string }> = [];
    const applied = await migrateLegacyMemoryScopes(db as unknown as AttestationDatabase, {
      apply: true, actorId: 'local-owner-test', env,
      audit: async (input) => { auditRows.push(input); },
    });
    expect(applied).toMatchObject({ resignedMemories: 1, resignedKnowledge: 1, skippedInvalidSignature: 1, dryRun: false });
    expect(auditRows.map(({ resourceId, assetType, reason }) => ({ resourceId, assetType, reason }))).toEqual([
      { resourceId: 'm-v2', assetType: 'memory', reason: 'scope_migration' },
      { resourceId: 'k-v2', assetType: 'knowledge', reason: 'scope_migration' },
    ]);

    const migratedMemory = db.prepare('SELECT id, project_id, type, content, metadata, user_id, team_id FROM memories WHERE id = ?').get('m-v2') as Record<string, unknown>;
    const migratedKnowledge = db.prepare('SELECT id, project_id, knowledge_type, content, metadata FROM knowledge WHERE id = ?').get('k-v2') as Record<string, unknown>;
    const memoryMetadata = JSON.parse(String(migratedMemory.metadata)) as Record<string, unknown>;
    const knowledgeMetadata = JSON.parse(String(migratedKnowledge.metadata)) as Record<string, unknown>;
    expect((memoryMetadata.__squishProvenance as { version: number }).version).toBe(3);
    expect((knowledgeMetadata.__squishProvenance as { version: number }).version).toBe(3);
    expect(verifyMemoryProvenance({
      content: String(migratedMemory.content), projectId: String(migratedMemory.project_id), type: String(migratedMemory.type),
      ownerId: String(migratedMemory.user_id), teamId: String(migratedMemory.team_id), sourceMemoryId: 'm-v2', metadata: memoryMetadata,
    }, env)).toBe(true);
    expect(verifyMemoryProvenance({
      content: String(migratedKnowledge.content), projectId: String(migratedKnowledge.project_id), type: String(migratedKnowledge.knowledge_type),
      ownerId: 'u-v2', teamId: 't-v2', sourceMemoryId: 'm-v2', metadata: knowledgeMetadata,
    }, env)).toBe(true);
  });

  it('refuses apply mode under strict trust', async () => {
    const db = createDb();
    db.prepare('INSERT INTO memories (id, project_id, type, content, metadata) VALUES (?, ?, ?, ?, ?)').run('m-strict', 'p-1', 'fact', 'No automatic trust', '{}');

    await expect(attestUnsignedLegacyMemories(db as unknown as AttestationDatabase, {
      apply: true,
      actorId: 'local-owner-test',
      env: { ...env, SQUISH_TRUST_POLICY: 'strict' } as NodeJS.ProcessEnv,
    })).rejects.toThrow('local-compatible policy');
    await expect(migrateLegacyMemoryScopes(db as unknown as AttestationDatabase, {
      apply: true,
      actorId: 'local-owner-test',
      env: { ...env, SQUISH_TRUST_POLICY: 'strict' } as NodeJS.ProcessEnv,
    })).rejects.toThrow('local-compatible policy');
  });

  it('dry-runs, applies, and rolls back scope migration against a disposable copied SQLite file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'squish-scope-migration-copy-'));
    temporaryDirectory = directory;
    const sourcePath = join(directory, `source-${crypto.randomUUID()}.db`);
    const copyPath = join(directory, `disposable-copy-${crypto.randomUUID()}.db`);
    const source = createDb(sourcePath);
    const legacyEvidence = { evidence: 'legacy evidence' };
    const legacySignature = signMemoryProvenance({ content: 'Signed legacy fact', projectId: 'p-1', type: 'fact', metadata: legacyEvidence }, env);
    const legacyMetadata = { ...legacyEvidence, sourceMemoryId: 'm-v2', __squishProvenance: legacySignature };
    source.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('m-v2', 'p-1', 'fact', 'Signed legacy fact', JSON.stringify(legacyMetadata), 'u-v2', 't-v2');
    source.prepare('INSERT INTO knowledge VALUES (?, ?, ?, ?, ?, ?)')
      .run('k-v2', 'p-1', 'memory', 'fact', 'Signed legacy fact', JSON.stringify(legacyMetadata));
    const sourceBytesBefore = Buffer.from(readFileSync(sourcePath)).toString('hex');
    copyFileSync(sourcePath, copyPath);
    source.close();
    databaseByPath.delete(sourcePath);
    const disposable = createDb(copyPath);
    const copySnapshot = (): string => JSON.stringify({
      memory: disposable.query('SELECT * FROM memories').get(),
      knowledge: disposable.query('SELECT * FROM knowledge').get(),
    });
    const originalRows = copySnapshot();

    const result = await migrateLegacyMemoryScopes(disposable, { apply: false, actorId: 'local-owner-test', env });
    expect(result).toMatchObject({ memoryCandidates: 1, knowledgeCandidates: 1, dryRun: true });
    expect(copySnapshot()).toBe(originalRows);
    expect(Buffer.from(readFileSync(sourcePath)).toString('hex')).toBe(sourceBytesBefore);

    await expect(migrateLegacyMemoryScopes(disposable, {
      apply: true,
      actorId: 'local-owner-test',
      env,
      audit: async () => { throw new Error('copied database audit failure'); },
    })).rejects.toThrow('copied database audit failure');
    expect(copySnapshot()).toBe(originalRows);
    expect(Buffer.from(readFileSync(sourcePath)).toString('hex')).toBe(sourceBytesBefore);

    const applied = await migrateLegacyMemoryScopes(disposable, {
      apply: true, actorId: 'local-owner-test', env, audit: async () => {},
    });
    expect(applied).toMatchObject({ resignedMemories: 1, resignedKnowledge: 1, dryRun: false });
    expect(Buffer.from(readFileSync(sourcePath)).toString('hex')).toBe(sourceBytesBefore);
    const migratedMemory = disposable.prepare('SELECT id, project_id, type, content, metadata, user_id, team_id FROM memories WHERE id=?').get('m-v2') as Record<string, unknown>;
    const migratedKnowledge = disposable.prepare('SELECT id, project_id, knowledge_type, content, metadata FROM knowledge WHERE id=?').get('k-v2') as Record<string, unknown>;
    const memoryMetadata = JSON.parse(String(migratedMemory.metadata)) as Record<string, unknown>;
    const knowledgeMetadata = JSON.parse(String(migratedKnowledge.metadata)) as Record<string, unknown>;
    expect((memoryMetadata.__squishProvenance as { version: number }).version).toBe(3);
    expect((knowledgeMetadata.__squishProvenance as { version: number }).version).toBe(3);
    expect(verifyMemoryProvenance({ content: String(migratedMemory.content), projectId: String(migratedMemory.project_id),
      type: String(migratedMemory.type), ownerId: String(migratedMemory.user_id), teamId: String(migratedMemory.team_id),
      sourceMemoryId: 'm-v2', metadata: memoryMetadata }, env)).toBe(true);
    expect(verifyMemoryProvenance({ content: String(migratedKnowledge.content), projectId: String(migratedKnowledge.project_id),
      type: String(migratedKnowledge.knowledge_type), ownerId: 'u-v2', teamId: 't-v2', sourceMemoryId: 'm-v2',
      metadata: knowledgeMetadata }, env)).toBe(true);
    disposable.close();
    databaseByPath.delete(copyPath);
    source.close();
    databaseByPath.delete(sourcePath);
  });
});
