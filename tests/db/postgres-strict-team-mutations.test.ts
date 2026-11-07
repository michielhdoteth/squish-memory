import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { closeAllDbs, getDb, resetDb } from '../../db/index.js';
import { addTeamMember, getMemorySharedTeams, getTeam, resolvePersistedUserId } from '../../db/team-adapter.js';
import { entities, knowledge, knowledgeEdges, memoryAnalysisJobs, memories, projects, users } from '../../db/drizzle/schema-pg.js';
import { registerTeamTools } from '../../mcp/tools/team.js';
import { getMemory, rememberMemory, search } from '../../core/memory/memories.js';
import { rememberMemoryWithAudit } from '../../core/memory/memory-write.js';
import { deleteMemoryPermanently, getStaleMemories, runAutoClean } from '../../core/memory/stale-cleaner.js';
import { getAuditTrail, getProvenanceChain, logAuditEntry } from '../../core/knowledge/audit.js';
import { signGraphRelationProvenance, signMemoryProvenance, verifyMemoryProvenance } from '../../core/acl/provenance.js';
import { buildStrictMemoryCandidateFilter } from '../../core/acl/read-gate.js';
import { createDatabaseClient } from '../../core/storage/database.js';
import { getPostgresMemoryCandidates, vectorSearch } from '../../core/memory/vector-search.js';
import { compileTeamMemories, getCompileStats } from '../../core/memory/team-compiler.js';
import { cleanupExpiredTemporalFacts } from '../../core/memory/temporal-facts.js';
import { queryGraphView } from '../../core/knowledge/graph-view-engine.js';
import { closeEdgesForNode, createKnowledgeEdge, getConnectedEntities, getConnectedPlaces, getEdgesForNode, getEdgesFrom, getEdgesTo, retractKnowledgeEdge, reviseKnowledgeEdge } from '../../core/knowledge/knowledge-edges.js';
import { closeAssociationsForMemories, createAssociation, getMemoryAssociationRows } from '../../core/associations.js';

const testUrl = process.env.SQUISH_TEST_POSTGRES_URL;
const postgresTest = test.skipIf(!testUrl);
const migrationDir = `${import.meta.dir}/../../db/drizzle/migrations`;
const baseMigration = readFileSync(`${migrationDir}/0000_needy_cerebro.sql`, 'utf8');
const trustAuditMigration = readFileSync(`${migrationDir}/0002_trust_audit_log.sql`, 'utf8');
const trustAuditEpochMigration = readFileSync(`${migrationDir}/0003_trust_audit_epoch_ms_bigint.sql`, 'utf8');
const teamMutationMigration = readFileSync(`${migrationDir}/0005_strict_team_mutations.sql`, 'utf8');
const canonicalGraphMigration = readFileSync(`${migrationDir}/0004_canonical_knowledge_graph.sql`, 'utf8');
const analysisJobsMigration = readFileSync(`${migrationDir}/0007_memory_analysis_jobs.sql`, 'utf8');
const knowledgeAuditMigration = readFileSync(`${migrationDir}/0008_knowledge_audit_log.sql`, 'utf8');
const memoryLifecycleMigration = readFileSync(`${migrationDir}/0009_memory_source_lifecycle.sql`, 'utf8');
const visibilityRulesMigration = readFileSync(`${migrationDir}/0010_visibility_rules.sql`, 'utf8');
const memoryStalenessMigration = readFileSync(`${migrationDir}/0011_memory_staleness_fields.sql`, 'utf8');
const entityMentionMigration = readFileSync(`${migrationDir}/0012_entity_mention_metadata.sql`, 'utf8');
const captureReceiptsMigration = readFileSync(`${migrationDir}/0013_memory_capture_receipts.sql`, 'utf8');
const sourceEncryptionMigration = readFileSync(`${migrationDir}/0014_memory_source_encryption.sql`, 'utf8');
const memoryTokenEstimateMigration = readFileSync(`${migrationDir}/0015_memory_token_estimate.sql`, 'utf8');
const memoryEmbeddingModelMigration = readFileSync(`${migrationDir}/0016_memory_embedding_model.sql`, 'utf8');
const previousEnv = {
  databaseUrl: process.env.SQUISH_DATABASE_URL,
  trustPolicy: process.env.SQUISH_TRUST_POLICY,
  trustedCaller: process.env.SQUISH_TRUSTED_CALLER_ID,
  provenancePrivateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
  provenancePublicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
  provenancePublicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
  provenanceKeyId: process.env.SQUISH_PROVENANCE_KEY_ID,
};

describe('strict team mutations on PostgreSQL', () => {
  let adminPool: Pool;
  let schemaName: string;
  let handlers: Map<string, (input: Record<string, unknown>) => Promise<unknown>>;

  beforeAll(async () => {
    if (!testUrl) return;
    schemaName = `squish_team_test_${randomUUID().replaceAll('-', '')}`;
    adminPool = new Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);

    const scopedUrl = new URL(testUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName},public`);
    process.env.SQUISH_DATABASE_URL = scopedUrl.toString();
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-owner';
    resetDb();

    const client = await adminPool.connect();
    try {
      await client.query(`SET search_path TO "${schemaName}", public`);
      // Replay the real legacy base schema and forward migrations in an isolated
      // search path. The base migration qualifies foreign-key targets as public;
      // rewrite only that schema qualifier so the fixture remains disposable.
      await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
      await client.query(baseMigration.replaceAll('"public".', `"${schemaName}".`));
      await client.query(trustAuditMigration);
      await client.query(trustAuditEpochMigration);
      await client.query(canonicalGraphMigration.replaceAll('"public".', `"${schemaName}".`));
      await client.query(teamMutationMigration);
      await client.query(analysisJobsMigration);
      await client.query(knowledgeAuditMigration);
      await client.query(memoryLifecycleMigration);
      await client.query(visibilityRulesMigration);
      await client.query(memoryStalenessMigration);
      await client.query(entityMentionMigration);
      await client.query(captureReceiptsMigration);
      await client.query(sourceEncryptionMigration);
      await client.query(memoryTokenEstimateMigration);
      await client.query(memoryEmbeddingModelMigration);
    } finally {
      client.release();
    }

    handlers = new Map();
    registerTeamTools({
      register: (_server, name, _definition, handler) => { handlers.set(name, handler); return true; },
      server: {} as never,
      sdkClient: { getById: async (id: string) => ({ id }) } as never,
      resolveProjectPath: () => undefined,
      errorResponse: (code, message) => ({ error: code, message }),
      SERVER_VERSION: 'test',
    });
  }, 20_000);

  afterAll(async () => {
    if (testUrl) {
      await closeAllDbs();
      resetDb();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
    for (const [key, value] of Object.entries({
      SQUISH_DATABASE_URL: previousEnv.databaseUrl,
      SQUISH_TRUST_POLICY: previousEnv.trustPolicy,
      SQUISH_TRUSTED_CALLER_ID: previousEnv.trustedCaller,
      SQUISH_PROVENANCE_PRIVATE_KEY: previousEnv.provenancePrivateKey,
      SQUISH_PROVENANCE_PUBLIC_KEY: previousEnv.provenancePublicKey,
      SQUISH_PROVENANCE_PUBLIC_KEYS: previousEnv.provenancePublicKeys,
      SQUISH_PROVENANCE_KEY_ID: previousEnv.provenanceKeyId,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 20_000);

  postgresTest('commits direct team mutations with hashed audits and rolls both back on audit failure', async () => {
    const db = await getDb();
    await expect(rememberMemory({
      content: 'Strict PostgreSQL capture requires a configured provenance signer.',
      type: 'fact',
      project: 'strict-postgres-capture',
      user: 'pg-test-owner',
    })).rejects.toThrow('Strict trust policy requires SQUISH_PROVENANCE_PRIVATE_KEY and SQUISH_PROVENANCE_KEY_ID for writes');
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories`)).toMatchObject({ rowCount: 0 });
    const writeDenial = await adminPool.query(`SELECT actor_hash, resource_hash, decision, reason FROM "${schemaName}".trust_audit_log`);
    expect(writeDenial.rowCount).toBe(0);

    const knowledgeAudit = await logAuditEntry({
      knowledgeId: 'pg-audit-projection',
      action: 'create',
      projectId: 'pg-audit-project',
      details: { kind: 'memory', type: 'fact' },
    });
    expect(knowledgeAudit).toMatchObject({
      knowledgeId: 'pg-audit-projection',
      action: 'create',
      projectId: 'pg-audit-project',
      details: { kind: 'memory', type: 'fact' },
    });
    expect(await adminPool.query(
      `SELECT knowledge_id, action, project_id, details FROM "${schemaName}".knowledge_audit_log WHERE id = $1`,
      [knowledgeAudit.id],
    )).toMatchObject({ rows: [{
      knowledge_id: 'pg-audit-projection',
      action: 'create',
      project_id: 'pg-audit-project',
      details: { kind: 'memory', type: 'fact' },
    }] });

    const chainIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.insert(knowledge).values(chainIds.map((id, index) => ({
      id,
      knowledgeKind: 'memory' as const,
      knowledgeType: 'fact',
      content: `PostgreSQL provenance node ${index}`,
    })));
    const edgeTime = new Date(Date.now() - 1_000);
    await db.insert(knowledgeEdges).values([
      {
        fromId: chainIds[0]!, fromKind: 'knowledge', toId: chainIds[1]!, toKind: 'knowledge',
        edgeType: 'sourced_from', validFrom: edgeTime, recordedAt: edgeTime,
      },
      {
        fromId: chainIds[1]!, fromKind: 'knowledge', toId: chainIds[2]!, toKind: 'knowledge',
        edgeType: 'informed_by', validFrom: edgeTime, recordedAt: edgeTime,
      },
      {
        fromId: chainIds[2]!, fromKind: 'knowledge', toId: chainIds[0]!, toKind: 'knowledge',
        edgeType: 'extends', validFrom: edgeTime, recordedAt: edgeTime,
      },
      {
        fromId: chainIds[0]!, fromKind: 'knowledge', toId: chainIds[3]!, toKind: 'knowledge',
        edgeType: 'extends', validFrom: new Date(Date.now() + 60_000), recordedAt: edgeTime,
      },
      {
        fromId: chainIds[0]!, fromKind: 'knowledge', toId: chainIds[4]!, toKind: 'knowledge',
        edgeType: 'extends', validFrom: edgeTime, validTo: new Date(Date.now() - 500), recordedAt: edgeTime,
      },
    ]);
    const priorTrustPolicy = process.env.SQUISH_TRUST_POLICY;
    delete process.env.SQUISH_TRUST_POLICY;
    try {
      await expect(getAuditTrail('pg-audit-projection')).resolves.toMatchObject([{
        id: knowledgeAudit.id,
        knowledgeId: 'pg-audit-projection',
        action: 'create',
        details: { kind: 'memory', type: 'fact' },
      }]);
      await expect(getProvenanceChain(chainIds[0]!)).resolves.toEqual([
        { knowledgeId: chainIds[0], edgeType: null, depth: 0 },
        { knowledgeId: chainIds[1], edgeType: 'sourced_from', depth: 1 },
        { knowledgeId: chainIds[2], edgeType: 'informed_by', depth: 2 },
      ]);
    } finally {
      if (priorTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = priorTrustPolicy;
    }

    const triggerFn = `fail_team_audit_${schemaName}`;
    await adminPool.query(`CREATE FUNCTION "${schemaName}"."${triggerFn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason = 'team_created' THEN RAISE EXCEPTION 'injected team audit failure'; END IF; RETURN NEW; END $$`);
    await adminPool.query(`CREATE TRIGGER fail_team_audit BEFORE INSERT ON "${schemaName}".team_security_audit FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${triggerFn}"()`);

    const invoke = (input: Record<string, unknown>) => handlers.get('squish_team')!(input);
    const rejectedCreate = await invoke({ action: 'create', name: 'Must roll back' });
    expect(rejectedCreate).toMatchObject({ error: 'team_error' });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".teams`)).toMatchObject({ rowCount: 0 });

    await adminPool.query(`DROP TRIGGER fail_team_audit ON "${schemaName}".team_security_audit`);
    await adminPool.query(`DROP FUNCTION "${schemaName}"."${triggerFn}"()`);

    const created = await invoke({ action: 'create', name: 'PG strict team' });
    const team = JSON.parse((created as { content: Array<{ text: string }> }).content[0]!.text).team as { id: string };
    await addTeamMember(team.id, 'pg-test-member', 'member');
    const compatiblePolicy = process.env.SQUISH_TRUST_POLICY;
    const previousEncryptionEnabled = process.env.SQUISH_ENCRYPTION_ENABLED;
    const previousEncryptionPassphrase = process.env.SQUISH_ENCRYPTION_PASSPHRASE;
    delete process.env.SQUISH_TRUST_POLICY;
    try {
      const localWrite = await rememberMemory({
        content: 'PostgreSQL local-compatible memory capture integration check.',
        type: 'fact',
        project: `/pg-local-compatible-${randomUUID()}`,
        user: 'pg-test-owner',
        teamId: team.id,
      });
      expect(localWrite).toMatchObject({
        content: 'PostgreSQL local-compatible memory capture integration check.',
        type: 'fact',
      });
      const [source] = await adminPool.query(
        `SELECT content, type, user_id, team_id, tags, metadata, is_active FROM "${schemaName}".memories WHERE id = $1`,
        [localWrite.id],
      ).then((result) => result.rows);
      expect(source).toMatchObject({
        content: localWrite.content,
        type: 'fact',
        team_id: team.id,
        tags: [],
        is_active: true,
      });
      const [projection] = await adminPool.query(
        `SELECT id, content, knowledge_kind, knowledge_type, metadata FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`,
        [localWrite.id],
      ).then((result) => result.rows);
      expect(projection).toMatchObject({
        content: localWrite.content,
        knowledge_kind: 'memory',
        knowledge_type: 'fact',
      });
      expect(projection.metadata.sourceMemoryId).toBe(localWrite.id);
      const [queue] = await adminPool.query(
        `SELECT status FROM "${schemaName}".memory_analysis_jobs WHERE source_memory_id = $1`,
        [localWrite.id],
      ).then((result) => result.rows);
      expect(queue).toMatchObject({ status: 'pending' });
      const [audit] = await adminPool.query(
        `SELECT action, details FROM "${schemaName}".knowledge_audit_log WHERE knowledge_id = $1`,
        [projection.id],
      ).then((result) => result.rows);
      expect(audit).toMatchObject({ action: 'create', details: { kind: 'memory', type: 'fact' } });

      process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
      process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'isolated-postgres-encryption-test-passphrase';
      const secret = 'PostgreSQL encrypted source marker 9M2K';
      const encryptedProject = `/pg-encrypted-${randomUUID()}`;
      const encrypted = await rememberMemory({
        content: secret,
        type: 'fact',
        project: encryptedProject,
        user: 'pg-test-owner',
        tags: ['postgres-private-marker'],
        metadata: { privateMarker: secret },
      });
      expect(encrypted.content).toBe(secret);
      const [encryptedSource] = await adminPool.query(
        `SELECT content, encrypted_content, encryption_nonce, is_encrypted, summary, tags, metadata, tokens_estimate, embedding_model
         FROM "${schemaName}".memories WHERE id = $1`,
        [encrypted.id],
      ).then((result) => result.rows);
      expect(encryptedSource).toMatchObject({ content: '', is_encrypted: true, summary: null, tokens_estimate: 0, embedding_model: null });
      expect(encryptedSource.encrypted_content).toBeTruthy();
      expect(encryptedSource.encryption_nonce).toBeTruthy();
      expect(encryptedSource.encrypted_content).not.toContain(secret);
      expect(JSON.stringify(encryptedSource.tags)).not.toContain('postgres-private-marker');
      expect(JSON.stringify(encryptedSource.metadata)).not.toContain(secret);
      const [encryptedProjection] = await adminPool.query(
        `SELECT content, encrypted_content, encryption_nonce, is_encrypted, summary, tags, metadata, embedding
         FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`,
        [encrypted.id],
      ).then((result) => result.rows);
      expect(encryptedProjection).toMatchObject({ content: '', is_encrypted: true, summary: null, embedding: null });
      expect(encryptedProjection.encrypted_content).toBe(encryptedSource.encrypted_content);
      expect(encryptedProjection.encryption_nonce).toBe(encryptedSource.encryption_nonce);
      expect(JSON.stringify(encryptedProjection.metadata)).not.toContain(secret);
      expect(await adminPool.query(
        `SELECT id FROM "${schemaName}".memory_analysis_jobs WHERE source_memory_id = $1`, [encrypted.id],
      )).toMatchObject({ rowCount: 0 });
      expect((await search({ query: 'PostgreSQL encrypted source marker 9M2K', project: encryptedProject }))
        .some((result) => result.id === encrypted.id)).toBe(false);
      expect((await getMemory(encrypted.id))?.content).toBe(secret);
      process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'wrong-postgres-encryption-test-passphrase';
      await expect(getMemory(encrypted.id)).rejects.toThrow('Could not decrypt encrypted memory');
      process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'isolated-postgres-encryption-test-passphrase';

      process.env.SQUISH_TRUST_POLICY = 'strict';
      await expect(rememberMemory({
        content: 'Strict PostgreSQL encryption stays disabled.',
        type: 'fact',
        project: `/pg-encrypted-strict-${randomUUID()}`,
        user: 'pg-test-owner',
      })).rejects.toThrow('unavailable under strict trust');
      delete process.env.SQUISH_TRUST_POLICY;
    } finally {
      if (compatiblePolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = compatiblePolicy;
      if (previousEncryptionEnabled === undefined) delete process.env.SQUISH_ENCRYPTION_ENABLED;
      else process.env.SQUISH_ENCRYPTION_ENABLED = previousEncryptionEnabled;
      if (previousEncryptionPassphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
      else process.env.SQUISH_ENCRYPTION_PASSPHRASE = previousEncryptionPassphrase;
    }

    const keyPair = generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ 'pg-capture-test': publicKey });
    process.env.SQUISH_PROVENANCE_KEY_ID = 'pg-capture-test';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    const strictProjectPath = `/pg-strict-capture-${randomUUID()}`;
    const createStaleTeamMemory = async (content: string) => {
      const memory = await rememberMemory({ content, type: 'fact', project: strictProjectPath, user: 'pg-test-owner', teamId: team.id });
      await adminPool.query(
        `UPDATE "${schemaName}".memories SET created_at = $1, confidence_level = 'outdated', importance_score = 10 WHERE id = $2`,
        [new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), memory.id],
      );
      return memory;
    };
    const staleTeamMemory = await createStaleTeamMemory('Signed stale team memory eligible for admin cleanup.');
    const teamCleanup = await runAutoClean(
      { olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 },
      { userId: 'pg-test-owner', teamIds: [team.id] },
    );
    expect(teamCleanup.deleted).toBe(1);
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [staleTeamMemory.id])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`, [staleTeamMemory.id])).toMatchObject({ rowCount: 0 });
    const teamTargetHash = createHash('sha256').update(staleTeamMemory.id).digest('hex');
    expect(await adminPool.query(
      `SELECT action, decision, reason, target_hash FROM "${schemaName}".team_security_audit WHERE target_hash = $1`,
      [teamTargetHash],
    )).toMatchObject({ rows: [{ action: 'delete', decision: 'allow', reason: 'stale_cleanup', target_hash: teamTargetHash }] });

    const stalePersonalMemory = await rememberMemory({
      content: 'Signed stale personal memory for strict listing.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
    });
    await adminPool.query(
      `UPDATE "${schemaName}".memories SET created_at = $1, confidence_level = 'outdated', importance_score = 10 WHERE id = $2`,
      [new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), stalePersonalMemory.id],
    );
    const stalePersonalRows = await getStaleMemories(
      { olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 },
      { userId: 'pg-test-owner' },
    );
    expect(stalePersonalRows.map((memory) => memory.id)).toContain(stalePersonalMemory.id);
    expect((await runAutoClean(
      { olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 },
      { userId: 'pg-test-owner' },
    )).deleted).toBe(1);

    const expiredPersonalMemory = await rememberMemory({
      content: 'Signed temporal fact for strict PostgreSQL expiry.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
    });
    // Replace the current source-linked projection with the legacy row shape:
    // projection ID equals source ID and sourceMemoryId metadata is absent.
    await adminPool.query(`DELETE FROM "${schemaName}".knowledge
      WHERE knowledge_kind = 'memory' AND metadata->>'sourceMemoryId' = $1`, [expiredPersonalMemory.id]);
    await adminPool.query(
      `INSERT INTO "${schemaName}".knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata)
       VALUES ($1, $2, 'memory', 'fact', 'Legacy canonical expiry fixture', '{}'::jsonb)`,
      [expiredPersonalMemory.id, expiredPersonalMemory.projectId],
    );
    const expiredDerivedFactId = randomUUID();
    const expiredSupportEdgeId = randomUUID();
    const expiredPlaceEdgeId = randomUUID();
    await adminPool.query(
      `INSERT INTO "${schemaName}".knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata)
       VALUES ($1, $2, 'memory', 'fact', 'Derived fact supported by expiring evidence', $3::jsonb)`,
      [expiredDerivedFactId, expiredPersonalMemory.projectId, JSON.stringify({
        sourceMemoryId: expiredPersonalMemory.id,
        derivation: { kind: 'extracted_fact' },
      })],
    );
    await adminPool.query(
      `INSERT INTO "${schemaName}".knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type)
       VALUES ($1, $2, 'knowledge', $3, 'memory', 'sourced_from')`,
      [expiredSupportEdgeId, expiredDerivedFactId, expiredPersonalMemory.id],
    );
    const placeEdgeValidFrom = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await adminPool.query(
      `INSERT INTO "${schemaName}".knowledge_edges
       (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at)
       VALUES ($1, $2, 'knowledge', 'wip', 'place', 'placed_in', $3, $3, $3)`,
      [expiredPlaceEdgeId, expiredPersonalMemory.id, placeEdgeValidFrom],
    );
    await adminPool.query(`UPDATE "${schemaName}".memories SET valid_to = $1 WHERE id = $2`,
      [new Date(Date.now() - 60_000), expiredPersonalMemory.id]);
    const expiryProject = await adminPool.query(`SELECT project_id FROM "${schemaName}".memories WHERE id = $1`, [expiredPersonalMemory.id]);
    const expiryProjectId = String(expiryProject.rows[0]?.project_id ?? '');
    expect(expiryProjectId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await cleanupExpiredTemporalFacts(expiryProjectId, { userId: 'pg-test-owner' })).toBe(1);
    expect(await adminPool.query(`SELECT status, is_active FROM "${schemaName}".memories WHERE id = $1`, [expiredPersonalMemory.id]))
      .toMatchObject({ rows: [{ status: 'expired', is_active: false }] });
    expect(await adminPool.query(`SELECT status, is_active FROM "${schemaName}".knowledge
      WHERE id = $1`, [expiredPersonalMemory.id]))
      .toMatchObject({ rows: [{ status: 'expired', is_active: false }] });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE id = $1`, [expiredDerivedFactId]))
      .toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT recorded_to FROM "${schemaName}".knowledge_edges WHERE id = $1`, [expiredSupportEdgeId]))
      .toMatchObject({ rows: [{ recorded_to: expect.any(Date) }] });
    expect(await adminPool.query(`SELECT recorded_to FROM "${schemaName}".knowledge_edges WHERE id = $1`, [expiredPlaceEdgeId]))
      .toMatchObject({ rows: [{ recorded_to: expect.any(Date) }] });
    expect(await adminPool.query(`SELECT valid_to, recorded_to FROM "${schemaName}".knowledge_edges
      WHERE from_id = $1 AND edge_type = 'placed_in' AND id <> $2`, [expiredPersonalMemory.id, expiredPlaceEdgeId]))
      .toMatchObject({ rows: [{ valid_to: expect.any(Date), recorded_to: null }] });
    expect(await adminPool.query(`SELECT action, details FROM "${schemaName}".knowledge_audit_log WHERE knowledge_id = $1`, [expiredDerivedFactId]))
      .toMatchObject({ rows: [{ action: 'delete', details: { reason: 'source_expired', sourceMemoryId: expiredPersonalMemory.id } }] });
    const temporalExpiryHash = createHash('sha256').update(expiredPersonalMemory.id).digest('hex');
    expect(await adminPool.query(
      `SELECT decision, reason, resource_hash FROM "${schemaName}".trust_audit_log WHERE resource_hash = $1`,
      [temporalExpiryHash],
    )).toMatchObject({ rows: [{ decision: 'allow', reason: 'temporal_expiry', resource_hash: temporalExpiryHash }] });

    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    const compatibleExpiryMemory = await rememberMemory({
      content: 'Local-compatible PostgreSQL expiry closes its current place assignment.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
    });
    const compatiblePlaceEdgeId = randomUUID();
    const compatiblePlaceValidFrom = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await adminPool.query(
      `INSERT INTO "${schemaName}".knowledge_edges
       (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at)
       VALUES ($1, $2, 'knowledge', 'wip', 'place', 'placed_in', $3, $3, $3)`,
      [compatiblePlaceEdgeId, compatibleExpiryMemory.id, compatiblePlaceValidFrom],
    );
    await adminPool.query(`UPDATE "${schemaName}".memories SET valid_to = $1 WHERE id = $2`,
      [new Date(Date.now() - 60_000), compatibleExpiryMemory.id]);
    expect(await cleanupExpiredTemporalFacts(expiryProjectId)).toBe(1);
    expect(await adminPool.query(`SELECT recorded_to FROM "${schemaName}".knowledge_edges WHERE id = $1`, [compatiblePlaceEdgeId]))
      .toMatchObject({ rows: [{ recorded_to: expect.any(Date) }] });
    expect(await adminPool.query(`SELECT valid_to, recorded_to FROM "${schemaName}".knowledge_edges
      WHERE from_id = $1 AND edge_type = 'placed_in' AND id <> $2`, [compatibleExpiryMemory.id, compatiblePlaceEdgeId]))
      .toMatchObject({ rows: [{ valid_to: expect.any(Date), recorded_to: null }] });
    process.env.SQUISH_TRUST_POLICY = 'strict';

    const expiryRollbackMemory = await rememberMemory({
      content: 'Signed PostgreSQL temporal fact must roll back if its audit fails.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
    });
    const rollbackDerivedFactId = randomUUID();
    const rollbackSupportEdgeId = randomUUID();
    await adminPool.query(
      `INSERT INTO "${schemaName}".knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata)
       VALUES ($1, $2, 'memory', 'fact', 'Derived fact must survive rolled-back source expiry', $3::jsonb)`,
      [rollbackDerivedFactId, expiryRollbackMemory.projectId, JSON.stringify({
        sourceMemoryId: expiryRollbackMemory.id,
        derivation: { kind: 'extracted_fact' },
      })],
    );
    await adminPool.query(
      `INSERT INTO "${schemaName}".knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type)
       VALUES ($1, $2, 'knowledge', $3, 'memory', 'sourced_from')`,
      [rollbackSupportEdgeId, rollbackDerivedFactId, expiryRollbackMemory.id],
    );
    await adminPool.query(`UPDATE "${schemaName}".memories SET valid_to = $1 WHERE id = $2`,
      [new Date(Date.now() - 60_000), expiryRollbackMemory.id]);
    const expiryRollbackTrigger = `fail_temporal_derivative_audit_${schemaName}`;
    await adminPool.query(`CREATE FUNCTION "${schemaName}"."${expiryRollbackTrigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'delete' AND NEW.details->>'reason' = 'source_expired' THEN RAISE EXCEPTION 'injected temporal derivative audit failure'; END IF; RETURN NEW; END $$`);
    await adminPool.query(`CREATE TRIGGER fail_temporal_derivative_audit BEFORE INSERT ON "${schemaName}".knowledge_audit_log FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${expiryRollbackTrigger}"()`);
    try {
      await expect(cleanupExpiredTemporalFacts(expiryProjectId, { userId: 'pg-test-owner' }))
        .rejects.toThrow('Failed query: insert into "knowledge_audit_log"');
      expect(await adminPool.query(`SELECT status, is_active FROM "${schemaName}".memories WHERE id = $1`, [expiryRollbackMemory.id]))
        .toMatchObject({ rows: [{ status: 'active', is_active: true }] });
      expect(await adminPool.query(`SELECT status, is_active FROM "${schemaName}".knowledge
        WHERE metadata->>'sourceMemoryId' = $1 AND metadata->'derivation' IS NULL`, [expiryRollbackMemory.id]))
        .toMatchObject({ rows: [{ status: 'active', is_active: true }] });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE id = $1`, [rollbackDerivedFactId]))
        .toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT recorded_to FROM "${schemaName}".knowledge_edges WHERE id = $1`, [rollbackSupportEdgeId]))
        .toMatchObject({ rows: [{ recorded_to: null }] });
      const expiryRollbackHash = createHash('sha256').update(expiryRollbackMemory.id).digest('hex');
      expect(await adminPool.query(
        `SELECT id FROM "${schemaName}".trust_audit_log WHERE resource_hash = $1 AND reason = 'temporal_expiry'`,
        [expiryRollbackHash],
      )).toMatchObject({ rowCount: 0 });
    } finally {
      await adminPool.query(`DROP TRIGGER IF EXISTS fail_temporal_derivative_audit ON "${schemaName}".knowledge_audit_log`);
      await adminPool.query(`DROP FUNCTION IF EXISTS "${schemaName}"."${expiryRollbackTrigger}"()`);
    }
    await adminPool.query(`DELETE FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = ANY($1::text[])`,
      [[expiredPersonalMemory.id, expiryRollbackMemory.id]]);
    await adminPool.query(`DELETE FROM "${schemaName}".memories WHERE id = ANY($1::uuid[])`,
      [[expiredPersonalMemory.id, expiryRollbackMemory.id]]);

    const memberProtectedMemory = await createStaleTeamMemory('Member cannot run team stale cleanup.');
    process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-member';
    try {
      await expect(runAutoClean(
        { olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 },
        { userId: 'pg-test-member', teamIds: [team.id] },
      )).rejects.toThrow('owner or admin membership');
    } finally {
      process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-owner';
    }
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [memberProtectedMemory.id])).toMatchObject({ rowCount: 1 });
    expect(await adminPool.query(
      `SELECT decision, reason FROM "${schemaName}".team_security_audit WHERE team_hash = $1 AND actor_hash = $2 ORDER BY created_at DESC LIMIT 1`,
      [createHash('sha256').update(team.id).digest('hex'), createHash('sha256').update('pg-test-member').digest('hex')],
    )).toMatchObject({ rows: [{ decision: 'deny', reason: 'role_required' }] });

    const auditRollbackMemory = await createStaleTeamMemory('Team cleanup rolls back when its audit fails.');
    const staleAuditTrigger = `fail_stale_team_audit_${schemaName}`;
    await adminPool.query(`CREATE FUNCTION "${schemaName}"."${staleAuditTrigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason = 'stale_cleanup' THEN RAISE EXCEPTION 'injected team stale audit failure'; END IF; RETURN NEW; END $$`);
    await adminPool.query(`CREATE TRIGGER fail_stale_team_audit BEFORE INSERT ON "${schemaName}".team_security_audit FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${staleAuditTrigger}"()`);
    try {
      await expect(runAutoClean(
        { olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 },
        { userId: 'pg-test-owner', teamIds: [team.id] },
      )).rejects.toThrow('Failed query: insert into "team_security_audit"');
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [auditRollbackMemory.id])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`, [auditRollbackMemory.id])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(
        `SELECT id FROM "${schemaName}".trust_audit_log WHERE resource_hash = $1 AND decision = 'allow' AND reason = 'memory_delete'`,
        [createHash('sha256').update(auditRollbackMemory.id).digest('hex')],
      )).toMatchObject({ rowCount: 0 });
    } finally {
      await adminPool.query(`DROP TRIGGER fail_stale_team_audit ON "${schemaName}".team_security_audit`);
      await adminPool.query(`DROP FUNCTION "${schemaName}"."${staleAuditTrigger}"()`);
    }

    const strictWrite = await rememberMemory({
      content: 'PostgreSQL strict signed memory capture integration check.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
      teamId: team.id,
    });
    const [strictSource] = await adminPool.query(
      `SELECT id, project_id, user_id, team_id, type, content, metadata, confidence_level, importance_score FROM "${schemaName}".memories WHERE id = $1`,
      [strictWrite.id],
    ).then((result) => result.rows);
    expect(strictSource).toMatchObject({
      id: strictWrite.id,
      team_id: team.id,
      type: 'fact',
      content: strictWrite.content,
      confidence_level: 'speculative',
    });
    expect(strictSource.importance_score).toBeGreaterThanOrEqual(0);
    expect(strictSource.importance_score).toBeLessThanOrEqual(100);
    expect(verifyMemoryProvenance({
      content: strictSource.content,
      projectId: strictSource.project_id,
      type: strictSource.type,
      ownerId: strictSource.user_id,
      teamId: strictSource.team_id,
      sourceMemoryId: strictSource.id,
      metadata: strictSource.metadata,
    })).toBe(true);
    const queryVector = Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0);
    const vectorLiteral = `[${queryVector.join(',')}]`;
    await adminPool.query(
      `UPDATE "${schemaName}".memories SET embedding = $1::vector WHERE id = $2`,
      [vectorLiteral, strictWrite.id],
    );
    const strictContext = await buildStrictMemoryCandidateFilter({ userId: 'pg-test-owner' });
    const nativeDb = await getDb();
    const vectorResults = await vectorSearch({
      query: 'unused precomputed vector',
      project: strictProjectPath,
      user: 'pg-test-owner',
      teamId: team.id,
    }, { limit: 5, candidateFilter: strictContext }, queryVector, {
      db: nativeDb,
      dbClient: createDatabaseClient(nativeDb),
    });
    expect(vectorResults.find((result) => result.id === strictWrite.id)?.similarity).toBeCloseTo(1, 5);

    const referenceDate = new Date();
    const candidateInput = {
      query: '',
      project: strictProjectPath,
      user: 'pg-test-owner',
      referenceDate,
    };
    const aclOwnerId = await resolvePersistedUserId('pg-test-owner');
    if (!aclOwnerId) throw new Error('PostgreSQL fixture owner was not persisted');

    const ownerRestrictedTeamMemory = await rememberMemory({
      content: 'An explicit owner-only ACL must override team candidate visibility.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
      teamId: team.id,
    });
    await adminPool.query(
      `INSERT INTO "${schemaName}".visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
       VALUES ($1, 'memory', $2, 'allow', 'user', $3, 'read')`,
      [randomUUID(), ownerRestrictedTeamMemory.id, aclOwnerId],
    );

    const malformedGrantMemory = await rememberMemory({
      content: 'An unknown visibility permission must not enter strict candidates.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
    });
    const memberId = await resolvePersistedUserId('pg-test-member');
    if (!memberId) throw new Error('PostgreSQL fixture member was not persisted');
    await adminPool.query(
      `INSERT INTO "${schemaName}".visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
       VALUES ($1, 'memory', $2, 'allow', 'user', $3, 'admin')`,
      [randomUUID(), malformedGrantMemory.id, memberId],
    );

    const endedMemory = await rememberMemory({
      content: 'A memory whose valid-time interval has ended must not enter candidates.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
    });
    const futureMemory = await rememberMemory({
      content: 'A memory whose valid-time interval has not started must not enter candidates.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
    });
    await adminPool.query(
      `UPDATE "${schemaName}".memories SET valid_to = $1 WHERE id = $2`,
      [new Date(referenceDate.getTime() - 1_000), endedMemory.id],
    );
    await adminPool.query(
      `UPDATE "${schemaName}".memories SET valid_from = $1 WHERE id = $2`,
      [new Date(referenceDate.getTime() + 60_000), futureMemory.id],
    );

    const ownerFilter = await buildStrictMemoryCandidateFilter({ userId: 'pg-test-owner' });
    const ownerCandidates = await getPostgresMemoryCandidates(candidateInput, { candidateFilter: ownerFilter });
    expect(ownerCandidates.map((row) => row.id)).toContain(ownerRestrictedTeamMemory.id);
    expect(ownerCandidates.map((row) => row.id)).not.toContain(malformedGrantMemory.id);
    expect(ownerCandidates.map((row) => row.id)).not.toContain(endedMemory.id);
    expect(ownerCandidates.map((row) => row.id)).not.toContain(futureMemory.id);

    process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-member';
    try {
      const memberFilter = await buildStrictMemoryCandidateFilter({ userId: 'pg-test-member' });
      const memberCandidates = await getPostgresMemoryCandidates({
        ...candidateInput,
        user: 'pg-test-member',
        teamId: team.id,
      }, { candidateFilter: memberFilter });
      expect(memberCandidates.map((row) => row.id)).not.toContain(ownerRestrictedTeamMemory.id);
      expect(memberCandidates.map((row) => row.id)).not.toContain(malformedGrantMemory.id);
    } finally {
      process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-owner';
    }

    const strictProject = await adminPool.query(
      `SELECT id FROM "${schemaName}".projects WHERE path = $1`,
      [strictProjectPath],
    ).then((result) => result.rows[0]);
    const [strictProjection] = await adminPool.query(
      `SELECT id, content, metadata FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`,
      [strictWrite.id],
    ).then((result) => result.rows);
    const [strictQueue] = await adminPool.query(
      `SELECT status FROM "${schemaName}".memory_analysis_jobs WHERE source_memory_id = $1`,
      [strictWrite.id],
    ).then((result) => result.rows);
    const [strictAudit] = await adminPool.query(
      `SELECT action FROM "${schemaName}".knowledge_audit_log WHERE knowledge_id = $1`,
      [strictProjection.id],
    ).then((result) => result.rows);
    expect(strictProjection).toMatchObject({ content: strictWrite.content });
    expect(strictProjection.metadata.sourceMemoryId).toBe(strictWrite.id);
    expect(strictQueue).toMatchObject({ status: 'pending' });
    expect(strictAudit).toMatchObject({ action: 'create' });

    const personalWrite = await rememberMemory({
      content: 'PostgreSQL strict signed personal source for team promotion.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
    });
    const [personalSource] = await adminPool.query(
      `UPDATE "${schemaName}".memories SET importance_score = 90, access_count = 3 WHERE id = $1
       RETURNING id, project_id, user_id, type, content, metadata`,
      [personalWrite.id],
    ).then((result) => result.rows);
    expect(personalSource?.id).toBe(personalWrite.id);
    await expect(getCompileStats({ ownerUserId: personalSource.user_id, projectId: personalSource.project_id, minImportance: 0.1, minAccessCount: 2 }))
      .resolves.toEqual({ eligible: 1, totalPersonal: 1, totalTeam: 3 });
    const promotion = await compileTeamMemories({
      teamId: team.id,
      user: 'pg-test-owner',
      ownerUserId: personalSource.user_id,
      minImportance: 0.1,
      minAccessCount: 2,
      authorizeCandidate: async (candidate) => candidate.id === personalSource.id
        ? { ...candidate, metadata: personalSource.metadata }
        : null,
    });
    if (promotion.promoted !== 1) throw new Error(`Promotion fixture failed: ${JSON.stringify(promotion)}`);
    expect(promotion.promoted).toBe(1);
    const promotedId = promotion.teamMemoryIds[0]!;
    const [promotedSource] = await adminPool.query(
      `SELECT team_id, user_id, content FROM "${schemaName}".memories WHERE id = $1`,
      [promotedId],
    ).then((result) => result.rows);
    expect(promotedSource).toMatchObject({ team_id: team.id, user_id: personalSource.user_id, content: personalWrite.content });
    expect(await adminPool.query(
      `SELECT id FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`,
      [promotedId],
    )).toMatchObject({ rowCount: 1 });
    expect(await adminPool.query(
      `SELECT action, decision FROM "${schemaName}".team_security_audit WHERE target_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    )).toMatchObject({ rows: [{ action: 'promote_memory', decision: 'allow' }] });


    const tamperedContent = `${personalWrite.content} changed after candidate selection`;
    const stalePromotion = await compileTeamMemories({
      teamId: team.id,
      user: 'pg-test-owner',
      ownerUserId: personalSource.user_id,
      minImportance: 0.1,
      minAccessCount: 2,
      authorizeCandidate: async (candidate) => {
        if (candidate.id !== personalSource.id) return null;
        await adminPool.query(`UPDATE "${schemaName}".memories SET content = $1 WHERE id = $2`, [tamperedContent, candidate.id]);
        return { ...candidate, metadata: personalSource.metadata };
      },
    });
    expect(stalePromotion.promoted).toBe(0);
    expect(stalePromotion.errors[0]).toContain('changed or became ineligible before commit');
    expect(await adminPool.query(
      `SELECT id FROM "${schemaName}".memories WHERE metadata->>'promotionSourceId' = $1`,
      [personalSource.id],
    )).toMatchObject({ rowCount: 1 });
    await adminPool.query(`UPDATE "${schemaName}".memories SET content = $1 WHERE id = $2`, [personalWrite.content, personalSource.id]);

    await adminPool.query(
      `UPDATE "${schemaName}".memories SET access_count = 4 WHERE id = $1`,
      [personalSource.id],
    );
    const promotionAuditTrigger = `fail_promotion_audit_${schemaName}`;
    await adminPool.query(`CREATE FUNCTION "${schemaName}"."${promotionAuditTrigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'promote_memory' THEN RAISE EXCEPTION 'injected promotion audit failure'; END IF; RETURN NEW; END $$`);
    await adminPool.query(`CREATE TRIGGER fail_promotion_audit BEFORE INSERT ON "${schemaName}".team_security_audit FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${promotionAuditTrigger}"()`);
    try {
      const failedPromotion = await compileTeamMemories({
        teamId: team.id,
        user: 'pg-test-owner',
        ownerUserId: personalSource.user_id,
        minImportance: 0.1,
        minAccessCount: 2,
        authorizeCandidate: async (candidate) => candidate.id === personalSource.id
          ? { ...candidate, metadata: personalSource.metadata }
          : null,
      });
      expect(failedPromotion.promoted).toBe(0);
      expect(failedPromotion.errors.some((error) => error.includes(`Failed to promote ${personalSource.id}`))).toBe(true);
      expect(await adminPool.query(
        `SELECT id FROM "${schemaName}".memories WHERE metadata->>'promotionSourceId' = $1`,
        [personalSource.id],
      )).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(
        `SELECT id FROM "${schemaName}".knowledge WHERE metadata->>'promotionSourceId' = $1`,
        [personalSource.id],
      )).toMatchObject({ rowCount: 1 });
    } finally {
      await adminPool.query(`DROP TRIGGER fail_promotion_audit ON "${schemaName}".team_security_audit`);
      await adminPool.query(`DROP FUNCTION "${schemaName}"."${promotionAuditTrigger}"()`);
    }

    const edgeId = randomUUID();
    const captureEdgeTime = new Date(Date.now() - 60_000);
    await db.insert(knowledgeEdges).values({
      id: edgeId,
      fromId: strictProjection.id,
      fromKind: 'knowledge',
      toId: randomUUID(),
      toKind: 'entity',
      edgeType: 'mentions',
      weight: 1,
      metadata: { sourceMemoryId: strictWrite.id },
      createdAt: captureEdgeTime,
      validFrom: captureEdgeTime,
      validTo: null,
      recordedAt: captureEdgeTime,
      recordedTo: null,
    });
    const snapshotId = randomUUID();
    await adminPool.query(
      `INSERT INTO "${schemaName}".memory_snapshots (id, memory_id, snapshot_type, content) VALUES ($1, $2, 'correction', 'pre-forget snapshot')`,
      [snapshotId, strictWrite.id],
    );
    const ownerResults = await search({
      query: 'PostgreSQL strict signed memory capture integration check',
      project: strictProjectPath,
      user: 'pg-test-owner',
      teamId: team.id,
      limit: 5,
    });
    expect(ownerResults.some((result) => result.id === strictWrite.id)).toBe(true);
    // An explicit visibility rule is authoritative over the private-owner
    // fallback. Grants can be stored against the internal user ID even when
    // the request principal is external, so PostgreSQL candidate prefiltering
    // must recognize both identities just like SQLite does.
    const ownerCanonicalId = await resolvePersistedUserId('pg-test-owner');
    expect(ownerCanonicalId).toBeTruthy();
    await adminPool.query(
      `INSERT INTO "${schemaName}".visibility_rules
        (asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
       VALUES ('memory', $1, 'access', 'user', $2, 'read'),
              ('memory', $1, 'access', 'team', $3, 'read')`,
      [strictWrite.id, ownerCanonicalId, team.id],
    );
    const canonicalGrantResults = await search({
      query: 'PostgreSQL strict signed memory capture integration check',
      project: strictProjectPath,
      user: 'pg-test-owner',
      teamId: team.id,
      limit: 5,
    });
    expect(canonicalGrantResults.some((result) => result.id === strictWrite.id)).toBe(true);
    process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-member';
    try {
      const memberResults = await search({
        query: 'PostgreSQL strict signed memory capture integration check',
        project: strictProjectPath,
        user: 'pg-test-member',
        teamId: team.id,
        limit: 5,
      });
      expect(memberResults.some((result) => result.id === strictWrite.id)).toBe(true);
    } finally {
      process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-owner';
    }
    process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-outsider';
    try {
      const outsiderResults = await search({
        query: 'PostgreSQL strict signed memory capture integration check',
        project: strictProjectPath,
        user: 'pg-test-outsider',
        teamId: team.id,
        limit: 5,
      });
      expect(outsiderResults.some((result) => result.id === strictWrite.id)).toBe(false);
    } finally {
      process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-owner';
    }
    const jobsBeforeFailure = Number((await adminPool.query(
      `SELECT count(*)::int AS count FROM "${schemaName}".memory_analysis_jobs`,
    )).rows[0]?.count ?? -1);
    const strictDenialsBeforeDelete = Number((await adminPool.query(
      `SELECT count(*)::int AS count FROM "${schemaName}".trust_audit_log WHERE asset_type = 'memory' AND decision = 'deny'`,
    )).rows[0]?.count ?? -1);

    const auditFailureFunction = `fail_knowledge_audit_${schemaName}`;
    await adminPool.query(`CREATE FUNCTION "${schemaName}"."${auditFailureFunction}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected knowledge audit failure'; END $$`);
    await adminPool.query(`CREATE TRIGGER fail_knowledge_audit BEFORE INSERT ON "${schemaName}".knowledge_audit_log FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${auditFailureFunction}"()`);
    const failedCapturePath = `/pg-strict-capture-rollback-${randomUUID()}`;
    try {
      await expect(rememberMemory({
        content: 'PostgreSQL strict capture must roll back when its audit fails.',
        type: 'fact',
        project: failedCapturePath,
        user: 'pg-test-owner',
        teamId: team.id,
      })).rejects.toThrow('Failed query: insert into "knowledge_audit_log"');
      expect(await adminPool.query(
        `SELECT id FROM "${schemaName}".memories WHERE content = $1`,
        ['PostgreSQL strict capture must roll back when its audit fails.'],
      )).toMatchObject({ rowCount: 0 });
      expect(await adminPool.query(
        `SELECT id FROM "${schemaName}".knowledge WHERE content = $1`,
        ['PostgreSQL strict capture must roll back when its audit fails.'],
      )).toMatchObject({ rowCount: 0 });
      expect(await adminPool.query(
        `SELECT count(*)::int AS count FROM "${schemaName}".memory_analysis_jobs`,
      )).toMatchObject({ rows: [{ count: jobsBeforeFailure }] });
    } finally {
      await adminPool.query(`DROP TRIGGER fail_knowledge_audit ON "${schemaName}".knowledge_audit_log`);
      await adminPool.query(`DROP FUNCTION "${schemaName}"."${auditFailureFunction}"()`);
    }
    const strictDeleteWrite = await rememberMemory({
      content: 'Strict PostgreSQL forget must bind authorization, audit, and deletion atomically.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
      teamId: team.id,
    });
    const strictDeleteBeliefId = randomUUID();
    const strictDeleteLegacyBeliefId = randomUUID();
    await adminPool.query(
      `INSERT INTO "${schemaName}".knowledge
        (id, project_id, knowledge_kind, knowledge_type, content, metadata)
        VALUES ($1, $2, 'belief', 'constraint', 'derived belief to remove on source forget', $3::jsonb),
          ($4, $2, 'belief', 'decision', 'legacy linked belief to remove on source forget', '{}'::jsonb)`,
      [strictDeleteBeliefId, strictDeleteWrite.projectId, JSON.stringify({ sourceMemoryId: strictDeleteWrite.id }), strictDeleteLegacyBeliefId],
    );
    await adminPool.query(
      `INSERT INTO "${schemaName}".knowledge_edges
        (id, from_id, from_kind, to_id, to_kind, edge_type)
        VALUES ($1, $2, 'knowledge', $3, 'knowledge', 'sourced_from'),
          ($4, $5, 'knowledge', $3, 'knowledge', 'sourced_from')`,
      [randomUUID(), strictDeleteBeliefId, strictDeleteWrite.id, randomUUID(), strictDeleteLegacyBeliefId],
    );
    const strictDeleteSnapshotId = randomUUID();
    await adminPool.query(
      `INSERT INTO "${schemaName}".memory_snapshots (id, memory_id, snapshot_type, content) VALUES ($1, $2, 'correction', 'strict forget rollback snapshot')`,
      [strictDeleteSnapshotId, strictDeleteWrite.id],
    );
    const strictDeleteAuditFunction = `fail_strict_memory_delete_${schemaName}`;
    await adminPool.query(`CREATE FUNCTION "${schemaName}"."${strictDeleteAuditFunction}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.decision = 'allow' AND NEW.reason = 'memory_delete' THEN RAISE EXCEPTION 'injected strict memory-delete audit failure'; END IF; RETURN NEW; END $$`);
    await adminPool.query(`CREATE TRIGGER fail_strict_memory_delete BEFORE INSERT ON "${schemaName}".trust_audit_log FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${strictDeleteAuditFunction}"()`);
    try {
      await expect(deleteMemoryPermanently(strictDeleteWrite.id)).rejects.toThrow('Failed query: insert into "trust_audit_log"');
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [strictDeleteWrite.id])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`, [strictDeleteWrite.id])).toMatchObject({ rowCount: 2 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE id = $1`, [strictDeleteBeliefId])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE id = $1`, [strictDeleteLegacyBeliefId])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".memory_snapshots WHERE id = $1`, [strictDeleteSnapshotId])).toMatchObject({ rowCount: 1 });
    } finally {
      await adminPool.query(`DROP TRIGGER fail_strict_memory_delete ON "${schemaName}".trust_audit_log`);
      await adminPool.query(`DROP FUNCTION "${schemaName}"."${strictDeleteAuditFunction}"()`);
    }
    await deleteMemoryPermanently(strictDeleteWrite.id);
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [strictDeleteWrite.id])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`, [strictDeleteWrite.id])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE id = $1`, [strictDeleteBeliefId])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE id = $1`, [strictDeleteLegacyBeliefId])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memory_snapshots WHERE id = $1`, [strictDeleteSnapshotId])).toMatchObject({ rowCount: 0 });
    const strictDeleteAllow = await adminPool.query(
      `SELECT actor_hash, resource_hash FROM "${schemaName}".trust_audit_log WHERE decision = 'allow' AND reason = 'memory_delete' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(strictDeleteAllow.rowCount).toBe(1);
    expect(strictDeleteAllow.rows[0]?.actor_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(strictDeleteAllow.rows[0]?.resource_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(strictDeleteAllow.rows[0]?.resource_hash).not.toBe(strictDeleteWrite.id);

    process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-outsider';
    await expect(deleteMemoryPermanently(strictWrite.id)).rejects.toThrow(
      'Strict trust policy denied deletion of an unsigned, inactive, expired, or inaccessible memory',
    );
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [strictWrite.id])).toMatchObject({ rowCount: 1 });
    expect(await adminPool.query(
      `SELECT count(*)::int AS count FROM "${schemaName}".trust_audit_log WHERE asset_type = 'memory' AND decision = 'deny'`,
    )).toMatchObject({ rows: [{ count: strictDenialsBeforeDelete + 1 }] });

    process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-owner';
    const strictBatchPersonal = await rememberMemory({
      content: 'Strict PostgreSQL batch cleanup removes only caller-owned personal memories.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
    });
    const strictBatchTeam = await rememberMemory({
      content: 'Strict PostgreSQL batch cleanup preserves team-scoped memories.',
      type: 'fact',
      project: strictProjectPath,
      user: 'pg-test-owner',
      teamId: team.id,
    });
    const strictBatchCreatedAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    for (const memory of [strictBatchPersonal, strictBatchTeam]) {
      await adminPool.query(
        `UPDATE "${schemaName}".memories SET created_at = $1, confidence_level = 'outdated', importance_score = 1 WHERE id = $2`,
        [strictBatchCreatedAt, memory.id],
      );
    }
    const strictBatchAuditFunction = `fail_strict_batch_delete_${schemaName}`;
    await adminPool.query(`CREATE FUNCTION "${schemaName}"."${strictBatchAuditFunction}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'delete' THEN RAISE EXCEPTION 'injected strict batch-delete audit failure'; END IF; RETURN NEW; END $$`);
    await adminPool.query(`CREATE TRIGGER fail_strict_batch_delete BEFORE INSERT ON "${schemaName}".knowledge_audit_log FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${strictBatchAuditFunction}"()`);
    const strictBatchAllowsBefore = await adminPool.query(
      `SELECT count(*)::int AS count FROM "${schemaName}".trust_audit_log WHERE decision = 'allow' AND reason = 'memory_delete'`,
    );
    try {
      await expect(runAutoClean({ olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 20, projectId: strictBatchPersonal.projectId ?? undefined }))
        .rejects.toThrow('Failed query: insert into "knowledge_audit_log"');
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = ANY($1::uuid[])`, [[strictBatchPersonal.id, strictBatchTeam.id]])).toMatchObject({ rowCount: 2 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = ANY($1::text[])`, [[strictBatchPersonal.id, strictBatchTeam.id]])).toMatchObject({ rowCount: 2 });
      expect(await adminPool.query(
        `SELECT count(*)::int AS count FROM "${schemaName}".trust_audit_log WHERE decision = 'allow' AND reason = 'memory_delete'`,
      )).toMatchObject({ rows: [{ count: strictBatchAllowsBefore.rows[0]?.count }] });
    } finally {
      await adminPool.query(`DROP TRIGGER fail_strict_batch_delete ON "${schemaName}".knowledge_audit_log`);
      await adminPool.query(`DROP FUNCTION "${schemaName}"."${strictBatchAuditFunction}"()`);
    }
    const strictBatchCleanup = await runAutoClean({
      olderThanDays: 30,
      confidenceLevels: ['outdated'],
      minImportance: 20,
      projectId: strictBatchPersonal.projectId ?? undefined,
    });
    expect(strictBatchCleanup.deleted).toBe(1);
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [strictBatchPersonal.id])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [strictBatchTeam.id])).toMatchObject({ rowCount: 1 });

    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    const deleteAuditFailureFunction = `fail_memory_delete_audit_${schemaName}`;
    await adminPool.query(`CREATE FUNCTION "${schemaName}"."${deleteAuditFailureFunction}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'delete' THEN RAISE EXCEPTION 'injected memory delete audit failure'; END IF; RETURN NEW; END $$`);
    await adminPool.query(`CREATE TRIGGER fail_memory_delete_audit BEFORE INSERT ON "${schemaName}".knowledge_audit_log FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${deleteAuditFailureFunction}"()`);
    try {
      await expect(deleteMemoryPermanently(strictWrite.id)).rejects.toThrow('Failed query: insert into "knowledge_audit_log"');
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [strictWrite.id])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`, [strictWrite.id])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".memory_analysis_jobs WHERE source_memory_id = $1`, [strictWrite.id])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".memory_snapshots WHERE id = $1`, [snapshotId])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge_edges WHERE id = $1 AND recorded_to IS NULL`, [edgeId])).toMatchObject({ rowCount: 1 });
    } finally {
      await adminPool.query(`DROP TRIGGER fail_memory_delete_audit ON "${schemaName}".knowledge_audit_log`);
      await adminPool.query(`DROP FUNCTION "${schemaName}"."${deleteAuditFailureFunction}"()`);
    }
    await deleteMemoryPermanently(strictWrite.id);
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [strictWrite.id])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`, [strictWrite.id])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memory_analysis_jobs WHERE source_memory_id = $1`, [strictWrite.id])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memory_snapshots WHERE id = $1`, [snapshotId])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge_edges WHERE id = $1 AND recorded_to IS NOT NULL`, [edgeId])).toMatchObject({ rowCount: 1 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge_edges WHERE from_id = $1 AND from_kind = 'knowledge' AND to_kind = 'entity' AND recorded_to IS NULL AND valid_to IS NOT NULL`, [strictProjection.id])).toMatchObject({ rowCount: 1 });
    expect(await adminPool.query(`SELECT action FROM "${schemaName}".knowledge_audit_log WHERE knowledge_id = $1 ORDER BY created_at DESC LIMIT 1`, [strictProjection.id])).toMatchObject({ rows: [{ action: 'delete' }] });

    const staleProjectPath = `/pg-stale-cleanup-${randomUUID()}`;
    const staleWrite = await rememberMemory({
      content: 'PostgreSQL stale cleanup rollback and selection integration check.',
      type: 'fact',
      project: staleProjectPath,
      user: 'pg-test-owner',
    });
    const pinnedWrite = await rememberMemory({
      content: 'Pinned PostgreSQL stale cleanup control remains protected.',
      type: 'fact',
      project: staleProjectPath,
      user: 'pg-test-owner',
    });
    const staleCreatedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await adminPool.query(
      `UPDATE "${schemaName}".memories SET created_at = $1, confidence_level = 'outdated', importance_score = 5 WHERE id = $2`,
      [staleCreatedAt, staleWrite.id],
    );
    await adminPool.query(
      `UPDATE "${schemaName}".memories SET created_at = $1, confidence_level = 'outdated', importance_score = 5, is_pinned = true WHERE id = $2`,
      [staleCreatedAt, pinnedWrite.id],
    );
    const staleSnapshotId = randomUUID();
    const staleProjectId = (await adminPool.query(
      `SELECT project_id FROM "${schemaName}".memories WHERE id = $1`,
      [staleWrite.id],
    )).rows[0]?.project_id as string;
    await adminPool.query(
      `INSERT INTO "${schemaName}".memory_snapshots (id, memory_id, snapshot_type, content) VALUES ($1, $2, 'correction', 'stale cleanup rollback snapshot')`,
      [staleSnapshotId, staleWrite.id],
    );
    const staleAuditFailureFunction = `fail_stale_delete_audit_${schemaName}`;
    await adminPool.query(`CREATE FUNCTION "${schemaName}"."${staleAuditFailureFunction}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'delete' THEN RAISE EXCEPTION 'injected stale cleanup audit failure'; END IF; RETURN NEW; END $$`);
    await adminPool.query(`CREATE TRIGGER fail_stale_delete_audit BEFORE INSERT ON "${schemaName}".knowledge_audit_log FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${staleAuditFailureFunction}"()`);
    try {
      await expect(runAutoClean({
        olderThanDays: 30,
        confidenceLevels: ['outdated'],
        minImportance: 20,
        projectId: staleProjectId,
      })).rejects.toThrow('Failed query: insert into "knowledge_audit_log"');
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [staleWrite.id])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`, [staleWrite.id])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".memory_analysis_jobs WHERE source_memory_id = $1`, [staleWrite.id])).toMatchObject({ rowCount: 1 });
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".memory_snapshots WHERE id = $1`, [staleSnapshotId])).toMatchObject({ rowCount: 1 });
    } finally {
      await adminPool.query(`DROP TRIGGER fail_stale_delete_audit ON "${schemaName}".knowledge_audit_log`);
      await adminPool.query(`DROP FUNCTION "${schemaName}"."${staleAuditFailureFunction}"()`);
    }
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    const cleanup = await runAutoClean({
      olderThanDays: 30,
      confidenceLevels: ['outdated'],
      minImportance: 20,
      projectId: staleProjectId,
    });
    expect(cleanup.deleted).toBe(1);
    expect(cleanup.summary).toMatchObject({ scanned: 2, skippedPinned: 1 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [staleWrite.id])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".knowledge WHERE metadata->>'sourceMemoryId' = $1`, [staleWrite.id])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memory_analysis_jobs WHERE source_memory_id = $1`, [staleWrite.id])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memory_snapshots WHERE id = $1`, [staleSnapshotId])).toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [pinnedWrite.id])).toMatchObject({ rowCount: 1 });
    process.env.SQUISH_TRUST_POLICY = 'strict';
    const invitation = await invoke({ action: 'invite', teamId: team.id, email: 'invite@example.test' });
    expect(JSON.parse((invitation as { content: Array<{ text: string }> }).content[0]!.text).ok).toBe(true);

    const ownerId = await resolvePersistedUserId('pg-test-owner');
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      name: 'Strict PostgreSQL team test',
      path: `/strict-postgres-team-${projectId}`,
    });
    const memoryId = randomUUID();
    await db.insert(memories).values({
      id: memoryId,
      userId: ownerId,
      projectId,
      teamId: team.id,
      type: 'fact',
      content: 'trusted PostgreSQL test memory',
      confidence: 92,
      tags: ['strict', 'postgres'],
      metadata: { origin: 'schema-parity-test' },
      isPinned: true,
      writeScope: ['owner'],
      readScope: ['owner', 'member'],
      validFrom: new Date('2026-01-01T00:00:00Z'),
      recordedAt: new Date('2026-02-01T00:00:00Z'),
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    });
    const [persistedMemory] = await adminPool.query(
      `SELECT confidence, tags, metadata, is_pinned, write_scope, read_scope, valid_from, recorded_at, expires_at FROM "${schemaName}".memories WHERE id = $1`,
      [memoryId],
    ).then((result) => result.rows);
    expect(persistedMemory).toMatchObject({
      confidence: 92,
      tags: ['strict', 'postgres'],
      metadata: { origin: 'schema-parity-test' },
      is_pinned: true,
      write_scope: ['owner'],
      read_scope: ['owner', 'member'],
      valid_from: new Date('2026-01-01T00:00:00Z'),
      recorded_at: new Date('2026-02-01T00:00:00Z'),
      expires_at: new Date('2027-01-01T00:00:00Z'),
    });
    await db.insert(memoryAnalysisJobs).values({
      sourceMemoryId: memoryId,
      projectId,
      jobKind: 'analyze_memory',
    });
    const shared = await invoke({ action: 'share_memory', teamId: team.id, memoryId });
    expect(JSON.parse((shared as { content: Array<{ text: string }> }).content[0]!.text).ok).toBe(true);
    expect(await getMemorySharedTeams(memoryId)).toHaveLength(1);

    const unshared = await invoke({ action: 'unshare_memory', teamId: team.id, memoryId });
    expect(JSON.parse((unshared as { content: Array<{ text: string }> }).content[0]!.text).removed).toBe(true);
    const reshared = await invoke({ action: 'share_memory', teamId: team.id, memoryId });
    expect(JSON.parse((reshared as { content: Array<{ text: string }> }).content[0]!.text).ok).toBe(true);
    const removed = await invoke({ action: 'remove_member', teamId: team.id, userId: 'pg-test-member' });
    expect(JSON.parse((removed as { content: Array<{ text: string }> }).content[0]!.text).removed).toBe(true);
    const deleted = await invoke({ action: 'delete', teamId: team.id });
    expect(JSON.parse((deleted as { content: Array<{ text: string }> }).content[0]!.text).deleted).toBe(true);
    expect(await getTeam(team.id)).toBeNull();
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".team_members WHERE team_id = $1`, [team.id]))
      .toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".team_invitations WHERE team_id = $1`, [team.id]))
      .toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".team_shares WHERE team_id = $1`, [team.id]))
      .toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT team_id FROM "${schemaName}".memories WHERE id = $1`, [memoryId]))
      .toMatchObject({ rows: [{ team_id: null }] });
    expect(await adminPool.query(`SELECT source_memory_id FROM "${schemaName}".memory_analysis_jobs WHERE source_memory_id = $1`, [memoryId]))
      .toMatchObject({ rowCount: 1 });

    await adminPool.query(`DELETE FROM "${schemaName}".projects WHERE id = $1`, [projectId]);
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE id = $1`, [memoryId]))
      .toMatchObject({ rowCount: 0 });
    expect(await adminPool.query(`SELECT id FROM "${schemaName}".memory_analysis_jobs WHERE source_memory_id = $1`, [memoryId]))
      .toMatchObject({ rowCount: 0 });

    const auditRows = await adminPool.query(`SELECT actor_hash, team_hash, target_hash FROM "${schemaName}".team_security_audit`);
    expect(auditRows.rowCount ?? 0).toBeGreaterThan(0);
    expect(auditRows.rows.every((row) => !row.actor_hash.includes('pg-test-owner'))).toBe(true);
  }, 20_000);

  postgresTest('PostgreSQL host capture receipts deduplicate retries and reject key reuse', { timeout: 20_000 }, async () => {
    const { getOrCreateProject } = await import('../../core/projects.js');
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
    };
    const keyPair = generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'pg-test-owner';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ 'pg-capture-idempotency-test': publicKey });
    process.env.SQUISH_PROVENANCE_KEY_ID = 'pg-capture-idempotency-test';
    const captureKey = `pg-host-replay-${randomUUID()}`;
    const content = 'PostgreSQL host capture idempotency regression fixture.';
    const projectPath = `/pg-capture-receipt-${randomUUID()}`;
    const differentProjectPath = `/pg-capture-receipt-scope-${randomUUID()}`;
    const scope = { content, type: 'fact' as const, project: projectPath, user: 'pg-test-owner', captureKey };
    const failedContent = 'PostgreSQL capture receipt and source must roll back together.';
    const failedCaptureKey = `pg-host-rollback-${randomUUID()}`;
    const failedCaptureHash = createHash('sha256').update(failedCaptureKey).digest('hex');
    const triggerFn = `fail_capture_projection_${randomUUID().replaceAll('-', '')}`;
    try {
      await getOrCreateProject(projectPath);
      await getOrCreateProject(differentProjectPath);
      const [first, replay] = await Promise.all([rememberMemory(scope), rememberMemory(scope)]);
      expect(replay.id).toBe(first.id);

      const captureKeyHash = createHash('sha256').update(captureKey).digest('hex');
      const contentHash = createHash('sha256').update(content).digest('hex');
      expect(await adminPool.query(
        `SELECT capture_key_hash, content_hash, memory_id FROM "${schemaName}".memory_capture_receipts WHERE capture_key_hash = $1`,
        [captureKeyHash],
      )).toMatchObject({ rows: [{ capture_key_hash: captureKeyHash, content_hash: contentHash, memory_id: first.id }] });
      expect(await adminPool.query(
        `SELECT id FROM "${schemaName}".memories WHERE id = $1`, [first.id],
      )).toMatchObject({ rowCount: 1 });

      await expect(rememberMemory({ ...scope, content: `${content} changed` }))
        .rejects.toThrow('Capture key was already used for different content or memory scope');
      await expect(rememberMemory({ ...scope, project: differentProjectPath }))
        .rejects.toThrow('Capture key was already used for different content or memory scope');

      await adminPool.query(`DELETE FROM "${schemaName}".memories WHERE id = $1`, [first.id]);
      expect(await adminPool.query(
        `SELECT capture_key_hash FROM "${schemaName}".memory_capture_receipts WHERE capture_key_hash = $1`,
        [captureKeyHash],
      )).toMatchObject({ rowCount: 0 });

      await adminPool.query(`CREATE FUNCTION "${schemaName}"."${triggerFn}"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.content = '${failedContent}' THEN RAISE EXCEPTION 'injected capture projection failure'; END IF; RETURN NEW; END $$`);
      await adminPool.query(`CREATE TRIGGER fail_capture_projection BEFORE INSERT ON "${schemaName}".knowledge
        FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${triggerFn}"()`);
      await expect(rememberMemory({
        content: failedContent,
        type: 'fact',
        project: projectPath,
        user: 'pg-test-owner',
        captureKey: failedCaptureKey,
      })).rejects.toThrow();
      expect(await adminPool.query(`SELECT id FROM "${schemaName}".memories WHERE content = $1`, [failedContent]))
        .toMatchObject({ rowCount: 0 });
      expect(await adminPool.query(
        `SELECT capture_key_hash FROM "${schemaName}".memory_capture_receipts WHERE capture_key_hash = $1`,
        [failedCaptureHash],
      )).toMatchObject({ rowCount: 0 });
      await adminPool.query(`DROP TRIGGER fail_capture_projection ON "${schemaName}".knowledge`);
      await adminPool.query(`DROP FUNCTION "${schemaName}"."${triggerFn}"()`);
    } finally {
      try { await adminPool.query(`DROP TRIGGER IF EXISTS fail_capture_projection ON "${schemaName}".knowledge`); } catch {}
      try { await adminPool.query(`DROP FUNCTION IF EXISTS "${schemaName}"."${triggerFn}"()`); } catch {}
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

  postgresTest('direct strict promotion inherits persisted source expiry when the caller omits it', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ 'pg-capture-test': publicKey });
    process.env.SQUISH_PROVENANCE_KEY_ID = 'pg-capture-test';
    process.env.SQUISH_TRUST_POLICY = 'strict';

    const user = 'pg-test-owner';
    const projectPath = `/pg-promotion-expiry-${randomUUID()}`;
    const source = await rememberMemory({
      content: 'PostgreSQL source lifetime must constrain a direct team promotion.',
      type: 'fact',
      project: projectPath,
      user,
    });
    const [persistedSource] = await adminPool.query(
      `UPDATE "${schemaName}".memories SET expires_at = $1, importance_score = 90, access_count = 3
       WHERE id = $2 RETURNING project_id, user_id, content, type`,
      [new Date(Date.now() + 60 * 60 * 1000), source.id],
    ).then((result) => result.rows);
    const sourceExpiry = await adminPool.query(
      `SELECT expires_at FROM "${schemaName}".memories WHERE id = $1`, [source.id],
    ).then((result) => result.rows[0]?.expires_at as Date);
    const teamId = randomUUID();
    await adminPool.query(`INSERT INTO "${schemaName}".teams (id, name, slug) VALUES ($1, 'Expiry Team', $2)`, [teamId, `expiry-${teamId}`]);
    await addTeamMember(teamId, user, 'owner');

    const promoted = await rememberMemoryWithAudit({
      content: persistedSource.content,
      type: persistedSource.type,
      project: projectPath,
      user,
      teamId,
      metadata: { promotedFrom: source.id, promotionSourceId: source.id },
    }, {
      actorId: user,
      teamId,
      action: 'promote_memory',
      decision: 'allow',
      reason: 'role_granted',
      targetId: source.id,
    }, {
      id: source.id,
      content: persistedSource.content,
      projectId: persistedSource.project_id,
      type: persistedSource.type,
      ownerId: persistedSource.user_id,
    });

    expect(await adminPool.query(
      `SELECT expires_at FROM "${schemaName}".memories WHERE id = $1`, [promoted.id],
    )).toMatchObject({ rows: [{ expires_at: sourceExpiry }] });
  }, 20_000);

  postgresTest('memory deletion preserves bi-temporal entity relation support', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    try {
      const projectPath = `/pg-graph-cleanup-${randomUUID()}`;
      const first = await rememberMemory({
        content: 'First PostgreSQL source supports the version relation.',
        type: 'fact', project: projectPath, user: 'pg-test-owner',
      });
      const second = await rememberMemory({
        content: 'Second PostgreSQL source supports the version relation.',
        type: 'fact', project: projectPath, user: 'pg-test-owner',
      });
      const fromId = randomUUID();
      const toId = randomUUID();
      const relationCreatedAt = new Date(Date.now() - 1_000);
      await adminPool.query(
        `INSERT INTO "${schemaName}".knowledge_edges
         (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at)
         VALUES ($1, $2, 'entity', $3, 'entity', 'supersedes_version', 2,
          $4::jsonb, $5, $5, $5)`,
        [randomUUID(), fromId, toId, JSON.stringify({ sourceMemoryIds: [first.id, second.id], context: 'Contract v2 supersedes Contract v1', confidence: 0.9 }), relationCreatedAt],
      );

      const failureFunction = `fail_entity_support_delete_${schemaName}`;
      await adminPool.query(`CREATE FUNCTION "${schemaName}"."${failureFunction}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${first.id}' THEN RAISE EXCEPTION 'injected entity support cleanup rollback'; END IF; RETURN OLD; END $$`);
      await adminPool.query(`CREATE TRIGGER fail_entity_support_delete BEFORE DELETE ON "${schemaName}".memories FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${failureFunction}"()`);
      try {
        await expect(deleteMemoryPermanently(first.id)).rejects.toThrow('Failed query: delete from "memories"');
        const unchanged = await adminPool.query(
          `SELECT metadata, recorded_to FROM "${schemaName}".knowledge_edges WHERE from_id = $1 AND to_id = $2 AND edge_type = 'supersedes_version'`,
          [fromId, toId],
        ).then((result) => result.rows as Array<{ metadata: Record<string, unknown>; recorded_to: Date | null }>);
        expect(unchanged).toHaveLength(1);
        expect(unchanged[0]!.recorded_to).toBeNull();
        expect(unchanged[0]!.metadata.sourceMemoryIds).toEqual([first.id, second.id]);
      } finally {
        await adminPool.query(`DROP TRIGGER fail_entity_support_delete ON "${schemaName}".memories`);
        await adminPool.query(`DROP FUNCTION "${schemaName}"."${failureFunction}"()`);
      }

      await deleteMemoryPermanently(first.id);
      const afterFirst = await adminPool.query(
        `SELECT metadata, recorded_to FROM "${schemaName}".knowledge_edges
         WHERE from_id = $1 AND to_id = $2 AND edge_type = 'supersedes_version' ORDER BY recorded_at`,
        [fromId, toId],
      ).then((result) => result.rows as Array<{ metadata: Record<string, unknown>; recorded_to: Date | null }>);
      expect(afterFirst.some((edge) => edge.recorded_to !== null
        && Array.isArray(edge.metadata.sourceMemoryIds)
        && edge.metadata.sourceMemoryIds.includes(first.id)
        && edge.metadata.sourceMemoryIds.includes(second.id))).toBe(true);
      expect(afterFirst.some((edge) => edge.recorded_to === null
        && JSON.stringify(edge.metadata.sourceMemoryIds) === JSON.stringify([second.id]))).toBe(true);

      await deleteMemoryPermanently(second.id);
      const afterFinal = await adminPool.query(
        `SELECT metadata, recorded_to FROM "${schemaName}".knowledge_edges
         WHERE from_id = $1 AND to_id = $2 AND edge_type = 'supersedes_version' ORDER BY recorded_at`,
        [fromId, toId],
      ).then((result) => result.rows as Array<{ metadata: Record<string, unknown>; recorded_to: Date | null }>);
      expect(afterFinal.length).toBeGreaterThan(0);
      expect(afterFinal.every((edge) => edge.recorded_to !== null)).toBe(true);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  }, 20_000);

  postgresTest('traverses graph views on PostgreSQL with bi-temporal filtering', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    try {
      const db = await getDb();
      const projectId = randomUUID();
      const fromId = randomUUID();
      const currentId = randomUUID();
      const futureId = randomUUID();
      const now = new Date();
      const before = new Date(now.getTime() - 2_000);
      const after = new Date(now.getTime() + 60_000);
      await db.insert(projects).values({ id: projectId, name: 'PostgreSQL graph view', path: `/pg-graph-view-${projectId}` });
      await db.insert(entities).values([
        { id: fromId, projectId, name: 'GraphRoot', type: 'concept' },
        { id: currentId, projectId, name: 'GraphCurrent', type: 'concept' },
        { id: futureId, projectId, name: 'GraphFuture', type: 'concept' },
      ]);
      await db.insert(knowledgeEdges).values([
        {
          id: randomUUID(), fromId, fromKind: 'entity', toId: currentId, toKind: 'entity',
          edgeType: 'references', weight: 1, metadata: { marker: 'postgres-jsonb' },
          createdAt: before, validFrom: before, recordedAt: before,
        },
        {
          id: randomUUID(), fromId, fromKind: 'entity', toId: futureId, toKind: 'entity',
          edgeType: 'references', weight: 1, createdAt: before, validFrom: after, recordedAt: before,
        },
      ]);
      expect((await adminPool.query(`SELECT id FROM "${schemaName}".knowledge_edges WHERE from_id = $1`, [fromId])).rowCount).toBe(2);

      const view = { viewType: 'entity' as const, edgeTypes: ['references'], orderBy: 'weight' as const, maxDepth: 1, minWeight: 0 };
      const current = await queryGraphView(fromId, 'entity', view, { validAt: now, recordedAt: now });
      expect(current.nodes.map((node) => node.id)).toEqual([currentId]);
      expect(current.edges).toHaveLength(1);
      expect(current.edges[0]?.metadata).toEqual({ marker: 'postgres-jsonb' });

      const later = await queryGraphView(fromId, 'entity', view, { validAt: after, recordedAt: now });
      expect(later.nodes.map((node) => node.id).sort()).toEqual([currentId, futureId].sort());
      expect(later.edges).toHaveLength(2);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  }, 20_000);

  postgresTest('reads canonical memory associations on PostgreSQL with bi-temporal filtering', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    try {
      const db = await getDb();
      const suffix = randomUUID();
      const fromId = `pg-association-from-${suffix}`;
      const toId = `pg-association-to-${suffix}`;
      const edgeId = `pg-association-edge-${suffix}`;
      const fromKnowledgeId = `pg-association-k-from-${suffix}`;
      const toKnowledgeId = `pg-association-k-to-${suffix}`;
      const now = new Date();
      const before = new Date(now.getTime() - 5_000);
      const after = new Date(now.getTime() + 60_000);
      await db.insert(knowledge).values([
        { id: fromKnowledgeId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Association from endpoint', metadata: { sourceMemoryId: fromId } },
        { id: toKnowledgeId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Association to endpoint', metadata: { sourceMemoryId: toId } },
      ]);
      await db.insert(knowledgeEdges).values([
        {
          id: edgeId, fromId: fromKnowledgeId, fromKind: 'knowledge', toId: toKnowledgeId, toKind: 'knowledge',
          edgeType: 'supports', weight: 0.75,
          metadata: { coactivation_count: 3, last_coactivated_at: before.toISOString() },
          createdAt: before, validFrom: before, recordedAt: before,
        },
        {
          id: `pg-association-future-${suffix}`, fromId: fromKnowledgeId, fromKind: 'knowledge', toId: toKnowledgeId, toKind: 'knowledge',
          edgeType: 'supports', weight: 1,
          createdAt: before, validFrom: after, recordedAt: before,
        },
      ]);
      const rows = await getMemoryAssociationRows([fromId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: edgeId,
        fromMemoryId: fromId,
        toMemoryId: toId,
        associationType: 'supports',
        weight: 0.75,
        coactivationCount: 3,
      });
      expect(rows[0]?.lastCoactivatedAt?.toISOString()).toBe(before.toISOString());
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  }, 20_000);

  postgresTest('creates, revises, and closes canonical associations on PostgreSQL', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    try {
      const db = await getDb();
      const suffix = randomUUID();
      const fromId = `pg-association-write-from-${suffix}`;
      const toId = `pg-association-write-to-${suffix}`;
      const fromKnowledgeId = `pg-association-write-k-from-${suffix}`;
      const toKnowledgeId = `pg-association-write-k-to-${suffix}`;
      await db.insert(knowledge).values([
        { id: fromKnowledgeId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Association write source', metadata: { sourceMemoryId: fromId } },
        { id: toKnowledgeId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Association write target', metadata: { sourceMemoryId: toId } },
      ]);
      await createAssociation(fromId, toId, 'supports', 0.75);
      const created = await getMemoryAssociationRows([fromId]);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ fromMemoryId: fromId, toMemoryId: toId, associationType: 'supports', weight: 0.75, coactivationCount: 1 });

      await createAssociation(fromId, toId, 'supports', 0.5);
      const revised = await getMemoryAssociationRows([fromId]);
      expect(revised).toHaveLength(1);
      expect(revised[0]).toMatchObject({ weight: 1.25, coactivationCount: 2 });
      expect(await closeAssociationsForMemories([fromId])).toBe(1);
      expect(await getMemoryAssociationRows([fromId])).toHaveLength(0);
      expect(await adminPool.query(
        `SELECT id FROM "${schemaName}".knowledge_edges WHERE from_id = $1 AND edge_type = 'supports'`,
        [fromKnowledgeId],
      )).toMatchObject({ rowCount: 3 });
      const [latest] = await adminPool.query(
        `SELECT id FROM "${schemaName}".knowledge_edges WHERE from_id = $1 AND edge_type = 'supports' AND recorded_to IS NULL`,
        [fromKnowledgeId],
      ).then((result) => result.rows as Array<{ id: string }>);
      expect(await retractKnowledgeEdge(latest!.id)).toMatchObject({ id: latest!.id, recordedTo: expect.any(Date) });
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  }, 20_000);

  postgresTest('allows historical association supersession outside the active edge interval', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    try {
      const db = await getDb();
      const suffix = randomUUID();
      const [a, b] = [`pg-temporal-association-a-${suffix}`, `pg-temporal-association-b-${suffix}`];
      const [aKnowledgeId, bKnowledgeId] = [`pg-temporal-association-ka-${suffix}`, `pg-temporal-association-kb-${suffix}`];
      const now = new Date();
      const existingValidTo = new Date(now.getTime() + 60_000);
      const laterValidFrom = new Date(now.getTime() + 120_000);
      await db.insert(knowledge).values([
        { id: aKnowledgeId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Older association source', metadata: { sourceMemoryId: a } },
        { id: bKnowledgeId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Newer association source', metadata: { sourceMemoryId: b } },
      ]);

      await createAssociation(a, b, 'supersedes', 1, undefined, {
        validFrom: new Date(now.getTime() - 1_000),
        validTo: existingValidTo,
        recordedAt: now,
      });
      await createAssociation(b, a, 'supersedes', 1, undefined, {
        validFrom: laterValidFrom,
        recordedAt: now,
      });

      const futureEdge = await adminPool.query(
        `SELECT id FROM "${schemaName}".knowledge_edges WHERE from_id = $1 AND to_id = $2
          AND edge_type = 'supersedes' AND valid_from = $3`,
        [bKnowledgeId, aKnowledgeId, laterValidFrom],
      );
      expect(futureEdge.rowCount).toBe(1);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  }, 20_000);

  postgresTest('reads PostgreSQL edge adjacency and closes incident edges with temporal history', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    try {
      const db = await getDb();
      const suffix = randomUUID();
      const centerId = `pg-adjacency-center-${suffix}`;
      const fromId = `pg-adjacency-from-${suffix}`;
      const toId = `pg-adjacency-to-${suffix}`;
      const outsideId = `pg-adjacency-outside-${suffix}`;
      const now = new Date();
      const before = new Date(now.getTime() - 5_000);
      await db.insert(knowledgeEdges).values([
        {
          id: `pg-adjacency-outgoing-${suffix}`, fromId: centerId, fromKind: 'knowledge',
          toId, toKind: 'knowledge', edgeType: 'supports', weight: 0.8,
          createdAt: before, validFrom: before, recordedAt: before,
        },
        {
          id: `pg-adjacency-incoming-${suffix}`, fromId, fromKind: 'knowledge',
          toId: centerId, toKind: 'knowledge', edgeType: 'supports', weight: 0.6,
          createdAt: before, validFrom: before, recordedAt: before,
        },
        {
          id: `pg-adjacency-other-${suffix}`, fromId: outsideId, fromKind: 'knowledge',
          toId, toKind: 'knowledge', edgeType: 'supports', weight: 0.4,
          createdAt: before, validFrom: before, recordedAt: before,
        },
        {
          id: `pg-adjacency-future-${suffix}`, fromId: centerId, fromKind: 'knowledge',
          toId: outsideId, toKind: 'knowledge', edgeType: 'supports', weight: 1,
          createdAt: before, validFrom: new Date(now.getTime() + 600_000), recordedAt: before,
        },
      ]);

      expect((await getEdgesFrom(centerId, 'knowledge', 'supports')).map((edge) => edge.id))
        .toEqual([`pg-adjacency-outgoing-${suffix}`]);
      expect((await getEdgesTo(centerId, 'knowledge')).map((edge) => edge.id))
        .toEqual([`pg-adjacency-incoming-${suffix}`]);
      expect((await getEdgesForNode(centerId, 'knowledge')).map((edge) => edge.id).sort())
        .toEqual([`pg-adjacency-incoming-${suffix}`, `pg-adjacency-outgoing-${suffix}`].sort());

      const closedAt = new Date(Date.now() + 60_000);
      expect(await closeEdgesForNode(centerId, 'knowledge', closedAt)).toBe(2);
      expect(await getEdgesForNode(centerId, 'knowledge')).toHaveLength(2);
      expect(await getEdgesForNode(centerId, 'knowledge', { validAt: closedAt, recordedAt: closedAt })).toHaveLength(0);
      expect(await getEdgesForNode(centerId, 'knowledge', { validAt: before, recordedAt: before })).toHaveLength(2);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  }, 20_000);

  postgresTest('rejects local-compatible edge creation across PostgreSQL project boundaries', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    try {
      const db = await getDb();
      const fromProjectId = randomUUID();
      const toProjectId = randomUUID();
      const fromId = randomUUID();
      const toId = randomUUID();
      await db.insert(projects).values([
        { id: fromProjectId, name: 'edge source project', path: `/pg-edge-source-${fromProjectId}` },
        { id: toProjectId, name: 'edge destination project', path: `/pg-edge-destination-${toProjectId}` },
      ]);
      await db.insert(entities).values([
        { id: fromId, projectId: fromProjectId, name: 'Scoped source', type: 'concept' },
        { id: toId, projectId: toProjectId, name: 'Scoped destination', type: 'concept' },
      ]);

      await expect(createKnowledgeEdge({
        fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'related_to',
      })).rejects.toThrow('Entity graph edges must stay within one project');
      expect(await adminPool.query(
        `SELECT id FROM "${schemaName}".knowledge_edges WHERE from_id = $1 AND to_id = $2`,
        [fromId, toId],
      )).toMatchObject({ rowCount: 0 });
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  }, 20_000);

  postgresTest('rejects PostgreSQL revisions across entity project boundaries but permits cleanup closure', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    try {
      const db = await getDb();
      const fromProjectId = randomUUID();
      const toProjectId = randomUUID();
      const fromId = randomUUID();
      const toId = randomUUID();
      const edgeId = randomUUID();
      const edgeTime = new Date(Date.now() - 10_000);
      await db.insert(projects).values([
        { id: fromProjectId, name: 'revision source project', path: `/pg-revision-source-${fromProjectId}` },
        { id: toProjectId, name: 'revision destination project', path: `/pg-revision-destination-${toProjectId}` },
      ]);
      await db.insert(entities).values([
        { id: fromId, projectId: fromProjectId, name: 'Revision source', type: 'concept' },
        { id: toId, projectId: toProjectId, name: 'Revision destination', type: 'concept' },
      ]);
      await db.insert(knowledgeEdges).values({
        id: edgeId,
        fromId,
        fromKind: 'entity',
        toId,
        toKind: 'entity',
        edgeType: 'related_to',
        weight: 1,
        metadata: {},
        createdAt: edgeTime,
        validFrom: edgeTime,
        recordedAt: edgeTime,
      });

      await expect(reviseKnowledgeEdge(edgeId, { weight: 2 }))
        .rejects.toThrow('Entity graph edges must stay within one project');
      expect(await adminPool.query(
        `SELECT recorded_to, weight FROM "${schemaName}".knowledge_edges WHERE id = $1`, [edgeId],
      )).toMatchObject({ rows: [{ recorded_to: null, weight: 1 }] });

      await expect(reviseKnowledgeEdge(edgeId, { validTo: new Date(Date.now() - 1_000) })).resolves.toBeDefined();
      expect(await adminPool.query(
        `SELECT valid_to, recorded_to, weight FROM "${schemaName}".knowledge_edges WHERE from_id = $1 AND to_id = $2 ORDER BY recorded_at`,
        [fromId, toId],
      )).toMatchObject({
        rowCount: 2,
        rows: [
          { valid_to: null, recorded_to: expect.any(Date), weight: 1 },
          { valid_to: expect.any(Date), recorded_to: null, weight: 1 },
        ],
      });
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  }, 20_000);

  postgresTest('enforces temporal supersession cycles on PostgreSQL creation and revision', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    try {
      const db = await getDb();
      const projectId = randomUUID();
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      const validFrom = new Date('2031-01-01T00:00:00.000Z');
      const validEnd = new Date('2031-01-10T00:00:00.000Z');
      await db.insert(projects).values({ id: projectId, name: 'temporal cycle test', path: `/pg-temporal-cycle-${projectId}` });
      await db.insert(entities).values([
        { id: a, projectId, name: 'Cycle A', type: 'document_version' },
        { id: b, projectId, name: 'Cycle B', type: 'document_version' },
        { id: c, projectId, name: 'Cycle C', type: 'document_version' },
      ]);

      await createKnowledgeEdge({ fromId: a, fromKind: 'entity', toId: b, toKind: 'entity', edgeType: 'supersedes_version', validFrom, validTo: validEnd });
      await createKnowledgeEdge({ fromId: b, fromKind: 'entity', toId: c, toKind: 'entity', edgeType: 'supersedes_version', validFrom: new Date('2031-01-05T00:00:00.000Z'), validTo: new Date('2031-01-08T00:00:00.000Z') });
      const closingEdge = await createKnowledgeEdge({
        fromId: c, fromKind: 'entity', toId: a, toKind: 'entity', edgeType: 'supersedes_version',
        validFrom: new Date('2031-01-01T00:00:00.000Z'), validTo: new Date('2031-01-05T00:00:00.000Z'),
      });
      await expect(reviseKnowledgeEdge(closingEdge.id, { validTo: new Date('2031-01-08T00:00:00.000Z') }))
        .rejects.toThrow('Knowledge edge supersession would create a cycle');

      await expect(createKnowledgeEdge({
        fromId: c, fromKind: 'entity', toId: a, toKind: 'entity', edgeType: 'supersedes_version',
        validFrom, validTo: validEnd,
      })).rejects.toThrow('Knowledge edge supersession would create a cycle');
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  }, 20_000);

  postgresTest('expands local-compatible knowledge through shared entities and places on PostgreSQL', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    try {
      const db = await getDb();
      const suffix = randomUUID();
      const startId = `pg-connected-start-${suffix}`;
      const entityNeighborId = `pg-connected-entity-neighbor-${suffix}`;
      const placeNeighborId = `pg-connected-place-neighbor-${suffix}`;
      const columnNeighborId = `pg-connected-column-neighbor-${suffix}`;
      const foreignProjectId = `pg-connected-foreign-project-${suffix}`;
      const foreignNeighborId = `pg-connected-foreign-neighbor-${suffix}`;
      const sharedEntityId = `pg-connected-entity-${suffix}`;
      const sharedPlaceId = `pg-connected-place-${suffix}`;
      const before = new Date(Date.now() - 5_000);
      await db.insert(projects).values({
        id: foreignProjectId, name: 'Unrelated graph project', path: `/pg-connected-foreign-${suffix}`,
      });
      await db.insert(knowledge).values([
        { id: startId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'starting memory' },
        { id: entityNeighborId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'entity neighbor' },
        { id: placeNeighborId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'place neighbor' },
        {
          id: columnNeighborId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'place column neighbor',
          primaryPlace: sharedPlaceId,
        },
        {
          id: foreignNeighborId, projectId: foreignProjectId,
          knowledgeKind: 'memory', knowledgeType: 'fact', content: 'unrelated project neighbor',
        },
      ]);
      await db.insert(knowledgeEdges).values([
        {
          id: `pg-connected-entity-out-${suffix}`, fromId: startId, fromKind: 'knowledge',
          toId: sharedEntityId, toKind: 'entity', edgeType: 'references', weight: 1,
          createdAt: before, validFrom: before, recordedAt: before,
        },
        {
          id: `pg-connected-entity-in-${suffix}`, fromId: sharedEntityId, fromKind: 'entity',
          toId: entityNeighborId, toKind: 'knowledge', edgeType: 'references', weight: 1,
          createdAt: before, validFrom: before, recordedAt: before,
        },
        {
          id: `pg-connected-place-start-${suffix}`, fromId: startId, fromKind: 'knowledge',
          toId: sharedPlaceId, toKind: 'place', edgeType: 'placed_in', weight: 1,
          createdAt: before, validFrom: before, recordedAt: before,
        },
        {
          id: `pg-connected-place-neighbor-${suffix}`, fromId: placeNeighborId, fromKind: 'knowledge',
          toId: sharedPlaceId, toKind: 'place', edgeType: 'placed_in', weight: 1,
          createdAt: before, validFrom: before, recordedAt: before,
        },
        {
          id: `pg-connected-entity-cross-project-${suffix}`, fromId: sharedEntityId, fromKind: 'entity',
          toId: foreignNeighborId, toKind: 'knowledge', edgeType: 'references', weight: 1,
          createdAt: before, validFrom: before, recordedAt: before,
        },
        {
          id: `pg-connected-place-cross-project-${suffix}`, fromId: foreignNeighborId, fromKind: 'knowledge',
          toId: sharedPlaceId, toKind: 'place', edgeType: 'placed_in', weight: 1,
          createdAt: before, validFrom: before, recordedAt: before,
        },
      ]);

      const connectedEntities = await getConnectedEntities(startId);
      const connectedPlaces = await getConnectedPlaces(startId);
      expect(connectedEntities.map((row) => row.id)).toEqual([entityNeighborId]);
      expect(connectedPlaces.map((row) => row.id).sort())
        .toEqual([placeNeighborId, columnNeighborId].sort());
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  }, 20_000);

  postgresTest('authorizes signed strict graph views on PostgreSQL from source lineage', async () => {
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
    };
    const keyPair = generateKeyPairSync('ed25519');
    const keyId = `pg-graph-view-${randomUUID()}`;
    const caller = `pg-graph-view-caller-${randomUUID()}`;
    const userId = randomUUID();
    const projectId = randomUUID();
    const memoryId = randomUUID();
    const fromId = randomUUID();
    const toId = randomUUID();
    const content = 'SignedGraphRoot references SignedGraphTarget.';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({
      [keyId]: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    try {
      const db = await getDb();
      await db.insert(users).values({ id: userId, externalId: caller });
      await db.insert(projects).values({ id: projectId, name: 'PostgreSQL strict graph view', path: `/pg-strict-graph-view-${projectId}` });
      await db.insert(entities).values([
        { id: fromId, projectId, name: 'SignedGraphRoot', type: 'concept' },
        { id: toId, projectId, name: 'SignedGraphTarget', type: 'concept' },
      ]);
      const sourceMetadata = { sourceMemoryId: memoryId };
      const sourceSignature = signMemoryProvenance({
        content, projectId, type: 'fact', ownerId: userId, teamId: null, sourceMemoryId: memoryId, metadata: sourceMetadata,
      });
      await db.insert(memories).values({
        id: memoryId, userId, projectId, type: 'fact', content,
        metadata: { ...sourceMetadata, __squishProvenance: sourceSignature },
      });
      const edgeMetadata = { sourceMemoryIds: [memoryId], context: content };
      const graphSignature = signGraphRelationProvenance({
        fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'references', weight: 1, metadata: edgeMetadata,
      });
      await db.insert(knowledgeEdges).values({
        id: randomUUID(), fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'references', weight: 1,
        metadata: { ...edgeMetadata, __squishGraphProvenance: graphSignature },
        validFrom: new Date(Date.now() - 1_000), recordedAt: new Date(Date.now() - 1_000),
      });

      const view = { viewType: 'entity' as const, edgeTypes: ['references'], orderBy: 'weight' as const, maxDepth: 1, minWeight: 0 };
      const result = await queryGraphView(fromId, 'entity', view);
      expect(result.nodes.map((node) => node.id)).toEqual([toId]);
      expect(result.edges[0]?.metadata?.sourceMemoryIds).toEqual([memoryId]);
      process.env.SQUISH_TRUSTED_CALLER_ID = `pg-graph-view-unrelated-${randomUUID()}`;
      const denied = await queryGraphView(fromId, 'entity', view);
      expect(denied.nodes).toEqual([]);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
      if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
      if (previous.publicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = previous.publicKeys;
      if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
    }
  }, 20_000);
});
