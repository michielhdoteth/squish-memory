import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-session-recovery-project-race-'));
const callerId = 'session-recovery-project-race-owner';
const otherCallerId = 'session-recovery-project-race-new-owner';
const sourceProjectPath = join(dataDir, 'source-project');
const destinationProjectPath = join(dataDir, 'destination-project');
const sessionId = 'session-recovery-project-race';
const privateMarker = 'SESSION_RECOVERY_PROJECT_RACE_PRIVATE_CONTENT';
const environmentKeys = [
  'SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID',
  'SQUISH_PROVENANCE_PRIVATE_KEY', 'SQUISH_PROVENANCE_PUBLIC_KEY', 'SQUISH_PROVENANCE_KEY_ID',
  'SQUISH_EMBEDDINGS_PROVIDER', 'SQUISH_LOCAL_BUNDLED_MODEL', 'SQUISH_ENCRYPTION_ENABLED',
] as const;
const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));

process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_TRUST_POLICY = 'strict';
process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
process.env.SQUISH_ENCRYPTION_ENABLED = 'false';

const { closeAllDbs, getDb, resetDb } = await import('../../../db/index.js');
const { captureChunk } = await import('../../../core/sessions/store.js');
const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
const { recoverCapturedSession } = await import('../../../core/sessions/store.js');

describe('session recovery project revalidation', () => {
  let memoryId: string;
  let sourceProjectId: string;
  let destinationProjectId: string;
  let otherOwnerId: string;

  beforeAll(async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_KEY_ID = 'session-project-race-test';
    resetDb();
    const db = await getDb();
    const sqlite = (db as unknown as { $client: { prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): { id: string } } } }).$client;
    sqlite.prepare('INSERT INTO users (id, external_id) VALUES (?, ?)').run(randomUUID(), callerId);
    sqlite.prepare('INSERT INTO users (id, external_id) VALUES (?, ?)').run(randomUUID(), otherCallerId);
    otherOwnerId = sqlite.prepare('SELECT id FROM users WHERE external_id = ?').get(otherCallerId).id;

    const { getOrCreateProject } = await import('../../../core/projects.js');
    const sourceProject = await getOrCreateProject(sourceProjectPath);
    const destinationProject = await getOrCreateProject(destinationProjectPath);
    if (!sourceProject || !destinationProject) throw new Error('Could not create project-race fixtures');
    sourceProjectId = sourceProject.id;
    destinationProjectId = destinationProject.id;

    memoryId = await captureChunk({
      type: 'decision',
      content: `Private project-scoped session content ${privateMarker}`,
      session_id: sessionId,
      session_title: 'Project race regression',
      project: sourceProjectPath,
      repo_path: sourceProjectPath,
      branch: 'main',
      agent: 'cli',
      agent_session_id: 'project-race-agent-session',
      timestamp: new Date().toISOString(),
    }, { project: sourceProjectPath, user: callerId });
  });

  afterAll(async () => {
    await closeAllDbs();
    resetDb();
    for (const key of environmentKeys) {
      const value = previousEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* SQLite may release the fixture handle asynchronously on Windows. */ }
  });

  it('drops session evidence moved out of the requested project during the caller-gated read', async () => {
    const runtime = new SquishRuntime({ dataDir });
    let gatedReadCount = 0;
    const recovered = await recoverCapturedSession({
      sessionId,
      project: sourceProjectPath,
      user: callerId,
      readTaggedMemories: async (ids) => {
        gatedReadCount += 1;
        const visible = await runtime.getMemoriesByIds(ids, { userId: callerId });
        const sqlite = (await getDb()).$client;
        sqlite.prepare('UPDATE memories SET project_id = ? WHERE id = ?').run(destinationProjectId, memoryId);
        return visible.map((memory) => ({
          id: memory.id,
          type: memory.type,
          content: memory.content,
          tags: [`squish_session:${sessionId}`],
        }));
      },
    });

    expect(gatedReadCount).toBeGreaterThan(0);
    expect(recovered.evidence).toEqual([]);
    expect(JSON.stringify(recovered)).not.toContain(privateMarker);
    expect(sourceProjectId).not.toBe(destinationProjectId);
  });

  it('rechecks strict caller visibility after ownership changes during the caller-gated read', async () => {
    const secondSessionId = `${sessionId}-owner-change`;
    const secondMemoryId = await captureChunk({
      type: 'decision',
      content: `Private session content after ownership change ${privateMarker}`,
      session_id: secondSessionId,
      session_title: 'Owner change race regression',
      project: sourceProjectPath,
      repo_path: sourceProjectPath,
      branch: 'main',
      agent: 'cli',
      agent_session_id: 'owner-change-agent-session',
      timestamp: new Date().toISOString(),
    }, { project: sourceProjectPath, user: callerId });
    const runtime = new SquishRuntime({ dataDir });
    const recovered = await recoverCapturedSession({
      sessionId: secondSessionId,
      project: sourceProjectPath,
      user: callerId,
      readTaggedMemories: async (ids) => {
        const visible = await runtime.getMemoriesByIds(ids, { userId: callerId });
        (await getDb()).$client.prepare('UPDATE memories SET user_id = ? WHERE id = ?').run(otherOwnerId!, secondMemoryId);
        return visible.map((memory) => ({
          id: memory.id,
          type: memory.type,
          content: memory.content,
          tags: [`squish_session:${secondSessionId}`],
        }));
      },
    });

    expect(recovered.evidence).toEqual([]);
    expect(JSON.stringify(recovered)).not.toContain(privateMarker);
  });
});
