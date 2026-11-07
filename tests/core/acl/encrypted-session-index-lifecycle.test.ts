import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-encrypted-session-index-lifecycle-'));
const passphrase = 'synthetic-encrypted-session-index-lifecycle-passphrase';
const reopenSessionId = 'synthetic-session-reopen';
const reopenMemoryId = 'synthetic-memory-reopen';
const forgetSessionId = 'synthetic-session-forget';
const forgetMemoryId = 'synthetic-memory-forget';
const directDeleteSessionId = 'synthetic-session-direct-delete';
const directDeleteMemoryId = 'synthetic-memory-direct-delete';
const unrelatedSessionId = 'synthetic-session-unrelated';
const unrelatedMemoryId = 'synthetic-memory-unrelated';
const projectMoveSessionId = 'synthetic-session-project-move';
const projectMoveMemoryId = 'synthetic-memory-project-move';
const originalProjectPath = join(dataDir, 'original-project');
const movedProjectPath = join(dataDir, 'moved-project');
const envKeys = [
  'SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_TRUST_POLICY',
  'SQUISH_ENCRYPTION_ENABLED', 'SQUISH_ENCRYPTION_PASSPHRASE',
] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_TRUST_POLICY = 'local-compatible';
process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
process.env.SQUISH_ENCRYPTION_PASSPHRASE = passphrase;

const { getDb, resetDb, closeAllDbs } = await import('../../../db/index.js');
const { createPrivateIndexContext } = await import('../../../core/security/encrypt.js');
const { forgetCapturedSession, recoverCapturedSession } = await import('../../../core/sessions/store.js');

interface TestSqlite {
  prepare: (query: string) => {
    run: (...params: unknown[]) => unknown;
    get: (...params: unknown[]) => Record<string, unknown>;
  };
}

function insertEncryptedSessionSource(
  sqlite: TestSqlite,
  sessionId: string,
  memoryId: string,
): void {
  sqlite.prepare(`INSERT INTO memories
    (id, type, content, source, tags, metadata, status, is_active, is_encrypted,
     encrypted_content, encryption_nonce, created_at)
    VALUES (?, 'observation', '', ?, ?, ?, 'active', 1, 1, 'synthetic-ciphertext', 'synthetic-nonce', ?)`)
    .run(memoryId, `session_chunk:${sessionId}`, JSON.stringify([`squish_session:${sessionId}`]),
      JSON.stringify({ session_id: sessionId }), Math.floor(Date.now() / 1000));

  const index = createPrivateIndexContext(passphrase);
  try {
    sqlite.prepare(`INSERT INTO memory_private_session_index
      (session_token, memory_id, project_id, user_id, team_id, record_mac)
      VALUES (?, ?, NULL, NULL, NULL, ?)`)
      .run(index.token('session-id', sessionId), memoryId,
        index.token('session-row', JSON.stringify([sessionId, memoryId, null, null, null])));
  } finally {
    index.clear();
  }
}

describe('encrypted private session index lifecycle', () => {
  beforeAll(async () => {
    resetDb();
    const sqlite = (await getDb() as { $client: TestSqlite }).$client;
    insertEncryptedSessionSource(sqlite, reopenSessionId, reopenMemoryId);
    insertEncryptedSessionSource(sqlite, forgetSessionId, forgetMemoryId);
    insertEncryptedSessionSource(sqlite, directDeleteSessionId, directDeleteMemoryId);
    insertEncryptedSessionSource(sqlite, unrelatedSessionId, unrelatedMemoryId);
    const { getOrCreateProject } = await import('../../../core/projects.js');
    const originalProject = await getOrCreateProject(originalProjectPath);
    const movedProject = await getOrCreateProject(movedProjectPath);
    if (!originalProject || !movedProject) throw new Error('Project-move fixture setup failed');
    sqlite.prepare(`INSERT INTO memories
      (id, type, content, source, tags, metadata, status, is_active, is_encrypted,
       encrypted_content, encryption_nonce, project_id, created_at)
      VALUES (?, 'observation', '', ?, ?, ?, 'active', 1, 1, 'synthetic-ciphertext', 'synthetic-nonce', ?, ?)`)
      .run(projectMoveMemoryId, `session_chunk:${projectMoveSessionId}`, '[]', '{}', originalProject.id, Math.floor(Date.now() / 1000));
    const index = createPrivateIndexContext(passphrase);
    try {
      sqlite.prepare(`INSERT INTO memory_private_session_index
        (session_token, memory_id, project_id, user_id, team_id, record_mac)
        VALUES (?, ?, ?, NULL, NULL, ?)`)
        .run(index.token('session-id', projectMoveSessionId), projectMoveMemoryId, originalProject.id,
          index.token('session-row', JSON.stringify([projectMoveSessionId, projectMoveMemoryId, originalProject.id, null, null])));
    } finally {
      index.clear();
    }
    await closeAllDbs();
    resetDb();
  });

  afterAll(async () => {
    await closeAllDbs();
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* SQLite may release its handle asynchronously on Windows. */ }
  });

  it('recovers indexed encrypted session IDs after closing and reopening SQLite', async () => {
    let readIds: string[] = [];
    const result = await recoverCapturedSession({
      sessionId: reopenSessionId,
      readTaggedMemories: async (ids) => {
        readIds = ids;
        return ids.map((id) => ({
          id, type: 'observation', content: 'recovered synthetic source', tags: [`squish_session:${reopenSessionId}`],
        }));
      },
    });

    expect(readIds).toEqual([reopenMemoryId]);
    expect(result.evidence.map((item) => item.id)).toEqual([reopenMemoryId]);
  });

  it('removes the private index row through explicit captured-session forgetting', async () => {
    const deleted = await forgetCapturedSession({
      sessionId: forgetSessionId,
      readTaggedMemories: async (ids) => [...ids.map((id) => ({ id })), { id: unrelatedMemoryId }],
    });
    const sqlite = (await getDb() as { $client: TestSqlite }).$client;

    expect(deleted).toEqual({ deleted: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(forgetMemoryId).count).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_private_session_index WHERE memory_id = ?')
      .get(forgetMemoryId).count).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(unrelatedMemoryId).count).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_private_session_index WHERE memory_id = ?')
      .get(unrelatedMemoryId).count).toBe(1);
  });

  it('cascades private index cleanup when a source row is permanently deleted', async () => {
    const sqlite = (await getDb() as { $client: TestSqlite }).$client;
    sqlite.prepare('DELETE FROM memories WHERE id = ?').run(directDeleteMemoryId);

    const count = (query: string) => sqlite.prepare(query).get(directDeleteMemoryId).count;
    expect(count('SELECT COUNT(*) AS count FROM memories WHERE id = ?')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM memory_private_session_index WHERE memory_id = ?')).toBe(0);
  });

  it('does not delete a project-scoped encrypted session source moved during the gated read', async () => {
    const { getOrCreateProject } = await import('../../../core/projects.js');
    const movedProject = await getOrCreateProject(movedProjectPath);
    if (!movedProject) throw new Error('Project-move target fixture is missing');
    const deleted = await forgetCapturedSession({
      sessionId: projectMoveSessionId,
      project: originalProjectPath,
      readTaggedMemories: async (ids) => {
        (await getDb()).$client.prepare('UPDATE memories SET project_id = ? WHERE id = ?')
          .run(movedProject.id, projectMoveMemoryId);
        return ids.map((id) => ({ id }));
      },
    });
    const sqlite = (await getDb() as { $client: TestSqlite }).$client;

    expect(deleted).toEqual({ deleted: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(projectMoveMemoryId).count).toBe(1);
  });
});
