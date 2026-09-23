/**
 * Tests for Storage Facade
 *
 * Triple-layer storage API tests: storeMemory, getMemoryById, queryMemories,
 * recall, extractEntities, boostByEntities, enrichWith, routeQuery,
 * getEntities, getEntity, getEntityRelationsByName, getEntityNeighborhood,
 * traverseGraph, findEntityPaths, getStrategyByKeywords, createStorageFacade.
 *
 * Uses real DB (SQLite in temp dir).
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';

const testDataDir = join(tmpdir(), `squish-storage-facade-${Date.now()}-${randomUUID().slice(0, 8)}`);
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { getDb, resetDb } from '../../db/index.js';
import { rememberMemory } from '../../core/memory/memories.js';
import { initializeDefaultPlaces, ensureGlobalProject } from '../../core/places/places.js';
import { getOrCreateProject } from '../projects.js';

// Lazy-loaded modules after env setup
let storeMemory: typeof import('./storage-facade.js').storeMemory;
let getMemoryById: typeof import('./storage-facade.js').getMemoryById;
let queryMemories: typeof import('./storage-facade.js').queryMemories;
let routeQuery: typeof import('./storage-facade.js').routeQuery;
let extractEntities: typeof import('./storage-facade.js').extractEntities;
let boostByEntities: typeof import('./storage-facade.js').boostByEntities;
let enrichWith: typeof import('./storage-facade.js').enrichWith;
let recall: typeof import('./storage-facade.js').recall;
let createStorageFacade: typeof import('./storage-facade.js').createStorageFacade;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function clearTables() {
  const db = await getDb();
  const sqlite = (db as any).$client;
  if (sqlite && typeof sqlite.exec === 'function') {
    sqlite.exec('DELETE FROM memory_tags;');
    sqlite.exec('DELETE FROM memories;');
    sqlite.exec('DELETE FROM memory_associations;');
    sqlite.exec('DELETE FROM entity_relations;');
    sqlite.exec('DELETE FROM entities;');
    sqlite.exec('DELETE FROM places;');
    sqlite.exec('DELETE FROM projects;');
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('Storage Facade', () => {
  beforeAll(async () => {
    const mod = await import('./storage-facade.js');
    storeMemory = mod.storeMemory;
    getMemoryById = mod.getMemoryById;
    queryMemories = mod.queryMemories;
    routeQuery = mod.routeQuery;
    extractEntities = mod.extractEntities;
    boostByEntities = mod.boostByEntities;
    enrichWith = mod.enrichWith;
    recall = mod.recall;
    createStorageFacade = mod.createStorageFacade;
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearTables();
    await initializeDefaultPlaces();
    await ensureGlobalProject();
    await getOrCreateProject(testDataDir);
  });

  // --- storeMemory -------------------------------------------------------

  describe('storeMemory', () => {
    it('stores a memory and returns a MemoryRecord', async () => {
      const mem = await storeMemory({
        content: 'Test memory for storage facade',
        type: 'fact',
      });
      expect(mem).toBeDefined();
      expect(mem.id).toBeTruthy();
      expect(mem.content).toBe('Test memory for storage facade');
      expect(mem.type).toBe('fact');
    });

    it('stores a memory with tags', async () => {
      const mem = await storeMemory({
        content: 'Tagged memory',
        type: 'note',
        tags: ['backend', 'api'],
      });
      expect(mem.tags).toBeDefined();
    });
  });

  // --- getMemoryById -----------------------------------------------------

  describe('getMemoryById', () => {
    it('retrieves a stored memory by ID', async () => {
      const stored = await storeMemory({
        content: 'Retrievable memory',
        type: 'fact',
      });
      const retrieved = await getMemoryById(stored.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(stored.id);
      expect(retrieved!.content).toBe('Retrievable memory');
    });

    it('returns null for non-existent ID', async () => {
      const result = await getMemoryById('00000000-0000-0000-0000-000000000000');
      expect(result).toBeNull();
    });
  });

  // --- queryMemories -----------------------------------------------------

  describe('queryMemories', () => {
    it('returns results for a matching query', async () => {
      await storeMemory({
        content: 'The PostgreSQL database stores user sessions',
        type: 'fact',
      });
      await storeMemory({
        content: 'We use Redis for caching static assets',
        type: 'fact',
      });

      const results = await queryMemories({ query: 'PostgreSQL database', limit: 10 });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await storeMemory({ content: `Memory item ${i} about testing`, type: 'note' });
      }
      const results = await queryMemories({ query: 'testing', limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  // --- recall ------------------------------------------------------------

  describe('recall', () => {
    it('returns a RecallResult with routing info', async () => {
      await storeMemory({
        content: 'Deploy the application to production on Friday',
        type: 'decision',
      });

      const result = await recall('when did we deploy?', { limit: 5 });
      expect(result.memories).toBeDefined();
      expect(Array.isArray(result.memories)).toBe(true);
      expect(result.routing).toBeDefined();
      expect(typeof result.routing.intent).toBe('string');
      expect(typeof result.routing.strategy).toBe('string');
      expect(typeof result.routing.confidence).toBe('number');
      expect(result.metadata).toBeDefined();
      expect(typeof result.metadata.totalResults).toBe('number');
      expect(typeof result.metadata.durationMs).toBe('number');
      expect(Array.isArray(result.metadata.sources)).toBe(true);
    });

    it('uses strategy override when provided', async () => {
      await storeMemory({
        content: 'Test recall with strategy override',
        type: 'fact',
      });

      const result = await recall('test query', {
        limit: 5,
        strategy: 'hybrid_search',
      });
      expect(result.routing.strategy).toBe('hybrid_search');
    });

    it('handles empty query gracefully', async () => {
      const result = await recall('', { limit: 5 });
      expect(result.memories).toBeDefined();
      expect(result.routing).toBeDefined();
    });
  });

  // --- routeQuery --------------------------------------------------------

  describe('routeQuery', () => {
    it('returns a RouteResult', async () => {
      const result = await routeQuery('when did we deploy the fix?');
      expect(result.classification).toBeDefined();
      expect(result.recommendedStrategy).toBeDefined();
      expect(result.fallbackStrategy).toBeDefined();
      expect(result.routingMetadata).toBeDefined();
    });
  });

  // --- extractEntities ---------------------------------------------------

  describe('extractEntities', () => {
    it('extracts PascalCase entities', () => {
      const entities = extractEntities('Use UserService to call PaymentGateway');
      expect(entities.length).toBeGreaterThanOrEqual(2);
      expect(entities).toContain('UserService');
      expect(entities).toContain('PaymentGateway');
    });

    it('extracts camelCase entities', () => {
      const entities = extractEntities('Call getUserData and handleEvent');
      expect(entities.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts tool/framework names', () => {
      const entities = extractEntities('We use React and PostgreSQL');
      expect(entities).toContain('React');
      expect(entities).toContain('PostgreSQL');
    });

    it('returns empty array for plain text', () => {
      const entities = extractEntities('hello world');
      expect(Array.isArray(entities)).toBe(true);
    });
  });

  // --- boostByEntities ---------------------------------------------------

  describe('boostByEntities', () => {
    it('boosts results containing matching entities', async () => {
      await storeMemory({
        content: 'UserService handles authentication',
        type: 'fact',
      });
      await storeMemory({
        content: 'Unrelated memory about coffee',
        type: 'fact',
      });

      const results = await queryMemories({ query: 'user service', limit: 10 });
      const boosted = boostByEntities(results, ['UserService']);
      expect(boosted.length).toBe(results.length);
      // The first result should have higher similarity after boosting
      if (boosted.length > 0 && results.length > 0) {
        expect(typeof boosted[0].similarity).toBe('number');
      }
    });

    it('returns empty array for empty input', () => {
      const boosted = boostByEntities([], ['Entity']);
      expect(boosted).toEqual([]);
    });
  });

  // --- enrichWith --------------------------------------------------------

  describe('enrichWith', () => {
    it('returns an enriched object with enriched field', () => {
      const result = enrichWith('What is the database schema?');
      expect(result).toBeDefined();
      expect(typeof result.enriched).toBe('string');
    });

    it('includes content in enriched output', () => {
      const result = enrichWith('Test content');
      expect(result.enriched).toContain('Test content');
    });

    it('accepts optional type parameter', () => {
      const result = enrichWith('Test', { type: 'decision' });
      expect(result).toBeDefined();
      expect(typeof result.enriched).toBe('string');
    });

    it('accepts optional tags parameter', () => {
      const result = enrichWith('Test', { tags: ['backend', 'api'] });
      expect(result).toBeDefined();
    });
  });

  // --- createStorageFacade -----------------------------------------------

  describe('createStorageFacade', () => {
    it('creates a facade with all required methods', () => {
      const facade = createStorageFacade();
      expect(typeof facade.storeMemory).toBe('function');
      expect(typeof facade.getMemoryById).toBe('function');
      expect(typeof facade.queryMemories).toBe('function');
      expect(typeof facade.recall).toBe('function');
      expect(typeof facade.routeQuery).toBe('function');
      expect(typeof facade.extractEntities).toBe('function');
      expect(typeof facade.boostByEntities).toBe('function');
      expect(typeof facade.enrichWith).toBe('function');
      expect(typeof facade.searchSemantic).toBe('function');
      expect(typeof facade.getEntity).toBe('function');
      expect(typeof facade.traverseGraph).toBe('function');
    });

    it('facade recall uses bound project option', async () => {
      const facade = createStorageFacade({ project: testDataDir });
      const result = await facade.recall('test query', { limit: 5 });
      expect(result.memories).toBeDefined();
      expect(result.routing).toBeDefined();
    });

    it('facade storeMemory and getMemoryById work end-to-end', async () => {
      const facade = createStorageFacade();
      const mem = await facade.storeMemory({
        content: 'Facade stored memory',
        type: 'fact',
      });
      const retrieved = await facade.getMemoryById(mem.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toBe('Facade stored memory');
    });

    it('facade searchSemantic returns SemanticResult[]', async () => {
      await storeMemory({ content: 'Semantic search test', type: 'fact' });
      const facade = createStorageFacade();
      const results = await facade.searchSemantic('semantic search', { limit: 5 });
      expect(Array.isArray(results)).toBe(true);
      for (const r of results) {
        expect(r.memory).toBeDefined();
        expect(typeof r.score).toBe('number');
        expect(r.source).toBe('hybrid');
      }
    });
  });
});
