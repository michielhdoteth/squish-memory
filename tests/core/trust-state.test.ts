import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'bun:test';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let resolveProjectScope: typeof import('../../core/runtime/trust-state.js').resolveProjectScope;
let ensureProject: typeof import('../../core/projects.js').ensureProject;
let resetDb: typeof import('../../db/index.js').resetDb;
let buildStatsState: typeof import('../../core/runtime/trust-state.js').buildStatsState;
let buildHealthState: typeof import('../../core/runtime/trust-state.js').buildHealthState;
let deriveFacts: typeof import('../../core/memory/fact-deriver.js').deriveFacts;

describe('trust-state', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-trust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const trustState = await import('../../core/runtime/trust-state.js');
    const projects = await import('../../core/projects.js');
    const db = await import('../../db/index.js');
    resolveProjectScope = trustState.resolveProjectScope;
    buildStatsState = trustState.buildStatsState;
    buildHealthState = trustState.buildHealthState;
    ({ deriveFacts } = await import('../../core/memory/fact-deriver.js'));
    ensureProject = projects.ensureProject;
    resetDb = db.resetDb;

    resetDb();
    await ensureProject(process.cwd());
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
  });

  it('marks explicit project paths as explicit', async () => {
    const scope = await resolveProjectScope(process.cwd());
    expect(scope.currentProject.path).toBe(process.cwd());
    expect(['explicit', 'auto-created']).toContain(scope.currentProject.resolution);
  });

  it('withholds unscoped graph metrics and returns no derivations for an empty strict graph', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-health-caller';
    try {
      const project = await ensureProject(process.cwd());
      const stats = await buildStatsState(project.path);
      expect(stats.graph.status).toBe('withheld by strict trust policy');
      expect(stats.graph.enrichments).toBe(0);
      expect(stats.totals).toEqual({ memories: 0, durable: 0, sessionLocal: 0 });
      expect(stats.places).toEqual({ active: 0, named: [] });
      expect(stats.signal).toEqual({ captured: 0, suppressed: 0, sessionOnly: 0, durable: 0, durableWithRaw: 0, tokensSaved: 0, placeRouted: 0, graphEnriched: 0 });

      const health = await buildHealthState(project.path);
      expect(health.checks.find((check) => check.name === 'graph')).toMatchObject({
        status: 'ok',
        detail: 'Graph statistics are withheld by strict trust policy.',
      });
      await expect(deriveFacts(project.id)).resolves.toEqual([]);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });
});
