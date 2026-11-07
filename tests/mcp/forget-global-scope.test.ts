/**
 * `squish_forget` bulk delete must not destroy shared global context.
 *
 * The bulk path searches with the resolved project scope and then calls
 * `forget(id)` on every hit. `forget` -> `deleteMemoryPermanently(id)` deletes
 * by id with NO project check. Since recall was widened so a project scope also
 * matches `project_id IS NULL`, a project-scoped bulk forget now matches every
 * global row and permanently deletes rows that belong to no single project and
 * that every agent sharing the database can see.
 *
 * The dry run reported the honest total, but nothing distinguished "these three
 * are mine" from "these three are shared". The handler now partitions the hits
 * and requires an explicit `includeGlobal` opt-in before it will delete a
 * global row.
 *
 * These tests drive the real registered handler against a real database in a
 * temp data dir, so the destructive path itself is exercised rather than a
 * reimplementation of its intent.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-forget-global-'));
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER ||= 'local';
process.env.SQUISH_RERANKER_ENABLED ||= 'false';
process.env.SQUISH_QUIET = '1';

const { resetDb, getDb } = await import('../../db/index.js');
const { rememberMemory } = await import('../../core/memory/memories.js');
const { getOrCreateProject } = await import('../../core/projects.js');
const { registerMemoryTools } = await import('../../mcp/tools/memory.js');
const { SquishRuntime } = await import('../../core/runtime/squish-runtime.js');

const TEST_PROJECT = '/proj/forget-global';

type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

let sqliteClient: any;
let forget: Handler;
let sdkClient: InstanceType<typeof SquishRuntime>;
let testProjectId: string;

/** Pull the `squish_forget` handler out of the real registration. */
function captureHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const ctx = {
    register: (_server: unknown, name: string, _definition: unknown, handler: Handler) => {
      handlers.set(name, handler);
      return true;
    },
    // The handler never touches the server object itself; the MCP transport
    // supplies the real one.
    server: {} as never,
    sdkClient: (sdkClient = new SquishRuntime()),
    resolveProjectPath: () => TEST_PROJECT,
    errorResponse: (code: string, message: string, detail?: string, remediation?: string) => ({
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: false, error: code, message, detail, remediation }),
      }],
      isError: true,
    }),
    SERVER_VERSION: 'test',
  };
  registerMemoryTools(ctx as never);
  return handlers;
}

async function callForget(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await forget(args);
  return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

function memoryExists(id: string): boolean {
  const row = sqliteClient.prepare('SELECT id FROM memories WHERE id = ?').get(id);
  return row !== undefined && row !== null;
}

afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  delete process.env.SQUISH_DATA_DIR;
  delete process.env.SQUISH_QUIET;
});

describe('squish_forget bulk delete respects global scope', () => {
  beforeAll(() => {
    forget = captureHandlers().get('squish_forget')!;
    expect(forget).toBeDefined();
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = tempDir;
    process.env.DATABASE_URL = '';
    resetDb();
    sqliteClient = (await getDb() as any).$client;
    sqliteClient.exec('DELETE FROM memories;');
    sqliteClient.exec('DELETE FROM knowledge;');
    sqliteClient.exec('DELETE FROM projects;');
    testProjectId = (await getOrCreateProject(TEST_PROJECT)).id;
  });

  test('bulk forget does not delete a global memory without includeGlobal', async () => {
    const query = 'thistlething must not be destroyed by a project scoped bulk forget';
    const globalMemory = await rememberMemory({ content: query, type: 'fact' });
    const projectMemory = await rememberMemory({ content: `${query} project scoped`, type: 'fact', project: TEST_PROJECT });

    // Dry run first: the honest total plus the partition, so a caller can see
    // what is theirs and what is shared before confirming.
    const dryRun = await callForget({ search: query });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.matchedProject).toBe(1);
    expect(dryRun.matchedGlobal).toBe(1);
    expect(dryRun.deleted).toBe(0);

    const confirmed = await callForget({ search: query, confirm: true });
    expect(confirmed.dryRun).toBe(false);
    expect(confirmed.deleted).toBe(1);
    expect(confirmed.skippedGlobal).toBe(1);

    // The project's own memory is gone; the shared global row survives.
    expect(memoryExists(projectMemory.id)).toBe(false);
    expect(memoryExists(globalMemory.id)).toBe(true);
  }, 60_000);

  test('bulk forget deletes global memories when includeGlobal is explicitly set', async () => {
    const query = 'quillonstone global cleanup is allowed when the caller opts in';
    const globalMemory = await rememberMemory({ content: query, type: 'fact' });

    const confirmed = await callForget({ search: query, confirm: true, includeGlobal: true });
    expect(confirmed.deleted).toBe(1);
    expect(confirmed.skippedGlobal).toBe(0);
    expect(memoryExists(globalMemory.id)).toBe(false);
  }, 60_000);

  test('bulk forget rechecks project ownership atomically and preserves source projections and recovery indexes', async () => {
    const sessionId = 'project-forget-scope-race-session';
    const query = 'brindlecrane project forget scope race must preserve session recovery';
    const memory = await rememberMemory({
      content: query,
      type: 'fact',
      project: TEST_PROJECT,
      tags: [`squish_session:${sessionId}`],
      source: `session_chunk:${sessionId}`,
    });
    const projectionId = 'synthetic-project-forget-race-projection';
    sqliteClient.prepare(`INSERT INTO knowledge
      (id, project_id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
      VALUES (?, ?, 'memory', 'fact', ?, ?, strftime('%s','now'), strftime('%s','now'))`)
      .run(projectionId, testProjectId, query, JSON.stringify({ sourceMemoryId: memory.id }));
    const otherProjectId = (await getOrCreateProject('/proj/forget-race-foreign')).id;
    sqliteClient.prepare(`INSERT INTO memory_private_session_index
      (session_token, memory_id, project_id, user_id, team_id, record_mac)
      VALUES (?, ?, ?, NULL, NULL, ?)`)
      .run('synthetic-session-token', memory.id, testProjectId, 'synthetic-record-mac');

    const originalGetMemoriesByIds = sdkClient.getMemoriesByIds.bind(sdkClient);
    sdkClient.getMemoriesByIds = async (ids, caller) => {
      const rows = await originalGetMemoriesByIds(ids, caller);
      // Simulate ownership changing after the handler's classification read,
      // but before permanent forget acquires its SQLite write transaction.
      sqliteClient.prepare('UPDATE memories SET project_id = ? WHERE id = ?').run(otherProjectId, memory.id);
      sqliteClient.prepare('UPDATE knowledge SET project_id = ? WHERE id = ?').run(otherProjectId, projectionId);
      sqliteClient.prepare('UPDATE memory_private_session_index SET project_id = ? WHERE memory_id = ?')
        .run(otherProjectId, memory.id);
      return rows;
    };

    try {
      const raced = await callForget({ search: query, confirm: true });
      expect(raced.deleted).toBe(0);
      expect(raced.failed).toEqual([{ id: memory.id, error: 'scope_changed_or_not_found' }]);
      expect(sqliteClient.prepare('SELECT project_id FROM memories WHERE id = ?').get(memory.id))
        .toEqual({ project_id: otherProjectId });
      expect(sqliteClient.prepare('SELECT project_id FROM knowledge WHERE id = ?').get(projectionId))
        .toEqual({ project_id: otherProjectId });
      expect(sqliteClient.prepare('SELECT project_id FROM memory_private_session_index WHERE memory_id = ?').get(memory.id))
        .toEqual({ project_id: otherProjectId });
    } finally {
      sdkClient.getMemoriesByIds = originalGetMemoriesByIds;
    }

    sqliteClient.prepare('UPDATE memories SET project_id = ? WHERE id = ?').run(testProjectId, memory.id);
    sqliteClient.prepare('UPDATE knowledge SET project_id = ? WHERE id = ?').run(testProjectId, projectionId);
    sqliteClient.prepare('UPDATE memory_private_session_index SET project_id = ? WHERE memory_id = ?')
      .run(testProjectId, memory.id);
    const confirmed = await callForget({ search: query, confirm: true });
    expect(confirmed.deleted).toBe(1);
    expect(memoryExists(memory.id)).toBe(false);
    expect(sqliteClient.prepare('SELECT id FROM knowledge WHERE id = ?').get(projectionId)).toBeNull();
    expect(sqliteClient.prepare('SELECT memory_id FROM memory_private_session_index WHERE memory_id = ?').get(memory.id))
      .toBeNull();
  }, 60_000);

  test('single-memory forget by id is unchanged', async () => {
    const memory = await rememberMemory({
      content: 'single delete path keeps its existing behaviour',
      type: 'fact',
      project: TEST_PROJECT,
    });

    const result = await callForget({ memoryId: memory.id });
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(1);
    expect(memoryExists(memory.id)).toBe(false);
  }, 60_000);
});
