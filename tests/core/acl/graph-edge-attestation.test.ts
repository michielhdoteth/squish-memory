import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  attestUnattributedEntityEdges,
  type GraphEdgeAttestationDatabase,
} from '../../../core/acl/graph-edge-attestation.js';
import { signMemoryProvenance, verifyGraphRelationProvenance } from '../../../core/acl/provenance.js';

const dataDir = join(tmpdir(), `squish-graph-edge-attestation-${randomUUID()}`);
const priorDataDir = process.env.SQUISH_DATA_DIR;
const priorDatabaseUrl = process.env.DATABASE_URL;
const previous = {
  policy: process.env.SQUISH_TRUST_POLICY,
  caller: process.env.SQUISH_TRUSTED_CALLER_ID,
  privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
  keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
  publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
};

describe('explicit legacy graph-edge attestation', () => {
  let resetDb: typeof import('../../../db/index.js').resetDb;
  let getDb: typeof import('../../../db/index.js').getDb;
  let getSchema: typeof import('../../../db/schema.js').getSchema;
  let db: Awaited<ReturnType<typeof import('../../../db/index.js').getDb>>;
  let sqlite: GraphEdgeAttestationDatabase;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    ({ resetDb, getDb } = await import('../../../db/index.js'));
    ({ getSchema } = await import('../../../db/schema.js'));
    resetDb();
    db = await getDb();
    const raw = (db as { $client?: GraphEdgeAttestationDatabase }).$client;
    if (!raw) throw new Error('Test requires the local SQLite transaction client');
    sqlite = raw;
  });

  afterAll(async () => {
    try { (sqlite as GraphEdgeAttestationDatabase & { close?: () => void })?.close?.(); } catch { /* already closed */ }
    try { resetDb?.(); } catch { /* isolated test database */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* temporary cleanup */ }
    for (const [key, value] of Object.entries(previous)) {
      const envKey = key === 'policy' ? 'SQUISH_TRUST_POLICY'
        : key === 'caller' ? 'SQUISH_TRUSTED_CALLER_ID'
          : key === 'privateKey' ? 'SQUISH_PROVENANCE_PRIVATE_KEY'
            : key === 'keyId' ? 'SQUISH_PROVENANCE_KEY_ID' : 'SQUISH_PROVENANCE_PUBLIC_KEYS';
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
    if (priorDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = priorDataDir;
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  });

  it('dry-runs without writes, then adopts only supported source edges atomically', async () => {
    const keys = generateKeyPairSync('ed25519');
    const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyId = `graph-attestation-${randomUUID()}`;
    const caller = `graph-attestation-owner-${randomUUID()}`;
    const userId = randomUUID();
    const sourceId = randomUUID();
    const projectId = randomUUID();
    const fromId = randomUUID();
    const toId = randomUUID();
    const content = 'Northstar replaces Polaris.';
    const keyEnv = {
      SQUISH_PROVENANCE_PRIVATE_KEY: privatePem,
      SQUISH_PROVENANCE_KEY_ID: keyId,
      SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ [keyId]: publicPem }),
    } as NodeJS.ProcessEnv;
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
    delete process.env.SQUISH_PROVENANCE_KEY_ID;
    delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
    const schema = await getSchema();
    await db.insert(schema.projects).values({ id: projectId, name: 'edge-attestation', path: dataDir });
    await db.insert(schema.users).values({ id: userId, externalId: caller });
    await db.insert(schema.entities).values([
      { id: fromId, projectId, name: 'Northstar', type: 'document' },
      { id: toId, projectId, name: 'Polaris', type: 'document' },
    ]);
    const sourceMetadata = { sourceMemoryId: sourceId };
    const sourceSignature = signMemoryProvenance({
      content, projectId, type: 'fact', ownerId: userId, teamId: null,
      sourceMemoryId: sourceId, metadata: sourceMetadata,
    }, keyEnv);
    await db.insert(schema.memories).values({
      id: sourceId, projectId, userId, type: 'fact', content, source: 'legacy graph attestation test',
      status: 'active', isActive: true,
      metadata: JSON.stringify({ ...sourceMetadata, __squishProvenance: sourceSignature }),
    });
    const { createKnowledgeEdge } = await import('../../../core/knowledge/knowledge-edges.js');
    await createKnowledgeEdge({
      fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'supersedes_version',
      metadata: {
        legacyMigration: { sourceTable: 'entity_relations', trust: 'unverified_legacy' },
        legacyPayload: { properties: { context: content, confidence: 0.9 } },
      },
    });
    await createKnowledgeEdge({
      fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'supports',
      metadata: { context: 'Northstar secretly controls Polaris.' },
    });
    await createKnowledgeEdge({
      fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'mentioned_together',
      metadata: { context: content },
    });
    const validId = String(sqlite.prepare(`SELECT id FROM knowledge_edges
      WHERE from_id = ? AND to_id = ? AND edge_type = 'supersedes_version'`).get(fromId, toId)?.id ?? '');
    const deniedId = String(sqlite.prepare(`SELECT id FROM knowledge_edges
      WHERE from_id = ? AND to_id = ? AND edge_type = 'supports'`).get(fromId, toId)?.id ?? '');
    const failingId = String(sqlite.prepare(`SELECT id FROM knowledge_edges
      WHERE from_id = ? AND to_id = ? AND edge_type = 'mentioned_together'`).get(fromId, toId)?.id ?? '');
    expect(validId).toBeTruthy();
    expect(deniedId).toBeTruthy();
    expect(failingId).toBeTruthy();
    const before = sqlite.prepare('SELECT metadata FROM knowledge_edges WHERE id = ?').get(validId)?.metadata;

    const preview = await attestUnattributedEntityEdges(sqlite, {
      apply: false, actorId: caller,
      selections: [{ edgeId: validId, sourceMemoryIds: [sourceId] }],
    });
    expect(preview).toMatchObject({ selected: 1, attested: 0, dryRun: true });
    expect(preview.candidates.find((candidate) => candidate.edgeId === validId)).toMatchObject({
      fromName: 'Northstar', toName: 'Polaris', edgeType: 'supersedes_version', context: content,
    });
    expect(sqlite.prepare('SELECT metadata FROM knowledge_edges WHERE id = ?').get(validId)?.metadata).toBe(before);

    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    Object.assign(process.env, keyEnv);
    const result = await attestUnattributedEntityEdges(sqlite, {
      apply: true, actorId: caller,
      selections: [{ edgeId: validId, sourceMemoryIds: [sourceId] }],
    });
    expect(result).toMatchObject({ selected: 1, attested: 1, dryRun: false });
    const stored = sqlite.prepare('SELECT * FROM knowledge_edges WHERE id = ?').get(validId);
    expect(stored).toBeDefined();
    const edge = (await import('../../../core/knowledge/helpers.js')).toKnowledgeEdge(stored);
    expect(edge.metadata?.sourceMemoryIds).toEqual([sourceId]);
    expect(verifyGraphRelationProvenance({
      fromId, fromKind: 'entity', toId, toKind: 'entity',
      edgeType: edge.edgeType, weight: edge.weight, metadata: edge.metadata,
    })).toBe(true);

    await expect(attestUnattributedEntityEdges(sqlite, {
      apply: true, actorId: caller,
      selections: [{ edgeId: deniedId, sourceMemoryIds: [sourceId] }],
    })).rejects.toThrow('Graph-edge attestation denied');
    expect(sqlite.prepare('SELECT metadata FROM knowledge_edges WHERE id = ?').get(deniedId)?.metadata)
      .not.toContain('__squishGraphProvenance');
    const deniedHash = createHash('sha256').update(deniedId).digest('hex');
    expect(Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM trust_audit_log
      WHERE resource_hash = ? AND decision = 'deny'`).get(deniedHash)?.count ?? 0)).toBe(1);

    sqlite.exec(`CREATE TRIGGER reject_graph_owner_attestation_audit BEFORE INSERT ON trust_audit_log
      WHEN NEW.asset_type = 'knowledge_edge' AND NEW.reason = 'owner_attestation'
      BEGIN SELECT RAISE(ABORT, 'injected owner-attestation audit failure'); END`);
    try {
      await expect(attestUnattributedEntityEdges(sqlite, {
        apply: true, actorId: caller,
        selections: [{ edgeId: failingId, sourceMemoryIds: [sourceId] }],
      })).rejects.toThrow('injected owner-attestation audit failure');
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS reject_graph_owner_attestation_audit');
    }
    expect(sqlite.prepare('SELECT metadata FROM knowledge_edges WHERE id = ?').get(failingId)?.metadata)
      .not.toContain('__squishGraphProvenance');
    const failingHash = createHash('sha256').update(failingId).digest('hex');
    const failedAuditCount = Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM trust_audit_log
      WHERE resource_hash = ?`).get(failingHash)?.count ?? 0);
    expect(failedAuditCount).toBe(0);
    expect(sqlite.inTransaction).toBe(false);
  });
});
