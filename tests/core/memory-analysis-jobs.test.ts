import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

let rememberMemory: typeof import('../../core/memory/memories.js').rememberMemory;
let getDb: typeof import('../../db/index.js').getDb;
let resetDb: typeof import('../../db/index.js').resetDb;
let dataDir: string;
let oldDataDir: string | undefined;
let oldDatabaseUrl: string | undefined;

describe('memory analysis jobs (SQLite)', () => {
  beforeAll(async () => {
    oldDataDir = process.env.SQUISH_DATA_DIR;
    oldDatabaseUrl = process.env.DATABASE_URL;
    dataDir = join(tmpdir(), `squish-analysis-jobs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    ({ rememberMemory } = await import('../../core/memory/memories.js'));
    ({ getDb, resetDb } = await import('../../db/index.js'));
  });

  afterAll(() => {
    if (oldDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = oldDataDir;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    resetDb();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    const raw = (await getDb() as any).$client;
    raw.exec('DROP TRIGGER IF EXISTS fail_analysis_job; DELETE FROM memory_analysis_jobs; DELETE FROM memories;');
  });

  it('creates the queue with only the safe last_error_code field', async () => {
    const raw = (await getDb() as any).$client;
    const columns = raw.prepare('PRAGMA table_info(memory_analysis_jobs)').all().map((column: { name: string }) => column.name);
    expect(columns).toContain('last_error_code');
    expect(columns).not.toContain('last_error');
  });

  it('enqueues one durable job for each project-scoped memory, idempotently', async () => {
    const result = await rememberMemory({ content: 'Project memory should be analyzed.', project: '/analysis-jobs' });
    const raw = (await getDb() as any).$client;
    const rows = raw.prepare('SELECT source_memory_id, job_kind, project_id, status FROM memory_analysis_jobs').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_memory_id: result.id, job_kind: 'analyze_memory', status: 'pending' });
    expect(rows[0].project_id).toBeTruthy();
    raw.prepare("INSERT OR IGNORE INTO memory_analysis_jobs (id, source_memory_id, project_id, job_kind, status) VALUES (?, ?, ?, ?, ?)").run(crypto.randomUUID(), result.id, rows[0].project_id, 'analyze_memory', 'pending');
    expect(raw.prepare('SELECT COUNT(*) as n FROM memory_analysis_jobs WHERE source_memory_id = ? AND job_kind = ?').get(result.id, 'analyze_memory').n).toBe(1);
  });

  it('does not retain the memory when its analysis job insert fails', async () => {
    const raw = (await getDb() as any).$client;
    raw.exec("CREATE TRIGGER fail_analysis_job BEFORE INSERT ON memory_analysis_jobs BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END;");
    await expect(rememberMemory({ content: 'This write must roll back.', project: '/analysis-jobs-failure' })).rejects.toThrow();
    expect(raw.prepare('SELECT COUNT(*) as n FROM memories').get().n).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) as n FROM memory_analysis_jobs').get().n).toBe(0);
  });
});
