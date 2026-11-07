import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SquishRuntime } from '../../core/runtime/squish-runtime.js';
import { getDbClient } from '../../core/lib/db-client.js';
import { withIsolatedBenchmarkDatabase } from '../../benchmark/runners/isolated-db.js';
import { LOCOMO_EVALUATION_TIME, parseEvidenceSessions, parseLoCoMoSessionDate, persistSessionCreatedAtBatch, resolveEvidenceSessions, retrievePersonaContext, retrievePersonaSessions, seedPersona, withLoCoMoEvaluationClock } from '../../benchmark/runners/locomo-memory.js';

describe('LoCoMo memory isolation', () => {
  test('lexical retrieval uses native FTS rank and returns no recency-only candidates', async () => {
    const previous = new Map<string, string | undefined>([
      'SQUISH_LLM_ENABLED', 'SQUISH_EMBEDDINGS_PROVIDER', 'SQUISH_DECISION_LAYER_ENABLED',
      'SQUISH_GRAPH_EXPANSION', 'SQUISH_QUERY_PARSER',
    ].map(key => [key, process.env[key]]));
    process.env.SQUISH_LLM_ENABLED = 'false';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
    process.env.SQUISH_DECISION_LAYER_ENABLED = 'false';
    process.env.SQUISH_GRAPH_EXPANSION = 'false';
    process.env.SQUISH_QUERY_PARSER = 'false';

    try {
      await withIsolatedBenchmarkDatabase(async dataDir => {
        const client = new SquishRuntime({ graphAutoBuild: false, consolidationEnabled: false });
        const project = join(dataDir, 'personas', 'lexical-only');
        mkdirSync(project, { recursive: true });
        await seedPersona(client, [
          { session: 1, date: '2026-01-01', text: 'Historical record: the observatory calibrated a violet telescope.' },
          { session: 2, date: '2026-01-02', text: 'Recent record: the bicycle was repaired near the river.' },
        ], 'lexical-only', project);

        const lexical = await client.search('observatory calibrated violet', {
          project,
          limit: 5,
          retrievalMode: 'lexical',
        });
        expect(lexical.map(result => result.memory.content)).toEqual([
          'Historical record: the observatory calibrated a violet telescope.',
        ]);
        expect(lexical[0]?.semanticScore).toBeUndefined();

        const noLexicalMatch = await client.search('quasar invoice', {
          project,
          limit: 5,
          retrievalMode: 'lexical',
        });
        expect(noLexicalMatch).toEqual([]);

        const hybridNoLexicalMatch = await client.search('quasar invoice', {
          project,
          limit: 5,
          retrievalMode: 'hybrid',
        });
        expect(hybridNoLexicalMatch.length).toBeGreaterThan(0);
      });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('seeds persona sessions once into isolated projects and searches only that persona', async () => {
    const previousLlmEnabled = process.env.SQUISH_LLM_ENABLED;
    process.env.SQUISH_LLM_ENABLED = 'false';

    try {
      await withIsolatedBenchmarkDatabase(async dataDir => {
        const client = new SquishRuntime({ graphAutoBuild: false, consolidationEnabled: false });
        const alphaProject = join(dataDir, 'personas', 'alpha');
        const betaProject = join(dataDir, 'personas', 'beta');
        mkdirSync(alphaProject, { recursive: true });
        mkdirSync(betaProject, { recursive: true });

        await seedPersona(client, [{
          session: 1,
          date: '2026-01-01',
          text: 'Alpha persona remembers the cobalt telescope calibration.',
        }], 'alpha', alphaProject);
        await seedPersona(client, [{
          session: 1,
          date: '2026-01-02',
          text: 'Beta persona remembers the saffron bicycle restoration.',
        }], 'beta', betaProject);

        const alphaContext = await retrievePersonaContext(client, 'What did alpha calibrate?', alphaProject);
        const betaContext = await retrievePersonaContext(client, 'What did beta restore?', betaProject);
        expect(alphaContext.join('\n')).toContain('cobalt telescope calibration');
        expect(alphaContext.join('\n')).not.toContain('saffron bicycle restoration');
        expect(betaContext.join('\n')).toContain('saffron bicycle restoration');
        expect(betaContext.join('\n')).not.toContain('cobalt telescope calibration');
      });
    } finally {
      if (previousLlmEnabled === undefined) delete process.env.SQUISH_LLM_ENABLED;
      else process.env.SQUISH_LLM_ENABLED = previousLlmEnabled;
    }
  });

  test('maps multiple dialogue evidence IDs to unique sessions and preserves unmapped labels', () => {
    expect(parseEvidenceSessions(['D8:6; D9:17', 'D9:1 D4:4 D4:6', 'D', 'D:11:26'])).toEqual({
      sessions: [4, 8, 9],
      unmapped: ['D', 'D:11:26'],
    });
    expect(resolveEvidenceSessions(['D8:6; D9:17'], new Set([8]))).toEqual({
      sessions: [8],
      unmapped: [],
      missingSessions: [9],
      complete: false,
      exclusionReason: 'referenced_session_not_seeded',
    });
    expect(resolveEvidenceSessions([], new Set())).toMatchObject({
      complete: false,
      exclusionReason: 'empty_evidence_label',
    });
  });

  test('parses LoCoMo session timestamps as timezone-stable UTC dates', () => {
    expect(parseLoCoMoSessionDate('1:56 pm on 8 May, 2023')?.toISOString()).toBe('2023-05-08T13:56:00.000Z');
    expect(parseLoCoMoSessionDate('12:05 am on 1 January, 2024')?.toISOString()).toBe('2024-01-01T00:05:00.000Z');
    expect(parseLoCoMoSessionDate('13:05 pm on 1 January, 2024')).toBeNull();
  });

  test('freezes Date.now at the protocol clock only during retrieval work and restores it', async () => {
    const originalNow = Date.now;
    const inside = await withLoCoMoEvaluationClock(async () => Date.now());
    expect(inside).toBe(Date.parse(LOCOMO_EVALUATION_TIME));
    expect(Date.now).toBe(originalNow);
  });

  test('returns retrieved session IDs through the seeded memory identity map', async () => {
    const previousLlmEnabled = process.env.SQUISH_LLM_ENABLED;
    const previousEmbeddingProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    process.env.SQUISH_LLM_ENABLED = 'false';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
    try {
      await withIsolatedBenchmarkDatabase(async dataDir => {
        const client = new SquishRuntime({ graphAutoBuild: false, consolidationEnabled: false });
        const project = join(dataDir, 'personas', 'mapped');
        mkdirSync(project, { recursive: true });
        const map = await seedPersona(client, [{
          session: 7,
          date: '1:56 pm on 8 May, 2023',
          text: 'The observatory calibrated its violet telescope on Tuesday.',
        }], 'mapped', project, { useSessionDateAsCreatedAt: true });
        const results = await retrievePersonaSessions(client, 'What did the observatory calibrate?', project, map, 5);
        const retrieved = results.find(result => result.session === 7);
        expect(retrieved).toBeDefined();
        expect(retrieved?.memoryId).toBeTruthy();
        expect(retrieved?.contentSha256).toBe('66426ffdecbe51f1c55c8abfd99dbc1aa4af4388b8f6312b60606038b5c4ef59');
        expect(retrieved?.scoreBreakdown).toBeDefined();
        expect(retrieved?.semanticScore).not.toBeNull();
        const { db, schema } = await getDbClient();
        const rows = await db.select({ createdAt: schema.memories.createdAt })
          .from(schema.memories)
          .where(eq(schema.memories.id, retrieved!.memoryId));
        expect(rows[0]?.createdAt.toISOString()).toBe('2023-05-08T13:56:00.000Z');
      });
    } finally {
      if (previousLlmEnabled === undefined) delete process.env.SQUISH_LLM_ENABLED;
      else process.env.SQUISH_LLM_ENABLED = previousLlmEnabled;
      if (previousEmbeddingProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousEmbeddingProvider;
    }
  });

  test('persists source session dates in one transaction while preserving each timestamp', async () => {
    const previous = new Map<string, string | undefined>([
      ['SQUISH_LLM_ENABLED', process.env.SQUISH_LLM_ENABLED],
      ['SQUISH_EMBEDDINGS_PROVIDER', process.env.SQUISH_EMBEDDINGS_PROVIDER],
    ]);
    process.env.SQUISH_LLM_ENABLED = 'false';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
    try {
      await withIsolatedBenchmarkDatabase(async dataDir => {
        const client = new SquishRuntime({ graphAutoBuild: false, consolidationEnabled: false });
        const project = join(dataDir, 'personas', 'date-batch');
        mkdirSync(project, { recursive: true });
        const sessions = [
          { session: 3, date: '1:56 pm on 8 May, 2023', text: 'The observatory calibrated a violet telescope.' },
          { session: 4, date: '12:05 am on 1 January, 2024', text: 'The bicycle was repaired beside the river.' },
        ];
        const ids = await seedPersona(client, sessions, 'date-batch', project);
        const dbClient = await getDbClient();
        const raw = dbClient.db.$client as { exec: (sql: string) => unknown };
        const originalExec = raw.exec;
        const transactionStatements: string[] = [];
        raw.exec = function (sql: string) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') transactionStatements.push(sql);
          return originalExec.call(this, sql);
        };
        try {
          await persistSessionCreatedAtBatch(dbClient, sessions.map(session => ({
            memoryId: [...ids].find(([, value]) => value === session.session)![0],
            createdAt: parseLoCoMoSessionDate(session.date)!,
          })));
        } finally {
          raw.exec = originalExec;
        }

        expect(transactionStatements).toEqual(['BEGIN', 'COMMIT']);
        const { db, schema } = dbClient;
        for (const session of sessions) {
          const memoryId = [...ids].find(([, value]) => value === session.session)![0];
          const rows = await db.select({ createdAt: schema.memories.createdAt })
            .from(schema.memories)
            .where(eq(schema.memories.id, memoryId));
          expect(rows[0]?.createdAt.toISOString()).toBe(parseLoCoMoSessionDate(session.date)?.toISOString());
        }
      });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
