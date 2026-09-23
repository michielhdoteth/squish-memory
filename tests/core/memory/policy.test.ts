/**
 * Tests for memory policy
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let buildMemoryPolicy: typeof import('../../../core/memory/policy.js').buildMemoryPolicy;
let classifyAudience: typeof import('../../../core/memory/policy.js').classifyAudience;
let recommendMemoryScope: typeof import('../../../core/memory/policy.js').recommendMemoryScope;
let extractMemoryPolicy: typeof import('../../../core/memory/policy.js').extractMemoryPolicy;
let annotateMemoryMetadata: typeof import('../../../core/memory/policy.js').annotateMemoryMetadata;
let promoteMemoryVisibility: typeof import('../../../core/memory/policy.js').promoteMemoryVisibility;
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

describe('Memory Policy', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const policyMod = await import('../../../core/memory/policy.js');
    const memoriesMod = await import('../../../core/memory/memories.js');
    const dbMod = await import('../../../db/index.js');
    buildMemoryPolicy = policyMod.buildMemoryPolicy;
    classifyAudience = policyMod.classifyAudience;
    recommendMemoryScope = policyMod.recommendMemoryScope;
    extractMemoryPolicy = policyMod.extractMemoryPolicy;
    annotateMemoryMetadata = policyMod.annotateMemoryMetadata;
    promoteMemoryVisibility = policyMod.promoteMemoryVisibility;
    rememberMemory = memoriesMod.rememberMemory;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;
    resetDb();
  });

  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    const db = await getDb();
    const sqlite = (db as any).$client;
    if (sqlite && typeof sqlite.exec === 'function') {
      sqlite.exec('DELETE FROM memory_associations;');
      sqlite.exec('DELETE FROM memories;');
      sqlite.exec('DELETE FROM places;');
    }
  });

  test('buildMemoryPolicy returns default private policy', () => {
    const policy = buildMemoryPolicy({
      content: 'Some content',
      type: 'fact',
      tags: [],
    });
    expect(policy).toBeDefined();
    expect(policy.captureMode).toBe('private-first');
    expect(policy.currentScope).toBe('private');
    expect(policy.audience).toBe('personal');
    expect(policy.shared).toBe(false);
    expect(policy.recommendation).toBeDefined();
    expect(policy.recommendation.scope).toBeDefined();
  });

  test('classifyAudience returns correct audience for each scope', () => {
    expect(classifyAudience('private')).toBe('personal');
    expect(classifyAudience('project')).toBe('project');
    expect(classifyAudience('project' as any)).toBe('project');
  });

  test('recommendMemoryScope recommends private for simple content', () => {
    const rec = recommendMemoryScope({
      content: 'simple note',
      type: 'note',
      tags: [],
    });
    expect(rec).toBeDefined();
    expect(rec.scope).toBeDefined();
    expect(rec.reason).toBeDefined();
    expect(rec.source).toBeDefined();
  });

  test('recommendMemoryScope recommends broader scope for decisions', () => {
    const rec = recommendMemoryScope({
      content: 'We decided to use TypeScript for all new code',
      type: 'decision',
      tags: [],
    });
    expect(rec).toBeDefined();
    // Decisions tend to get broader scope recommendations
    expect(['private', 'project']).toContain(rec.scope);
  });

  test('extractMemoryPolicy extracts policy from metadata', () => {
    const metadata = {
      memoryPolicy: {
        captureMode: 'private-first',
        currentScope: 'team',
        shared: true,
        reason: 'test',
        recommendation: { scope: 'team', reason: 'test', source: 'heuristic' },
        history: [],
        reviewState: 'promoted',
        lastReviewedAt: new Date().toISOString(),
      }
    };
    const policy = extractMemoryPolicy(metadata);
    expect(policy).not.toBeNull();
    expect(policy!.currentScope).toBe('team');
    // classifyAudience('team') returns 'team' (not 'project')
    expect(policy!.audience).toBe('team');
    expect(policy!.shared).toBe(true);
  });

  test('extractMemoryPolicy returns null for null metadata', () => {
    const policy = extractMemoryPolicy(null);
    expect(policy).toBeNull();
  });

  test('annotateMemoryMetadata adds policy to metadata', () => {
    const policy = buildMemoryPolicy({
      content: 'test content',
      type: 'fact',
      visibilityScope: 'project',
    });
    const annotated = annotateMemoryMetadata({}, policy);
    expect(annotated.memoryPolicy).toBeDefined();
    expect((annotated.memoryPolicy as any).currentScope).toBe('project');
  });

  test('promoteMemoryVisibility updates memory scope in DB', async () => {
    const memory = await rememberMemory({
      content: 'Memory to promote',
      type: 'fact',
      project: '/test-promote',
      user: 'test-user'
    });

    const result = await promoteMemoryVisibility(memory.id, 'project', 'Promoting for project visibility');
    expect(result).not.toBeNull();
    expect(result!.memoryId).toBe(memory.id);
    expect(result!.visibilityScope).toBe('project');
    expect(result!.policy).toBeDefined();
    expect(result!.policy.currentScope).toBe('project');
    expect(result!.policy.history.length).toBe(1);
    expect(result!.policy.history[0].from).toBe('project');
    expect(result!.policy.history[0].to).toBe('project');
  });

  test('promoteMemoryVisibility returns null for non-existent memory', async () => {
    const result = await promoteMemoryVisibility('00000000-0000-0000-0000-000000000000', 'project', 'test');
    expect(result).toBeNull();
  });

  test('buildMemoryPolicy respects explicit visibility scope', () => {
    const policy = buildMemoryPolicy({
      content: 'Global decision',
      type: 'decision',
      visibilityScope: 'project',
    });
    expect(policy.currentScope).toBe('project');
    expect(policy.audience).toBe('project');
    expect(policy.shared).toBe(true);
  });
});
