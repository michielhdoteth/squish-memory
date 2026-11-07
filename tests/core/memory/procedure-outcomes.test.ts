import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = join(tmpdir(), `squish-procedure-outcomes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const envKeys = [
  'SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_SKIP_CONTRADICTION', 'SQUISH_EMBEDDINGS_PROVIDER',
  'SQUISH_LOCAL_BUNDLED_MODEL', 'SQUISH_GRAPH_AUTO_BUILD', 'SQUISH_TRUST_POLICY',
  'SQUISH_PROVENANCE_PRIVATE_KEY', 'SQUISH_PROVENANCE_PUBLIC_KEY', 'SQUISH_PROVENANCE_KEY_ID',
] as const;
const savedEnv = new Map<string, string | undefined>();

describe('attributed procedure outcome conflicts', () => {
  let rememberMemory: typeof import('../../../core/memory/memory-write.js').rememberMemory;
  let getDb: typeof import('../../../db/index.js').getDb;
  let closeAllDbs: typeof import('../../../db/index.js').closeAllDbs;
  let createTeam: typeof import('../../../db/team-adapter.js').createTeam;

  beforeAll(async () => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    mkdirSync(dataDir, { recursive: true });
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_SKIP_CONTRADICTION = 'false';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
    process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
    process.env.SQUISH_GRAPH_AUTO_BUILD = 'false';
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_KEY_ID = 'procedure-outcome-test';
    ({ rememberMemory } = await import('../../../core/memory/memory-write.js'));
    ({ getDb, closeAllDbs } = await import('../../../db/index.js'));
    ({ createTeam } = await import('../../../db/team-adapter.js'));
    await getDb();
  });

  afterAll(async () => {
    await closeAllDbs();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* SQLite may release its Windows handle shortly after close. */ }
  });

  it('links opposite outcomes for the same procedure without superseding either memory', async () => {
    const procedureKey = 'deploy:database-migration';
    const successful = await rememberMemory({
      content: 'The dry-run migration procedure succeeded.',
      type: 'context',
      metadata: { sourceId: 'source-success', procedureOutcome: { procedureKey, result: 'success', evidenceId: 'receipt-success' } },
    });
    const failed = await rememberMemory({
      content: 'The dry-run migration procedure failed.',
      type: 'context',
      metadata: { sourceId: 'source-failure', procedureOutcome: { procedureKey, result: 'failure', evidenceId: 'incident-failure' } },
    });

    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { all: (...params: string[]) => Array<{ metadata: string }> } } }).$client;
    const edges = sqlite.prepare(`
      SELECT e.metadata
      FROM knowledge_edges e
      JOIN knowledge f ON f.id = e.from_id
      JOIN knowledge t ON t.id = e.to_id
      WHERE e.edge_type = 'contradicts'
        AND json_extract(f.metadata, '$.sourceMemoryId') = ?
        AND json_extract(t.metadata, '$.sourceMemoryId') = ?
    `).all(failed.id, successful.id);
    expect(edges).toHaveLength(1);
    expect(JSON.parse(edges[0]!.metadata)).toMatchObject({
      reviewRequired: true,
      procedureKey,
      outcomes: [
        { result: 'failure', sourceId: 'source-failure', evidenceId: 'incident-failure' },
        { result: 'success', sourceId: 'source-success', evidenceId: 'receipt-success' },
      ],
    });

    const statuses = sqlite.prepare('SELECT status FROM memories WHERE id IN (?, ?)').all(failed.id, successful.id);
    expect(statuses).toHaveLength(2);
    expect(statuses.every((row) => row.status === 'active')).toBe(true);
  });

  it('does not create a conflict edge for an outcome without source provenance', async () => {
    const procedureKey = 'release:rollback';
    const { rememberMemory: write } = await import('../../../core/memory/memory-write.js');
    const first = await write({
      content: 'Rollback procedure succeeded.', type: 'context',
      metadata: { sourceId: 'source-rollback-success', procedureOutcome: { procedureKey, result: 'success', evidenceId: 'receipt-rollback-success' } },
    });
    const second = await write({
      content: 'Rollback procedure failed.', type: 'context',
      metadata: { procedureOutcome: { procedureKey, result: 'failure', evidenceId: 'incident-rollback-failure' } },
    });
    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { all: (...params: string[]) => unknown[] } } }).$client;
    const rows = sqlite.prepare(`
      SELECT e.id FROM knowledge_edges e
      JOIN knowledge f ON f.id = e.from_id
      JOIN knowledge t ON t.id = e.to_id
      WHERE e.edge_type = 'contradicts'
        AND json_extract(f.metadata, '$.sourceMemoryId') = ?
        AND json_extract(t.metadata, '$.sourceMemoryId') = ?
    `).all(second.id, first.id);
    expect(rows).toHaveLength(0);
  });

  it('does not link procedure outcomes across team scopes for the same owner', async () => {
    const teamA = await createTeam({ name: 'Procedure Team A', ownerId: 'procedure-owner' });
    const teamB = await createTeam({ name: 'Procedure Team B', ownerId: 'procedure-owner' });
    const procedureKey = 'deploy:isolated-migration';
    const teamASuccess = await rememberMemory({
      user: 'procedure-owner', teamId: teamA.id, content: 'Team A migration succeeded.', type: 'context',
      metadata: { sourceId: 'team-a-run', procedureOutcome: { procedureKey, result: 'success', evidenceId: 'team-a-receipt' } },
    });
    const teamBFailure = await rememberMemory({
      user: 'procedure-owner', teamId: teamB.id, content: 'Team B migration failed.', type: 'context',
      metadata: { sourceId: 'team-b-run', procedureOutcome: { procedureKey, result: 'failure', evidenceId: 'team-b-incident' } },
    });
    const teamBSuccess = await rememberMemory({
      user: 'procedure-owner', teamId: teamB.id, content: 'Team B migration later succeeded.', type: 'context',
      metadata: { sourceId: 'team-b-retry', procedureOutcome: { procedureKey, result: 'success', evidenceId: 'team-b-receipt' } },
    });

    const db = await getDb();
    const sqlite = (db as { $client: { prepare: (sql: string) => { all: (...params: string[]) => Array<{ from_memory_id: string; to_memory_id: string }> } } }).$client;
    const edges = sqlite.prepare(`
      SELECT json_extract(f.metadata, '$.sourceMemoryId') AS from_memory_id,
        json_extract(t.metadata, '$.sourceMemoryId') AS to_memory_id
      FROM knowledge_edges e
      JOIN knowledge f ON f.id = e.from_id
      JOIN knowledge t ON t.id = e.to_id
      WHERE e.edge_type = 'contradicts'
        AND json_extract(f.metadata, '$.sourceMemoryId') IN (?, ?, ?)
        AND json_extract(t.metadata, '$.sourceMemoryId') IN (?, ?, ?)
    `).all(teamASuccess.id, teamBFailure.id, teamBSuccess.id, teamASuccess.id, teamBFailure.id, teamBSuccess.id);
    expect(edges).toHaveLength(1);
    expect(edges.map((edge) => [edge.from_memory_id, edge.to_memory_id])).toEqual([[teamBSuccess.id, teamBFailure.id]]);
  });

  it('denies direct unscoped procedure outcome linking under strict trust and records a minimized audit', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'procedure-outcome-caller';
    try {
      const { linkConflictingProcedureOutcomes } = await import('../../../core/memory/procedure-outcomes.js');
      await expect(linkConflictingProcedureOutcomes({
        knowledgeId: 'caller-selected-knowledge-id', projectId: null, userId: null, teamId: null,
        outcome: { procedureKey: 'deploy:test', result: 'failure', sourceId: 'source', evidenceId: 'evidence' },
      })).rejects.toThrow('strict trust');
      const db = await getDb();
      const sqlite = (db as { $client: { prepare: (sql: string) => { get: (...params: string[]) => Record<string, unknown> | undefined } } }).$client;
      const resourceHash = createHash('sha256').update('caller-selected-knowledge-id').digest('hex');
      const row = sqlite.prepare(`SELECT resource_hash, asset_type, decision, reason FROM trust_audit_log WHERE resource_hash=? AND decision='deny' AND reason='strict_surface' LIMIT 1`).get(resourceHash);
      expect(row).toMatchObject({ asset_type: 'memory_lifecycle', decision: 'deny', reason: 'strict_surface' });
      expect(row?.resource_hash).toBe(resourceHash);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('denies unscoped entity extractor reads and writes under strict trust', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'entity-extractor-caller';
    try {
      const { getMemoryEntities, getProjectEntities, linkEntitiesToMemories } = await import('../../../core/memory/entity-extractor.js');
      await expect(getProjectEntities('unscoped-project')).rejects.toThrow('strict trust');
      await expect(getMemoryEntities('unscoped-memory')).rejects.toThrow('strict trust');
      await expect(linkEntitiesToMemories('unscoped-write-memory', [{
        name: 'private entity', type: 'concept', confidence: 1, startIndex: 0, endIndex: 14, context: 'private entity',
      }])).rejects.toThrow('strict trust');

      const db = await getDb();
      const sqlite = (db as { $client: { prepare: (sql: string) => { all: (...params: string[]) => Array<{ resource_hash: string; asset_type: string; decision: string; reason: string }> } } }).$client;
      const hashes = ['unscoped-project', 'unscoped-memory', 'unscoped-write-memory']
        .map((resource) => createHash('sha256').update(resource).digest('hex'));
      const audits = sqlite.prepare(`SELECT resource_hash, asset_type, decision, reason FROM trust_audit_log WHERE resource_hash IN (?, ?, ?) AND decision='deny'`).all(...hashes);
      expect(audits).toHaveLength(3);
      expect(audits.every((row) => row.asset_type === 'graph_operation' && row.reason === 'strict_surface')).toBe(true);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });
});
