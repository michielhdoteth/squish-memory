import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = join(tmpdir(), `squish-strict-graph-projection-${randomUUID()}`);

describe('strict graph projection boundaries', () => {
  afterAll(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Child SQLite cleanup can be delayed on Windows. */ }
  });

  test('denies direct project mutation and unscoped LLM extraction with hashed audits', () => {
    const script = `
      const dataDir = process.env.SQUISH_DATA_DIR;
      const [builder, pipeline, sync, relations, deduplicator, snapshot, extractor, dbModule] = await Promise.all([
        import('./core/graph/graph-builder.ts'),
        import('./core/graph/pipeline.ts'),
        import('./core/graph/incremental-sync.ts'),
        import('./core/graph/relationship-extractor.ts'),
        import('./core/graph/entity-deduplicator.ts'),
        import('./core/graph/snapshot-publisher.ts'),
        import('./core/graph/llm-entity-extractor.ts'),
        import('./db/index.ts'),
      ]);
      const db = await dbModule.getDb();
      const sqlite = db.$client;
      let fetchCalls = 0;
      globalThis.fetch = async () => { fetchCalls++; throw new Error('unexpected provider call'); };
      const operations = [
        () => builder.buildGraphForProject(dataDir + '/project'),
        () => builder.addMemoryToGraph('private-memory'),
        () => pipeline.buildProjectGraph(dataDir + '/project'),
        () => pipeline.buildMemoryGraph('private-memory'),
        () => sync.onMemoryStored('private-memory'),
        () => relations.extractAndStoreRelations('private-memory', 'private source text', 'project'),
        () => relations.storeExtractedRelations('private-memory', 'private source text', 'project', {
          entities: [{ name: 'Private entity', type: 'concept', confidence: 1, context: 'private' }],
          relations: [], source: 'regex',
        }),
        () => relations.clearProjectGraph('project'),
        () => deduplicator.deduplicateProjectEntities('project'),
        () => snapshot.publishProjectGraphSnapshot({}, 'project', [], []),
        () => extractor.extractEntitiesAndRelations('private text sent to optional LLM', { preferLLM: true }),
        () => extractor.batchExtractEntitiesAndRelations(['private text sent to optional LLM'], { preferLLM: true }),
      ];
      for (const operation of operations) {
        let denied = false;
        try { await operation(); } catch (error) { denied = error?.name === 'TrustBoundaryError'; }
        if (!denied) throw new Error('A strict graph projection operation was not denied');
      }
      const localExtraction = await extractor.extractEntitiesAndRelations('No named entity in this short sentence.', { preferLLM: false });
      if (localExtraction.source !== 'none') throw new Error('Strict local regex extraction changed behavior');
      const audits = sqlite.prepare(\`SELECT actor_hash, resource_hash, asset_type, decision, reason
        FROM trust_audit_log WHERE asset_type = 'graph_operation' AND decision = 'deny'\`).all();
      if (audits.length !== operations.length) throw new Error('Missing strict graph denial audits');
      if (!audits.every((row) => row.actor_hash !== process.env.SQUISH_TRUSTED_CALLER_ID
        && row.resource_hash.length === 64 && row.asset_type === 'graph_operation'
        && row.decision === 'deny' && row.reason === 'strict_surface')) {
        throw new Error('Graph denial audit leaked identifiers or has invalid fields');
      }
      if (sqlite.prepare('SELECT COUNT(*) AS count FROM entities').get().count !== 0) {
        throw new Error('Strict graph projection wrote entities');
      }
      if (fetchCalls !== 0) throw new Error('Strict graph projection invoked a provider');
      await dbModule.closeAllDbs();
      console.log('strict graph projection assertions passed');
    `;
    const child = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        TEMP: process.env.TEMP ?? tmpdir(),
        TMP: process.env.TMP ?? tmpdir(),
        USERPROFILE: process.env.USERPROFILE ?? '',
        SQUISH_DATA_DIR: dataDir,
        DATABASE_URL: '',
        SQUISH_TRUST_POLICY: 'strict',
        SQUISH_TRUSTED_CALLER_ID: 'strict-graph-projection-test-caller',
        SQUISH_LLM_ENABLED: 'true',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain('strict graph projection assertions passed');
  });
});
