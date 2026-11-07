/**
 * Graph export must write under the data directory, never into the project
 * directory. It used to write <cwd>/.squish/graph.html, which left a .squish
 * folder in whatever directory the process happened to run from.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { TrustBoundaryError } from '../../core/acl/trust-policy.js';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-graph-data-'));
const projectDir = mkdtempSync(join(tmpdir(), 'squish-graph-project-'));
const previousTrustedCaller = process.env.SQUISH_TRUSTED_CALLER_ID;

// Pin the data dir before anything imports config/db (setup-batch4 uses ||=,
// so this assignment wins).
process.env.SQUISH_DATA_DIR = dataDir;
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
process.env.SQUISH_RERANKER_ENABLED = 'false';
process.env.SQUISH_GRAPH_AUTO_BUILD = 'false';
process.env.DATABASE_URL = '';
process.env.SQUISH_DATABASE_URL = '';

describe('graph export location', () => {
  test(
    'writes graph.html/json under the data directory, not the project directory',
    async () => {
      const { exportGraphVisualization } = await import('../../core/graph/export.js');
      const result = await exportGraphVisualization(projectDir);

      expect(result.htmlPath).toBe(join(dataDir, 'graph', 'graph.html'));
      expect(result.jsonPath).toBe(join(dataDir, 'graph', 'graph.json'));
      expect(existsSync(result.htmlPath)).toBe(true);
      expect(existsSync(result.jsonPath)).toBe(true);
      expect(existsSync(join(projectDir, '.squish'))).toBe(false);
    },
    60_000,
  );

  test('strict trust denies raw graph export before project lookup and file writes', async () => {
    const previousTrustPolicy = process.env.SQUISH_TRUST_POLICY;
    const strictProjectDir = mkdtempSync(join(tmpdir(), 'squish-strict-graph-project-'));
    const graphDir = join(dataDir, 'graph');
    rmSync(graphDir, { recursive: true, force: true });
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-graph-export-audit-test';
    try {
      const { exportGraphVisualization } = await import('../../core/graph/export.js');
      await expect(exportGraphVisualization(strictProjectDir)).rejects.toBeInstanceOf(TrustBoundaryError);
      expect(existsSync(graphDir)).toBe(false);

      const { getDb } = await import('../../db/index.js');
      const { getSchema } = await import('../../db/schema.js');
      const db = await getDb();
      const schema = await getSchema();
      const projects = await db.select().from(schema.projects)
        .where(eq(schema.projects.path, strictProjectDir)).limit(1);
      expect(projects).toHaveLength(0);
      const sqlite = (db as { $client: { prepare: (query: string) => { all: () => Array<Record<string, unknown>> } } }).$client;
      const audits = sqlite.prepare(`SELECT actor_hash, resource_hash, asset_type, decision, reason
        FROM trust_audit_log WHERE asset_type = 'graph_operation' AND decision = 'deny'`).all();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actor_hash).not.toBe('strict-graph-export-audit-test');
      expect(audits[0]?.resource_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(audits[0]).toMatchObject({ asset_type: 'graph_operation', decision: 'deny', reason: 'strict_surface' });
    } finally {
      if (previousTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousTrustPolicy;
      if (previousTrustedCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousTrustedCaller;
      rmSync(strictProjectDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    const { closeAllDbs } = await import('../../db/index.js');
    try {
      await closeAllDbs();
    } catch {
      // Best effort: the process is about to exit anyway.
    }
    // Windows: SQLite may hold file handles for a moment after close.
    for (const dir of [dataDir, projectDir]) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  });
});
