import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';
import { extractFacts, type FactExtractionResult } from '../../core/memory/fact-extractor.js';

let rememberMemory: typeof import('../../core/memory/memories.js').rememberMemory;
let getDb: typeof import('../../db/index.js').getDb;
let resetDb: typeof import('../../db/index.js').resetDb;
let processMemoryAnalysisJobs: typeof import('../../core/memory/fact-extraction-worker.js').processMemoryAnalysisJobs;
let dataDir: string;
let oldDataDir: string | undefined;
let oldDatabaseUrl: string | undefined;

const twoFacts: FactExtractionResult = {
  facts: [
    { content: 'The project uses SQLite for durable local storage.', confidence: 0.91, entities: ['SQLite'] },
    { content: 'The project schedules background processing hourly.', confidence: 0.82, entities: ['project'] },
  ], summary: 'Project storage and scheduling.', entities: ['SQLite', 'project'],
};

describe('durable fact extraction pipeline', () => {
  it('treats an empty model extraction as a successful empty result', async () => {
    const source = 'A sufficiently long source text that does not contain any durable facts for extraction.';
    const result = await extractFacts(source, async () => JSON.stringify({ facts: [], summary: '', entities: [] }));

    expect(result.facts).toEqual([]);
    expect(result.summary).toBe(source.substring(0, 200));
  });

  beforeAll(async () => {
    oldDataDir = process.env.SQUISH_DATA_DIR;
    oldDatabaseUrl = process.env.DATABASE_URL;
    dataDir = join(tmpdir(), `squish-fact-pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    ({ rememberMemory } = await import('../../core/memory/memories.js'));
    ({ getDb, resetDb } = await import('../../db/index.js'));
    ({ processMemoryAnalysisJobs } = await import('../../core/memory/fact-extraction-worker.js'));
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
    raw.exec('DELETE FROM knowledge; DELETE FROM memory_analysis_jobs; DELETE FROM memories;');
  });

  it('projects idempotent facts with source/project provenance', async () => {
    const source = await rememberMemory({ content: 'A sufficiently long source memory about the system and its storage.', project: '/fact-pipeline' });
    const raw = (await getDb() as any).$client;
    const job = raw.prepare('SELECT id, project_id, available_at, job_kind, status FROM memory_analysis_jobs WHERE source_memory_id = ?').get(source.id);
    expect(job.status).toBe('pending');
    expect(job.job_kind).toBe('analyze_memory');
    expect(Number(job.available_at)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    const extract = async () => twoFacts;
    expect(await processMemoryAnalysisJobs({ extract, limit: 10 })).toMatchObject({ processed: 1 });
    let facts = raw.prepare("SELECT id, project_id, confidence, tags, metadata FROM knowledge WHERE knowledge_kind='memory' AND knowledge_type='fact'").all();
    expect(facts).toHaveLength(2);
    expect(facts.every((f: any) => f.project_id === job.project_id && f.tags && JSON.parse(f.tags).includes('extracted-fact'))).toBe(true);
    expect(facts.map((f: any) => JSON.parse(f.metadata))).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceMemoryId: source.id, analysisJobId: job.id, factIndex: 0 }),
      expect.objectContaining({ sourceMemoryId: source.id, analysisJobId: job.id, factIndex: 1 }),
    ]));
    raw.prepare("UPDATE memory_analysis_jobs SET status='pending', available_at=0 WHERE id=?").run(job.id);
    await processMemoryAnalysisJobs({ extract, limit: 10 });
    facts = raw.prepare("SELECT id FROM knowledge WHERE knowledge_kind='memory' AND knowledge_type='fact'").all();
    expect(facts).toHaveLength(2);
  });

  it('projects beliefs and strategies through the durable analysis job', async () => {
    const source = await rememberMemory({ content: 'I prefer SQLite because it is reliable. Always use backups before migration.', project: '/analysis-typed' });
    const raw = (await getDb() as any).$client;
    const job = raw.prepare('SELECT id, project_id FROM memory_analysis_jobs WHERE source_memory_id=?').get(source.id);
    await processMemoryAnalysisJobs({ extract: async () => twoFacts });
    const typed = raw.prepare("SELECT knowledge_kind, knowledge_type, project_id, metadata FROM knowledge WHERE knowledge_kind IN ('fact','belief','strategy')").all();
    expect(typed.some((r: any) => r.knowledge_kind === 'belief')).toBe(true);
    expect(typed.some((r: any) => r.knowledge_kind === 'strategy')).toBe(true);
    expect(typed.every((r: any) => r.project_id === job.project_id)).toBe(true);
    expect(typed.filter((r: any) => ['belief', 'strategy'].includes(r.knowledge_kind)).every((r: any) => {
      const metadata = JSON.parse(r.metadata);
      return metadata.sourceMemoryId === source.id && metadata.analysisJobId === job.id;
    })).toBe(true);
    expect(raw.prepare("SELECT COUNT(*) n FROM knowledge WHERE knowledge_kind='memory' AND knowledge_type!='fact'").get().n).toBe(1);
    const strategy = raw.prepare("SELECT id FROM knowledge WHERE knowledge_kind='strategy'").get() as { id: string };
    expect(raw.prepare("SELECT id FROM knowledge_edges WHERE from_id=? AND to_id=? AND edge_type='sourced_from'").get(strategy.id, source.id)).toBeTruthy();
    const projectionCount = typed.length;
    raw.prepare("UPDATE memory_analysis_jobs SET status='pending', available_at=0 WHERE id=?").run(job.id);
    await processMemoryAnalysisJobs({ extract: async () => twoFacts });
    expect(raw.prepare("SELECT COUNT(*) n FROM knowledge WHERE knowledge_kind IN ('fact','belief','strategy')").get().n).toBe(projectionCount);
    expect(raw.prepare("SELECT source_count FROM knowledge WHERE knowledge_kind='belief'").get().source_count).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) n FROM knowledge_edges WHERE edge_type='sourced_from' AND to_id=?").get(source.id).n).toBe(2);
  });

  it('increments belief evidence once for each distinct source memory', async () => {
    const first = await rememberMemory({ content: 'I prefer SQLite because it is reliable. Source marker alpha.', project: '/belief-source-count' });
    const raw = (await getDb() as any).$client;
    const extract = async () => twoFacts;
    await processMemoryAnalysisJobs({ extract });
    const second = await rememberMemory({ content: 'I prefer SQLite because it is reliable. Source marker beta.', project: '/belief-source-count' });
    await processMemoryAnalysisJobs({ extract });

    let belief = raw.prepare("SELECT id, source_count FROM knowledge WHERE knowledge_kind='belief' AND project_id=(SELECT project_id FROM memories WHERE id=?)").get(first.id) as { id: string; source_count: number };
    expect(belief.source_count).toBe(2);
    expect(raw.prepare("SELECT COUNT(*) n FROM knowledge_edges WHERE from_id=? AND edge_type='sourced_from'").get(belief.id).n).toBe(2);

    const secondJob = raw.prepare('SELECT id FROM memory_analysis_jobs WHERE source_memory_id=?').get(second.id) as { id: string };
    raw.prepare("UPDATE memory_analysis_jobs SET status='pending', available_at=0 WHERE id=?").run(secondJob.id);
    await processMemoryAnalysisJobs({ extract });
    belief = raw.prepare("SELECT id, source_count FROM knowledge WHERE id=?").get(belief.id) as { id: string; source_count: number };
    expect(belief.source_count).toBe(2);
    expect(raw.prepare("SELECT COUNT(*) n FROM knowledge_edges WHERE from_id=? AND edge_type='sourced_from'").get(belief.id).n).toBe(2);
  });

  it('fails an already-exhausted expired lease without extracting', async () => {
    const source = await rememberMemory({ content: 'Already exhausted expired lease regression test.', project: '/fact-expired-exhausted' });
    const raw = (await getDb() as any).$client;
    const job = raw.prepare('SELECT id FROM memory_analysis_jobs WHERE source_memory_id=?').get(source.id);
    const now = Date.now();
    raw.prepare("UPDATE memory_analysis_jobs SET status='processing', locked_at=?, attempts=8 WHERE id=?").run(Math.floor(now / 1000) - 901, job.id);
    let called = false;
    await processMemoryAnalysisJobs({ now: () => now, extract: async () => { called = true; return twoFacts; } });
    expect(called).toBe(false);
    expect(raw.prepare('SELECT status, attempts, locked_at, last_error_code FROM memory_analysis_jobs WHERE id=?').get(job.id))
      .toMatchObject({ status: 'failed', attempts: 8, locked_at: null, last_error_code: 'FACT_EXTRACTION_ATTEMPTS_EXHAUSTED' });
  });

  it('runs the final permitted attempt when reclaiming a seventh expired lease', async () => {
    const source = await rememberMemory({ content: 'Abandoned lease retry accounting test memory.', project: '/fact-expired' });
    const raw = (await getDb() as any).$client;
    const job = raw.prepare('SELECT id FROM memory_analysis_jobs WHERE source_memory_id=?').get(source.id);
    const now = Date.now();
    raw.prepare("UPDATE memory_analysis_jobs SET status='processing', locked_at=?, attempts=7 WHERE id=?").run(Math.floor(now / 1000) - 901, job.id);
    let called = false;
    const outcome = await processMemoryAnalysisJobs({ now: () => now, extract: async () => { called = true; return twoFacts; } });
    expect(called).toBe(true);
    expect(outcome).toMatchObject({ processed: 1, projected: 2 });
    expect(raw.prepare('SELECT status, attempts, locked_at FROM memory_analysis_jobs WHERE id=?').get(job.id))
      .toMatchObject({ status: 'completed', attempts: 8, locked_at: null });
  });

  it('does not schedule another retry after the final allowed extraction fails', async () => {
    const source = await rememberMemory({ content: 'This source is durable after the final allowed extraction fails.', project: '/fact-final-failure' });
    const raw = (await getDb() as any).$client;
    const job = raw.prepare('SELECT id FROM memory_analysis_jobs WHERE source_memory_id=?').get(source.id);
    raw.prepare("UPDATE memory_analysis_jobs SET attempts=7, available_at=0 WHERE id=?").run(job.id);
    const outcome = await processMemoryAnalysisJobs({ extract: async () => { throw new Error('provider failure'); } });
    expect(outcome).toMatchObject({ processed: 1, retried: 0 });
    expect(raw.prepare('SELECT status, attempts, locked_at, last_error_code FROM memory_analysis_jobs WHERE id=?').get(job.id))
      .toMatchObject({ status: 'failed', attempts: 8, locked_at: null, last_error_code: 'FACT_EXTRACTION_FAILED' });
  });

  it('fences a slow stale worker after another worker reclaims and completes', async () => {
    const source = await rememberMemory({ content: 'A sufficiently long source memory for lease ownership fencing.', project: '/fact-fence' });
    const raw = (await getDb() as any).$client;
    const job = raw.prepare('SELECT id FROM memory_analysis_jobs WHERE source_memory_id=?').get(source.id);
    const now = Date.now();
    let resumeFirst!: (value: FactExtractionResult) => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstResult = new Promise<FactExtractionResult>((resolve) => { resumeFirst = resolve; });
    const firstRun = processMemoryAnalysisJobs({ now: () => now, extract: async () => { firstStarted(); return firstResult; } });
    await started;
    raw.prepare("UPDATE memory_analysis_jobs SET locked_at=? WHERE id=?").run(Math.floor(now / 1000) - 901, job.id);
    await processMemoryAnalysisJobs({ now: () => now + 1000, extract: async () => twoFacts });
    expect(raw.prepare('SELECT status, attempts FROM memory_analysis_jobs WHERE id=?').get(job.id)).toMatchObject({ status: 'completed', attempts: 2 });
    resumeFirst(twoFacts);
    await firstRun;
    expect(raw.prepare('SELECT status, attempts FROM memory_analysis_jobs WHERE id=?').get(job.id)).toMatchObject({ status: 'completed', attempts: 2 });
    expect(raw.prepare("SELECT COUNT(*) as n FROM knowledge WHERE knowledge_type='fact'").get().n).toBe(2);
  });

  it('completes empty extraction and safely retries failures without losing source', async () => {
    const source = await rememberMemory({ content: 'This source memory remains durable on extractor errors.', project: '/fact-retry' });
    const raw = (await getDb() as any).$client;
    const job = raw.prepare('SELECT id FROM memory_analysis_jobs WHERE source_memory_id=?').get(source.id);
    await processMemoryAnalysisJobs({ extract: async () => ({ facts: [], summary: '', entities: [] }), limit: 1 });
    expect(raw.prepare('SELECT status FROM memory_analysis_jobs WHERE id=?').get(job.id).status).toBe('completed');
    raw.prepare("UPDATE memory_analysis_jobs SET status='pending', available_at=0, attempts=0").run();
    const now = Date.now();
    await processMemoryAnalysisJobs({ extract: async () => { throw new Error('secret source/prompt/output'); }, limit: 1, now: () => now });
    const row = raw.prepare('SELECT status, attempts, available_at, last_error_code FROM memory_analysis_jobs WHERE id=?').get(job.id);
    expect(row.attempts).toBe(1);
    expect(row.available_at).toBeGreaterThan(Math.floor(now / 1000));
    expect(row.last_error_code).not.toContain('secret');
    expect(raw.prepare('SELECT COUNT(*) as n FROM memories WHERE id=?').get(source.id).n).toBe(1);
  });

  it('skips projection when the source becomes ineligible during extraction', async () => {
    const source = await rememberMemory({ content: 'A source that becomes private while extraction is in flight.', project: '/fact-inflight-private' });
    const raw = (await getDb() as any).$client;
    const job = raw.prepare('SELECT id FROM memory_analysis_jobs WHERE source_memory_id=?').get(source.id);
    const outcome = await processMemoryAnalysisJobs({ extract: async () => {
      raw.prepare('UPDATE memories SET is_encrypted=1 WHERE id=?').run(source.id);
      return twoFacts;
    }, limit: 1 });

    expect(outcome).toMatchObject({ processed: 1, projected: 0, skipped: 1, retried: 0 });
    expect(raw.prepare('SELECT status, locked_at FROM memory_analysis_jobs WHERE id=?').get(job.id))
      .toMatchObject({ status: 'skipped', locked_at: null });
    expect(raw.prepare("SELECT COUNT(*) as n FROM knowledge WHERE knowledge_type='fact' AND metadata LIKE ?").get(`%${source.id}%`).n).toBe(0);
  });

  it('does not extract inactive or encrypted source memories', async () => {
    const source = await rememberMemory({ content: 'This source memory must not be extracted.', project: '/fact-private' });
    const raw = (await getDb() as any).$client;
    const job = raw.prepare('SELECT id FROM memory_analysis_jobs WHERE source_memory_id=?').get(source.id);
    raw.prepare('UPDATE memories SET is_encrypted=1 WHERE id=?').run(source.id);
    let called = false;
    await processMemoryAnalysisJobs({ extract: async () => { called = true; return twoFacts; }, limit: 1 });
    expect(called).toBe(false);
    expect(raw.prepare('SELECT status FROM memory_analysis_jobs WHERE id=?').get(job.id).status).toBe('skipped');
    raw.prepare('UPDATE memories SET is_encrypted=0, is_active=0 WHERE id=?').run(source.id);
    raw.prepare("UPDATE memory_analysis_jobs SET status='pending', available_at=0").run();
    await processMemoryAnalysisJobs({ extract: async () => { called = true; return twoFacts; }, limit: 1 });
    expect(called).toBe(false);
    expect(raw.prepare('SELECT status FROM memory_analysis_jobs WHERE id=?').get(job.id).status).toBe('skipped');
  });

  it('registers the worker on the existing scheduler', async () => {
    const { getAllJobHandlers } = await import('../../core/scheduler/handlers/index.js');
    expect(getAllJobHandlers().has('memory_fact_extraction')).toBe(true);
  });
});
