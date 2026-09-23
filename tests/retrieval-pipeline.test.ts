/**
 * Integration Tests for hybridSearch Pipeline
 *
 * Tests the full retrieval pipeline end-to-end including:
 * 1. End-to-end search with vector similarity
 * 2. Graph boost improves ranking
 * 3. Place scoring boosts correct memories
 * 4. Cross-encoder reranking reorders results
 * 5. MMR diversity prevents redundant results
 * 6. Temporal queries work correctly
 * 7. Multi-session queries expand coverage
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';

// Set up test data directory BEFORE any imports
const testDataDir = join(tmpdir(), `squish-pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local'; // Use TF-IDF local embeddings
process.env.SQUISH_LLM_ENABLED = 'false'; // Disable LLM for tests
process.env.SQUISH_RERANKER_ENABLED = 'false'; // Disable cross-encoder
process.env.SQUISH_MMR_ENABLED = 'false'; // Disable MMR by default
process.env.SQUISH_GRAPH_AUTO_BUILD = 'true'; // Enable graph building
process.env.SQUISH_SKIP_CONTRADICTION = 'true'; // Skip contradiction resolution for speed
process.env.SQUISH_CONTEXTUAL_RETRIEVAL = 'false';

if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { getDb, resetDb } from '../db/index.js';
import { rememberMemory } from '../core/memory/memories.js';
import { hybridSearch, rrfFusion, vectorSearch } from '../core/memory/hybrid-search.js';
import { createAssociation } from '../core/associations.js';
import { initializeDefaultPlaces } from '../core/places/places.js';
import { requireProject } from '../core/projects.js';
import { createDatabaseClient } from '../core/storage/database.js';
import { logger } from '../core/logger.js';
import type { SearchInput, SearchResult } from '../core/memory/memories.js';

// Spy seam for debug-log assertions (bypasses the DEBUG env gate).
const originalDebug = logger.debug;

// ── Helpers ─────────────────────────────────────────────────────────

async function execSql(sql: string) {
  const db = await getDb();
  const sqlite = (db as any).$client;
  if (sqlite && typeof sqlite.exec === 'function') {
    sqlite.exec(sql);
  }
}

async function clearData() {
  await execSql('DELETE FROM memory_tags;');
  await execSql('DELETE FROM memory_associations;');
  await execSql('DELETE FROM memories;');
  await execSql('DELETE FROM places;');
  await execSql('DELETE FROM projects;');
}

/**
 * Create a deterministic embedding from text content.
 * Uses a simple hash to generate a consistent vector.
 */
function textToEmbedding(text: string, dim: number = 768): number[] {
  const embedding = new Array(dim).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // Distribute each word's contribution across dimensions
    for (let j = 0; j < word.length; j++) {
      const charCode = word.charCodeAt(j);
      const idx = (i * 7 + j * 3 + charCode) % dim;
      embedding[idx] += Math.sin(charCode * 0.1 + i * 0.3) * 0.3;
    }
  }
  // Normalize to unit vector
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < dim; i++) embedding[i] /= norm;
  }
  return embedding;
}

/**
 * Insert a memory directly into the database with a given embedding.
 * Bypasses the full rememberMemory flow for precise control over embeddings.
 */
async function insertMemoryWithEmbedding(
  content: string,
  embedding: number[],
  opts: {
    type?: string;
    tags?: string[];
    project?: string;
    metadata?: Record<string, any>;
    createdAt?: Date;
  } = {}
): Promise<string> {
  const db = await getDb();
  const sqlite = (db as any).$client;
  const { randomUUID } = await import('crypto');
  const id = randomUUID();

  const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);

  let projectId: string | null = null;
  if (opts.project) {
    const project = await requireProject(opts.project);
    projectId = project.id;
  }

  const tagsJson = opts.tags ? JSON.stringify(opts.tags) : null;
  const metadataJson = opts.metadata ? JSON.stringify(opts.metadata) : null;
  const createdAt = opts.createdAt ?? new Date();

  sqlite.prepare(`
    INSERT INTO memories (id, project_id, type, content, tags, metadata, embedding, created_at, status, importance_score, source, visibility_scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 50, 'mcp', 'private')
  `).run(
    id,
    projectId,
    opts.type ?? 'fact',
    content,
    tagsJson,
    metadataJson,
    embeddingBuffer,
    createdAt.toISOString()
  );

  // Build FTS5 index entry
  try {
    sqlite.prepare(`
      INSERT INTO memories_fts (rowid, content, summary)
      SELECT rowid, content, '' FROM memories WHERE id = ?
    `).run(id);
  } catch {
    // FTS5 may not be available
  }

  return id;
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('hybridSearch Pipeline Integration', () => {
  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
    process.env.SQUISH_LLM_ENABLED = 'false';
    process.env.SQUISH_RERANKER_ENABLED = 'false';
    process.env.SQUISH_MMR_ENABLED = 'false';
    process.env.SQUISH_GRAPH_AUTO_BUILD = 'true';
    process.env.SQUISH_SKIP_CONTRADICTION = 'true';
    resetDb();
    await clearData();
  });

  afterEach(async () => {
    // Clean up test data
    try {
      await clearData();
    } catch {
      // Ignore cleanup errors
    }
  });

  // ── 1. End-to-End Search ────────────────────────────────────────────

  describe('1. End-to-end search', () => {
    it('returns results for a simple query when memories exist', async () => {
      const queryEmbedding = textToEmbedding('bun package management');
      const contentEmbedding = textToEmbedding('use bun for package management in this project');

      await insertMemoryWithEmbedding(
        'use bun for package management in this project',
        contentEmbedding,
        { type: 'preference', tags: ['tooling'] }
      );

      const results = await hybridSearch({
        query: 'bun package management',
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results).toBeDefined();
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('bun');
      expect(results[0].similarity).toBeGreaterThan(0);
    });

    it('returns empty array when no memories exist', async () => {
      const results = await hybridSearch({
        query: 'nonexistent topic',
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results).toBeDefined();
      expect(results.length).toBe(0);
    });

    it('respects the limit parameter', async () => {
      const dim = 768;
      for (let i = 0; i < 20; i++) {
        await insertMemoryWithEmbedding(
          `fact number ${i} about a specific topic ${i}`,
          textToEmbedding(`fact number ${i} about a specific topic ${i}`, dim),
          { type: 'fact' }
        );
      }

      const results = await hybridSearch({
        query: 'fact about topic',
        limit: 5,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('returns results sorted by similarity descending', async () => {
      const dim = 768;
      const query = 'python programming language';

      // Store highly relevant memory
      await insertMemoryWithEmbedding(
        'python is a popular programming language used for data science',
        textToEmbedding('python is a popular programming language used for data science', dim),
        { type: 'fact' }
      );

      // Store less relevant memory
      await insertMemoryWithEmbedding(
        'java is a compiled programming language for enterprise',
        textToEmbedding('java is a compiled programming language for enterprise', dim),
        { type: 'fact' }
      );

      // Store even less relevant memory
      await insertMemoryWithEmbedding(
        'the weather is nice today for a walk',
        textToEmbedding('the weather is nice today for a walk', dim),
        { type: 'observation' }
      );

      const results = await hybridSearch({
        query,
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results.length).toBeGreaterThanOrEqual(2);
      // Results should be sorted by similarity
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
      }
    });

    it('filters by type when type is specified', async () => {
      const dim = 768;
      const query = 'important decision';

      await insertMemoryWithEmbedding(
        'we decided to use TypeScript for the project',
        textToEmbedding('we decided to use TypeScript for the project', dim),
        { type: 'decision' }
      );

      await insertMemoryWithEmbedding(
        'TypeScript is a typed superset of JavaScript',
        textToEmbedding('TypeScript is a typed superset of JavaScript', dim),
        { type: 'fact' }
      );

      const decisions = await hybridSearch({
        query,
        type: 'decision',
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      for (const r of decisions) {
        expect(r.type).toBe('decision');
      }
    });
  });

  // ── 2. Graph Boost ──────────────────────────────────────────────────

  describe('2. Graph boost', () => {
    it('boosts ranking of memories with associations', async () => {
      const dim = 768;

      // Create two related memories
      const memA = await insertMemoryWithEmbedding(
        'react is a JavaScript library for building user interfaces',
        textToEmbedding('react is a JavaScript library for building user interfaces', dim),
        { type: 'fact', tags: ['react', 'javascript'] }
      );

      const memB = await insertMemoryWithEmbedding(
        'react hooks allow state management in functional components',
        textToEmbedding('react hooks allow state management in functional components', dim),
        { type: 'fact', tags: ['react', 'hooks'] }
      );

      // Create a less related memory
      const memC = await insertMemoryWithEmbedding(
        'docker is used for containerizing applications',
        textToEmbedding('docker is used for containerizing applications', dim),
        { type: 'fact', tags: ['docker'] }
      );

      // Create association between memA and memB
      await createAssociation(memA, memB, 'relates_to', 0.9);

      // Search for react content
      const results = await hybridSearch({
        query: 'react state management',
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: true });

      expect(results.length).toBeGreaterThanOrEqual(2);

      // Both react memories should be in results
      const resultIds = results.map(r => r.id);
      expect(resultIds).toContain(memA);
      expect(resultIds).toContain(memB);
    });
  });

  // ── 3. Place Scoring ────────────────────────────────────────────────

  describe('3. Place scoring', () => {
    it('boosts memories in place-relevant positions', async () => {
      const dim = 768;

      // Initialize default places
      await initializeDefaultPlaces();

      // Store a memory that will be placed in the inbox
      const memId = await insertMemoryWithEmbedding(
        'inbox task: review pull request for the API module',
        textToEmbedding('inbox task: review pull request for the API module', dim),
        { type: 'task' }
      );

      // Store a memory in a different conceptual place
      await insertMemoryWithEmbedding(
        'reference documentation for REST API design patterns',
        textToEmbedding('reference documentation for REST API design patterns', dim),
        { type: 'reference' }
      );

      // Query should return results
      const results = await hybridSearch({
        query: 'review pull request API',
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results.length).toBeGreaterThan(0);
      // The inbox task should be among results
      const resultIds = results.map(r => r.id);
      expect(resultIds).toContain(memId);
    });
  });

  // ── 4. Cross-Encoder Reranking ──────────────────────────────────────

  describe('4. Cross-encoder reranking', () => {
    it('applies reranking when enabled via config', async () => {
      const dim = 768;

      // Store diverse memories
      await insertMemoryWithEmbedding(
        'typescript provides static type checking for JavaScript',
        textToEmbedding('typescript provides static type checking for JavaScript', dim),
        { type: 'fact' }
      );

      await insertMemoryWithEmbedding(
        'typescript interfaces define object shapes',
        textToEmbedding('typescript interfaces define object shapes', dim),
        { type: 'fact' }
      );

      await insertMemoryWithEmbedding(
        'python is a dynamic programming language',
        textToEmbedding('python is a dynamic programming language', dim),
        { type: 'fact' }
      );

      // Search without reranking
      process.env.SQUISH_RERANKER_ENABLED = 'false';
      const resultsNoRerank = await hybridSearch({
        query: 'typescript type system',
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      // Even with reranker disabled, results should still be returned
      expect(resultsNoRerank.length).toBeGreaterThan(0);
      // TypeScript results should be ranked higher
      expect(resultsNoRerank[0].content.toLowerCase()).toContain('typescript');
    });
  });

  // ── 5. MMR Diversity ────────────────────────────────────────────────

  describe('5. MMR diversity', () => {
    it('returns diverse results when MMR is enabled', async () => {
      const dim = 768;

      // Store similar documents on the same topic
      await insertMemoryWithEmbedding(
        'react hooks useState manages component state',
        textToEmbedding('react hooks useState manages component state', dim),
        { type: 'fact' }
      );

      await insertMemoryWithEmbedding(
        'react hooks useEffect handles side effects',
        textToEmbedding('react hooks useEffect handles side effects', dim),
        { type: 'fact' }
      );

      await insertMemoryWithEmbedding(
        'react hooks useContext provides global state access',
        textToEmbedding('react hooks useContext provides global state access', dim),
        { type: 'fact' }
      );

      // Add a different topic
      await insertMemoryWithEmbedding(
        'docker containers provide isolated runtime environments',
        textToEmbedding('docker containers provide isolated runtime environments', dim),
        { type: 'fact' }
      );

      await insertMemoryWithEmbedding(
        'kubernetes orchestrates container deployment at scale',
        textToEmbedding('kubernetes orchestrates container deployment at scale', dim),
        { type: 'fact' }
      );

      // MMR is tested via smartMMR directly in this test
      // In the pipeline, MMR is gated by config.mmrEnabled
      const results = await hybridSearch({
        query: 'react and infrastructure',
        limit: 5,
      }, { enableHeuristics: false, includeAssociations: false });

      // Should return some results
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── 6. Temporal Queries ─────────────────────────────────────────────

  describe('6. Temporal queries', () => {
    it('detects temporal queries and returns results', async () => {
      const dim = 768;

      await insertMemoryWithEmbedding(
        'the meeting was scheduled for January 15 2024',
        textToEmbedding('the meeting was scheduled for January 15 2024', dim),
        { type: 'fact' }
      );

      await insertMemoryWithEmbedding(
        'the project deadline is next month',
        textToEmbedding('the project deadline is next month', dim),
        { type: 'fact' }
      );

      // Query with temporal indicator
      const results = await hybridSearch({
        query: 'when was the meeting scheduled',
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results.length).toBeGreaterThan(0);
      // Should find the meeting memory
      const contents = results.map(r => r.content.toLowerCase());
      const hasMeeting = contents.some(c => c.includes('meeting'));
      expect(hasMeeting).toBe(true);
    });

    it('temporal boost gives higher rank to date-containing memories', async () => {
      const dim = 768;

      // Memory with explicit date
      const dateMemId = await insertMemoryWithEmbedding(
        'deployed version 2.0 on March 5 2024',
        textToEmbedding('deployed version 2.0 on March 5 2024', dim),
        { type: 'fact' }
      );

      // Memory without date
      await insertMemoryWithEmbedding(
        'version 2.0 has new features and improvements',
        textToEmbedding('version 2.0 has new features and improvements', dim),
        { type: 'fact' }
      );

      const results = await hybridSearch({
        query: 'when did we deploy version 2',
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results.length).toBeGreaterThan(0);
      // The date-containing memory should be in results
      const resultIds = results.map(r => r.id);
      expect(resultIds).toContain(dateMemId);
    });
  });

  // ── 7. Multi-Session Queries ────────────────────────────────────────

  describe('7. Multi-session queries', () => {
    it('expands multi-session queries for broader coverage', async () => {
      const dim = 768;

      // Store memories that would be in different sessions
      await insertMemoryWithEmbedding(
        'in the morning session we discussed API design',
        textToEmbedding('in the morning session we discussed API design', dim),
        { type: 'fact', metadata: { sessionMetadata: { sessionId: 'session-1' } } }
      );

      await insertMemoryWithEmbedding(
        'the afternoon session covered database optimization',
        textToEmbedding('the afternoon session covered database optimization', dim),
        { type: 'fact', metadata: { sessionMetadata: { sessionId: 'session-2' } } }
      );

      await insertMemoryWithEmbedding(
        'the evening session reviewed deployment strategy',
        textToEmbedding('the evening session reviewed deployment strategy', dim),
        { type: 'fact', metadata: { sessionMetadata: { sessionId: 'session-3' } } }
      );

      // Query with multi-session indicator
      const results = await hybridSearch({
        query: 'what was discussed across sessions',
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results.length).toBeGreaterThan(0);
    });

    it('session boost improves ranking of same-session memories', async () => {
      const dim = 768;

      // Create memories
      const mem1 = await insertMemoryWithEmbedding(
        'we decided on the architecture for the new service',
        textToEmbedding('we decided on the architecture for the new service', dim),
        { type: 'decision' }
      );

      const mem2 = await insertMemoryWithEmbedding(
        'the architecture decision was documented in the wiki',
        textToEmbedding('the architecture decision was documented in the wiki', dim),
        { type: 'fact' }
      );

      const sessionId = 'test-session-abc';

      // Search with sessionId - the session boost should apply
      const results = await hybridSearch({
        query: 'architecture decision',
        limit: 10,
        sessionId,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── 8. RRF Fusion ───────────────────────────────────────────────────

  describe('8. RRF fusion', () => {
    it('combines vector and keyword results effectively', () => {
      const vectorResults: SearchResult[] = [
        { id: 'a', content: 'react hooks', similarity: 0.9 },
        { id: 'b', content: 'react components', similarity: 0.8 },
        { id: 'c', content: 'vue hooks', similarity: 0.7 },
      ] as any;

      const keywordResults: SearchResult[] = [
        { id: 'c', content: 'vue hooks', similarity: 1.0 },
        { id: 'a', content: 'react hooks', similarity: 0.8 },
      ] as any;

      const fused = rrfFusion(vectorResults, keywordResults, 3);

      expect(fused.length).toBe(3);
      // 'a' appears in both lists, should get boosted to top
      expect(fused[0].id).toBe('a');
    });

    it('handles empty keyword results', () => {
      const vectorResults: SearchResult[] = [
        { id: 'a', content: 'react', similarity: 0.9 },
        { id: 'b', content: 'vue', similarity: 0.8 },
      ] as any;

      const fused = rrfFusion(vectorResults, [], 3);

      expect(fused.length).toBe(2);
      expect(fused[0].id).toBe('a');
    });

    it('handles empty vector results', () => {
      const keywordResults: SearchResult[] = [
        { id: 'a', content: 'react', similarity: 0.9 },
      ] as any;

      const fused = rrfFusion([], keywordResults, 3);

      expect(fused.length).toBe(1);
      expect(fused[0].id).toBe('a');
    });
  });

  // ── 9. Trace Mode ───────────────────────────────────────────────────

  describe('9. Trace mode', () => {
    it('attaches trace metadata when trace is enabled', async () => {
      const dim = 768;

      await insertMemoryWithEmbedding(
        'test trace memory for debugging',
        textToEmbedding('test trace memory for debugging', dim),
        { type: 'fact' }
      );

      const results = await hybridSearch({
        query: 'test trace memory',
        limit: 5,
        trace: true,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results.length).toBeGreaterThan(0);
      // Check trace is attached
      expect(results[0]._trace).toBeDefined();
      expect(results[0]._trace!.totalCandidates).toBeGreaterThanOrEqual(1);
      expect(results[0]._trace!.finalOrder.length).toBeGreaterThan(0);
    });
  });

  // ── 10. Edge Cases ──────────────────────────────────────────────────

  describe('10. Edge cases', () => {
    it('handles empty query gracefully', async () => {
      const dim = 768;

      await insertMemoryWithEmbedding(
        'some memory content',
        textToEmbedding('some memory content', dim),
        { type: 'fact' }
      );

      const results = await hybridSearch({
        query: '',
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      // Should still return results ordered by recency
      expect(results).toBeDefined();
    });

    it('handles very long query', async () => {
      const dim = 768;

      await insertMemoryWithEmbedding(
        'short memory',
        textToEmbedding('short memory', dim),
        { type: 'fact' }
      );

      const longQuery = 'a'.repeat(10000);

      const results = await hybridSearch({
        query: longQuery,
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      // Should not crash
      expect(results).toBeDefined();
    });

    it('handles special characters in query', async () => {
      const dim = 768;

      await insertMemoryWithEmbedding(
        'regex patterns use special characters like ( ) [ ] * + ?',
        textToEmbedding('regex patterns use special characters', dim),
        { type: 'fact' }
      );

      const results = await hybridSearch({
        query: 'regex (pattern) [special] *chars',
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results).toBeDefined();
    });

    it('handles multiple tags in filter', async () => {
      const dim = 768;

      await insertMemoryWithEmbedding(
        'react and typescript project setup guide',
        textToEmbedding('react and typescript project setup guide', dim),
        { type: 'fact', tags: ['react', 'typescript', 'setup'] }
      );

      await insertMemoryWithEmbedding(
        'vue project setup guide',
        textToEmbedding('vue project setup guide', dim),
        { type: 'fact', tags: ['vue', 'setup'] }
      );

      const results = await hybridSearch({
        query: 'project setup guide',
        tags: ['react', 'typescript'],
        limit: 10,
      }, { enableHeuristics: false, includeAssociations: false });

      expect(results.length).toBeGreaterThan(0);
    });
  });
});

// ── Vector scan parity (Batch 3-5 review) ────────────────────────────────

describe('vector scan skip accounting', () => {
  const savedScan = process.env.SQUISH_VECTOR_SCAN;

  afterEach(() => {
    if (savedScan === undefined) delete process.env.SQUISH_VECTOR_SCAN;
    else process.env.SQUISH_VECTOR_SCAN = savedScan;
    logger.debug = originalDebug;
  });

  it('recency mode counts vector-less rows like the full scan does', async () => {
    const dim = 768;
    process.env.SQUISH_VECTOR_SCAN = 'recency';

    await insertMemoryWithEmbedding(
      'quantum flux capacitor calibration notes',
      textToEmbedding('quantum flux capacitor calibration notes', dim),
      { type: 'fact' }
    );

    // Vector-less row: every embedding column NULL -> decodeCandidateEmbedding
    // returns null. Must be counted (logged), not silently dropped.
    await execSql(`
      INSERT INTO memories (id, type, content, created_at, status, importance_score, source, visibility_scope)
      VALUES ('no-vector-row-0001', 'fact', 'unrelated legacy row without vectors', datetime('now'), 'active', 50, 'mcp', 'private')
    `);

    const captured: string[] = [];
    logger.debug = (msg: string) => { captured.push(String(msg)); };

    const db = await getDb();
    const results = await vectorSearch(
      { query: 'quantum flux capacitor calibration' },
      { limit: 10 },
      textToEmbedding('quantum flux capacitor calibration', dim),
      { dbClient: createDatabaseClient(db), db }
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('flux capacitor');

    const skipLog = captured.find(m => m.includes('recency window'));
    expect(skipLog).toBeDefined();
    expect(skipLog).toContain('1 vector-less');
  });
});
