import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordFeedback, getRetrievalStats } from '../../../core/memory/retrieval-feedback.js';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-job-runner-')).replaceAll('\\', '/');
const savedEnv = {
  SQUISH_DATA_DIR: process.env.SQUISH_DATA_DIR,
  DATABASE_URL: process.env.DATABASE_URL,
  SQUISH_EMBEDDINGS_PROVIDER: process.env.SQUISH_EMBEDDINGS_PROVIDER,
  SQUISH_LOCAL_BUNDLED_MODEL: process.env.SQUISH_LOCAL_BUNDLED_MODEL,
};
process.env.SQUISH_DATA_DIR = dataDir.replaceAll('\\', '/');
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';

let archiveStaleMemories: typeof import('../../../core/scheduler/job-runner.js').archiveStaleMemories;
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let getDb: typeof import('../../../db/index.js').getDb;
let closeAllDbs: typeof import('../../../db/index.js').closeAllDbs;

beforeAll(async () => {
  ({ archiveStaleMemories } = await import('../../../core/scheduler/job-runner.js'));
  ({ rememberMemory } = await import('../../../core/memory/memories.js'));
  ({ getDb, closeAllDbs } = await import('../../../db/index.js'));
});

afterAll(async () => {
  await closeAllDbs();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may briefly retain a SQLite handle. */ }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('weekly stale memory archive lifecycle', () => {
  it('archives a legacy same-ID canonical projection without source metadata', async () => {
    const db = await getDb();
    const sqlite = db.$client;
    const memoryId = 'archive-legacy-same-id-projection';
    const staleAccess = Math.floor(new Date(1_000_000_000_000).getTime() / 1000);
    sqlite.prepare(`INSERT INTO memories
      (id, type, content, status, is_active, last_accessed_at, importance_score, is_protected, is_pinned, context_status)
      VALUES (?, 'fact', 'Legacy archive projection fixture', 'active', 1, ?, 10, 0, 0, 'out-of-context')`)
      .run(memoryId, staleAccess);
    sqlite.prepare(`INSERT INTO knowledge
      (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES (?, 'memory', 'fact', 'Legacy archive projection fixture', '{}', 'active', 1)`)
      .run(memoryId);

    expect(await archiveStaleMemories(90)).toBe(1);
    expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get(memoryId))
      .toMatchObject({ status: 'archived', is_active: 0 });
    expect(sqlite.prepare('SELECT status, is_active FROM knowledge WHERE id = ?').get(memoryId))
      .toMatchObject({ status: 'archived', is_active: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_snapshots WHERE memory_id = ? AND snapshot_type = 'archive'")
      .get(memoryId)?.count).toBe(1);
  });

  it('atomically snapshots and archives both source and canonical projection, then removes it from recall', async () => {
    const memory = await rememberMemory({ content: 'Unique archive lifecycle record: cobalt aurora retained.' , type: 'fact' });
    const db = await getDb();
    const sqlite = db.$client;
    const sql = (sqlite as any).prepare.bind(sqlite);
    const staleAccess = new Date(1_000_000_000_000);
    sql(`UPDATE memories SET last_accessed_at = ?, importance_score = 10,
      is_protected = 0, is_pinned = 0, context_status = 'out-of-context' WHERE id = ?`).run(Math.floor(staleAccess.getTime() / 1000), memory.id);
    recordFeedback(memory.id, 'archive lifecycle query', { sessionId: 'archive-feedback' });
    expect(getRetrievalStats(memory.id).totalRetrievals).toBe(1);
    expect(await archiveStaleMemories(90)).toBe(1);
    expect(getRetrievalStats(memory.id).totalRetrievals).toBe(0);
    const source = sqlite.prepare('SELECT status, is_active, context_status, recorded_at, content FROM memories WHERE id = ?').get(memory.id) as {
      status: string; is_active: number; context_status: string; recorded_at: number; content: string;
    };
    expect(source).toMatchObject({ status: 'archived', is_active: 0, context_status: 'archived', content: memory.content });
    const projection = sqlite.prepare(`SELECT status, is_active, recorded_at FROM knowledge
      WHERE knowledge_kind = 'memory' AND json_extract(metadata, '$.sourceMemoryId') = ?`).get(memory.id) as {
      status: string; is_active: number; recorded_at: number;
    };
    expect(projection).toEqual({ status: 'archived', is_active: 0, recorded_at: source.recorded_at });
    const snapshot = sqlite.prepare("SELECT snapshot_type, content FROM memory_snapshots WHERE memory_id = ? AND snapshot_type = 'archive'").get(memory.id) as {
      snapshot_type: string; content: string;
    };
    expect(snapshot).toEqual({ snapshot_type: 'archive', content: memory.content });

    const { ensureProject } = await import('../../../core/projects.js');
    await ensureProject(dataDir);
    const { search } = await import('../../../core/memory/memories.js');
    sqlite.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    sqlite.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
    const results = await search({ query: 'cobalt aurora retained', project: dataDir });
    expect(results.some((result) => result.id === memory.id)).toBe(false);
    expect(await archiveStaleMemories(90)).toBe(0);
  });

  it('does not duplicate an archive snapshot when another lifecycle writer wins the race', async () => {
    const memory = await rememberMemory({ content: 'Archive race lifecycle fixture', type: 'fact' });
    const db = await getDb();
    const sqlite = db.$client;
    const staleAccess = Math.floor(new Date(1_000_000_000_000).getTime() / 1000);
    sqlite.prepare(`UPDATE memories SET last_accessed_at = ?, importance_score = 10,
      is_protected = 0, is_pinned = 0, context_status = 'out-of-context' WHERE id = ?`).run(staleAccess, memory.id);
    sqlite.exec(`CREATE TRIGGER win_archive_race BEFORE UPDATE OF context_status ON memories
      WHEN OLD.id = '${memory.id}' AND NEW.context_status = 'archived'
      BEGIN
        UPDATE memories SET context_status = 'archived', status = 'archived', is_active = 0,
          recorded_at = NEW.recorded_at, updated_at = NEW.updated_at WHERE id = OLD.id;
        UPDATE knowledge SET status = 'archived', is_active = 0,
          recorded_at = NEW.recorded_at, updated_at = NEW.updated_at
          WHERE knowledge_kind = 'memory'
            AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = OLD.id;
        INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content, metadata, created_at)
          VALUES ('archive-race-snapshot', OLD.id, 'archive', OLD.content, '{"lifecycle":"stale_archive"}', NEW.updated_at);
        SELECT RAISE(IGNORE);
      END`);

    try {
      expect(await archiveStaleMemories(90)).toBe(0);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_snapshots WHERE memory_id = ? AND snapshot_type = 'archive'")
        .get(memory.id)?.count).toBe(1);
      expect(sqlite.prepare('SELECT status, is_active, context_status FROM memories WHERE id = ?').get(memory.id))
        .toMatchObject({ status: 'archived', is_active: 0, context_status: 'archived' });
      expect(sqlite.prepare(`SELECT status, is_active FROM knowledge WHERE knowledge_kind = 'memory'
        AND json_extract(metadata, '$.sourceMemoryId') = ?`).get(memory.id))
        .toMatchObject({ status: 'archived', is_active: 0 });
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS win_archive_race');
    }
  });

  it('does not archive pinned, protected, or recently accessed records', async () => {
    const pinned = await rememberMemory({ content: 'Pinned memory lifecycle candidate', type: 'fact' });
    const protectedMemory = await rememberMemory({ content: 'Protected memory lifecycle candidate', type: 'fact' });
    const recent = await rememberMemory({ content: 'Recently used lifecycle candidate', type: 'fact' });
    const db = await getDb();
    const sqlite = db.$client;
    const sql = (sqlite as any).prepare.bind(sqlite);
    const staleAccess = new Date(1_000_000_000_000);
    sql("UPDATE memories SET last_accessed_at = ?, importance_score = 10, is_pinned = 1, context_status = 'out-of-context' WHERE id = ?").run(Math.floor(staleAccess.getTime() / 1000), pinned.id);
    sql("UPDATE memories SET last_accessed_at = ?, importance_score = 10, is_protected = 1, context_status = 'out-of-context' WHERE id = ?").run(Math.floor(staleAccess.getTime() / 1000), protectedMemory.id);
    sql("UPDATE memories SET last_accessed_at = ?, importance_score = 10, context_status = 'out-of-context' WHERE id = ?").run(Math.floor(Date.now() / 1000), recent.id);

    expect(await archiveStaleMemories(90)).toBe(0);
    const states = sqlite.prepare('SELECT id, status, context_status FROM memories WHERE id IN (?, ?, ?) ORDER BY id').all(pinned.id, protectedMemory.id, recent.id) as Array<{ id: string; status: string; context_status: string }>;
    expect(states.every((row) => row.status === 'active' && row.context_status === 'out-of-context')).toBe(true);
  });

  it('leaves out-of-window sources for temporal expiry instead of converting them to archives', async () => {
    const expiredByValidity = await rememberMemory({ content: 'Archive guard expired valid-time fixture', type: 'fact' });
    const expiredByDeadline = await rememberMemory({ content: 'Archive guard expired deadline fixture', type: 'fact' });
    const notYetValid = await rememberMemory({ content: 'Archive guard future valid-time fixture', type: 'fact' });
    const db = await getDb();
    const sqlite = db.$client;
    const staleAccess = Math.floor(new Date(1_000_000_000_000).getTime() / 1000);
    const nowSeconds = Math.floor(Date.now() / 1000);
    sqlite.prepare(`UPDATE memories SET last_accessed_at = ?, importance_score = 10,
      is_protected = 0, is_pinned = 0, context_status = 'out-of-context', valid_to = ? WHERE id = ?`)
      .run(staleAccess, (nowSeconds - 1) * 1000, expiredByValidity.id);
    sqlite.prepare(`UPDATE memories SET last_accessed_at = ?, importance_score = 10,
      is_protected = 0, is_pinned = 0, context_status = 'out-of-context', expires_at = ? WHERE id = ?`)
      .run(staleAccess, nowSeconds - 1, expiredByDeadline.id);
    sqlite.prepare(`UPDATE memories SET last_accessed_at = ?, importance_score = 10,
      is_protected = 0, is_pinned = 0, context_status = 'out-of-context', valid_from = ? WHERE id = ?`)
      .run(staleAccess, nowSeconds + 60, notYetValid.id);

    expect(await archiveStaleMemories(90)).toBe(0);
    for (const memory of [expiredByValidity, expiredByDeadline, notYetValid]) {
      expect(sqlite.prepare('SELECT status, is_active, context_status FROM memories WHERE id = ?').get(memory.id))
        .toMatchObject({ status: 'active', is_active: 1, context_status: 'out-of-context' });
      expect(sqlite.prepare(`SELECT status, is_active FROM knowledge WHERE knowledge_kind = 'memory'
        AND json_extract(metadata, '$.sourceMemoryId') = ?`).get(memory.id))
        .toMatchObject({ status: 'active', is_active: 1 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_snapshots WHERE memory_id = ? AND snapshot_type = 'archive'")
        .get(memory.id)?.count).toBe(0);
    }
  });

  it('rolls back source state and archive snapshot when projection synchronization fails', async () => {
    const memory = await rememberMemory({ content: 'Archive rollback projection failure fixture', type: 'fact' });
    const db = await getDb();
    const sqlite = db.$client;
    const staleAccess = Math.floor(new Date(1_000_000_000_000).getTime() / 1000);
    sqlite.prepare(`UPDATE memories SET last_accessed_at = ?, importance_score = 10,
      is_protected = 0, is_pinned = 0, context_status = 'out-of-context' WHERE id = ?`).run(staleAccess, memory.id);
    recordFeedback(memory.id, 'archive rollback query', { sessionId: 'archive-rollback-feedback' });
    sqlite.exec(`CREATE TRIGGER reject_archive_projection BEFORE UPDATE ON knowledge
      WHEN OLD.knowledge_kind = 'memory'
        AND json_extract(CASE WHEN json_valid(OLD.metadata) THEN OLD.metadata ELSE '{}' END, '$.sourceMemoryId') = '${memory.id}'
      BEGIN SELECT RAISE(ABORT, 'injected archive projection failure'); END`);

    try {
      await expect(archiveStaleMemories(90)).rejects.toThrow('injected archive projection failure');
      const source = sqlite.prepare('SELECT status, context_status, is_active FROM memories WHERE id = ?').get(memory.id);
      expect(source).toMatchObject({ status: 'active', context_status: 'out-of-context', is_active: 1 });
      expect(getRetrievalStats(memory.id).totalRetrievals).toBe(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_snapshots WHERE memory_id = ? AND snapshot_type = 'archive'").get(memory.id).count).toBe(0);
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS reject_archive_projection');
    }

    expect(await archiveStaleMemories(90)).toBe(1);
    expect(getRetrievalStats(memory.id).totalRetrievals).toBe(0);
  });
});
