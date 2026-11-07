import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { signMemoryProvenance } from '../../core/acl/provenance.js';
import { closeAllDbs, getDb, resetDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { createKnowledgeEdge } from '../../core/knowledge/knowledge-edges.js';

const root = process.env.SQUISH_TEST_ATTEST_ROOT;
if (!root) throw new Error('SQUISH_TEST_ATTEST_ROOT is required');
const sourceDir = join(root, 'source');
const copyDir = join(root, 'copy');
const repoRoot = join(import.meta.dir, '..', '..');
const script = join(repoRoot, 'scripts', 'attest-legacy-graph-edges.ts');

function run(dataDir: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['run', script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SQUISH_DATA_DIR: dataDir,
      DATABASE_URL: '',
      SQUISH_DATABASE_URL: '',
      SQUISH_LOCAL_BUNDLED_MODEL: 'off',
      SQUISH_LLM_ENABLED: 'false',
      ...extraEnv,
    },
  });
}

async function rehearse(): Promise<void> {
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(copyDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = sourceDir;
  process.env.DATABASE_URL = '';
  process.env.SQUISH_DATABASE_URL = '';
  process.env.SQUISH_TRUST_POLICY = 'local-compatible';
  resetDb();
  try {
    const db = await getDb();
    const schema = await getSchema();
    const raw = (db as { $client?: { prepare: (sql: string) => { get: (...args: string[]) => Record<string, unknown> | undefined } } }).$client;
    assert.ok(raw, 'Rehearsal fixture requires the SQLite client');

    const keys = generateKeyPairSync('ed25519');
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyId = `copied-db-${randomUUID()}`;
    const caller = `rehearsal-owner-${randomUUID()}`;
    const userId = randomUUID();
    const sourceId = randomUUID();
    const projectId = randomUUID();
    const fromId = randomUUID();
    const toId = randomUUID();
    const content = 'Northstar replaces Polaris.';
    const keyEnv = {
      SQUISH_PROVENANCE_PRIVATE_KEY: privateKey,
      SQUISH_PROVENANCE_KEY_ID: keyId,
      SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ [keyId]: publicKey }),
    };
    await db.insert(schema.projects).values({ id: projectId, name: 'rehearsal', path: root });
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
      id: sourceId, projectId, userId, type: 'fact', content, source: 'copied database rehearsal',
      status: 'active', isActive: true,
      metadata: JSON.stringify({ ...sourceMetadata, __squishProvenance: sourceSignature }),
    });
    await createKnowledgeEdge({
      fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'supersedes_version',
      metadata: { legacyMigration: { sourceTable: 'entity_relations', trust: 'unverified_legacy' },
        legacyPayload: { properties: { context: content } } },
    });
    const edgeId = String(raw.prepare('SELECT id FROM knowledge_edges WHERE from_id = ? AND to_id = ?').get(fromId, toId)?.id ?? '');
    assert.ok(edgeId);

    await closeAllDbs();
    const sourceSnapshot = new Database(join(sourceDir, 'squish.db'), { readonly: true });
    writeFileSync(join(copyDir, 'squish.db'), sourceSnapshot.serialize());
    sourceSnapshot.close();
    const copiedBefore = new Database(join(copyDir, 'squish.db'), { readonly: true });
    assert.equal((copiedBefore.query('SELECT COUNT(*) AS count FROM knowledge_edges WHERE id = ?').get(edgeId) as { count: number }).count, 1);
    copiedBefore.close();

    const sourceBefore = new Database(join(sourceDir, 'squish.db'), { readonly: true });
    const sourceMetadataBefore = (sourceBefore.query('SELECT metadata FROM knowledge_edges WHERE id = ?').get(edgeId) as { metadata: string }).metadata;
    sourceBefore.close();
    const sourceFileHashBefore = createHash('sha256').update(readFileSync(join(sourceDir, 'squish.db'))).digest('hex');
    const supportMap = join(root, 'support-map.json');
    writeFileSync(supportMap, JSON.stringify([{ edgeId, sourceMemoryIds: [sourceId] }]), 'utf8');

    const dryRun = run(copyDir, [], { SQUISH_TRUSTED_CALLER_ID: caller });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /"dryRun": true/);
    assert.match(dryRun.stdout, /Northstar/);
    assert.ok(dryRun.stdout.includes(content));

    const applied = run(copyDir, [
      `--support-map=${supportMap}`, '--apply', '--confirm-local-graph-edge-attestation',
    ], {
      SQUISH_TRUST_POLICY: 'strict',
      SQUISH_TRUSTED_CALLER_ID: caller,
      ...keyEnv,
    });
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /"attested": 1/);

    const sourceAfter = new Database(join(sourceDir, 'squish.db'), { readonly: true });
    const sourceMetadataAfter = (sourceAfter.query('SELECT metadata FROM knowledge_edges WHERE id = ?').get(edgeId) as { metadata: string }).metadata;
    sourceAfter.close();
    assert.equal(sourceMetadataAfter, sourceMetadataBefore);
    assert.equal(createHash('sha256').update(readFileSync(join(sourceDir, 'squish.db'))).digest('hex'), sourceFileHashBefore);

    const copied = new Database(join(copyDir, 'squish.db'), { readonly: true });
    const copiedEdge = (copied.query('SELECT metadata FROM knowledge_edges WHERE id = ?').get(edgeId) as { metadata: string }).metadata;
    const auditCount = (copied.query(`SELECT COUNT(*) AS count FROM trust_audit_log
      WHERE asset_type = 'knowledge_edge' AND reason = 'owner_attestation' AND decision = 'allow'`).get() as { count: number }).count;
    copied.close();
    assert.match(copiedEdge, /__squishGraphProvenance/);
    assert.equal(auditCount, 1);
  } finally {
    await closeAllDbs();
    resetDb();
  }
}

await rehearse();
console.log('copied database attestation rehearsal passed');
