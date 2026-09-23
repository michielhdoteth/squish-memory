import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';

const testDataDir = join(tmpdir(), `squish-v15-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

import { beforeEach, describe as _describe, expect, test as _test } from 'bun:test';

// SKIPPED: All tests in this file depend on the memory_places table which has been
// removed. The Places system now works through knowledge + knowledge_edges tables.
// This file is kept for historical reference and migration path documentation.
const describe = _describe.skip;
const test = _test;
import { getDb, resetDb } from '../db/index.js';
import { initializeDefaultPlaces, ensureGlobalProject, getPlaceByType } from '../core/places/places.js';
import {
  assignMemoryToPlaces,
  storeMemoryTags,
  getMemoryPlace,
  assignMemoryToPlace,
} from '../core/places/memory-places.js';
import { findMatchingPlaces } from '../core/places/rules.js';
import { detectQuestionType, questionPlaceType } from '../core/places/question-router.js';
import { getAdjacentPlaces, ADJACENT_PLACES } from '../core/places/rules.js';
import {
  getRetrievalConfig,
} from '../core/retrieval/config.js';
import type { SquishRetrievalConfig, RetrievalTrace } from '../core/retrieval/config.js';
import { createNormalizer, tagNormalizer } from '../core/places/tag-normalizer.js';
import { rememberMemory } from '../core/memory/memories.js';

// ── helpers ──────────────────────────────────────────────────────────

async function execSql(sql: string) {
  const db = await getDb();
  const sqlite = (db as any).$client;
  if (sqlite && typeof sqlite.exec === 'function') {
    sqlite.exec(sql);
  }
}

async function queryAll(sql: string, ...params: any[]) {
  const db = await getDb();
  const sqlite = (db as any).$client;
  if (sqlite && typeof sqlite.prepare === 'function') {
    const stmt = sqlite.prepare(sql);
    return params.length > 0 ? stmt.all(...params) : stmt.all();
  }
  return [];
}

async function clearData() {
  await execSql('DELETE FROM memory_tags;');
  await execSql('DELETE FROM memory_places;');
  await execSql('DELETE FROM memories;');
  await execSql('DELETE FROM place_rules;');
  await execSql('DELETE FROM places;');
  await execSql('DELETE FROM projects;');
}

// ── 1. Multi-place data model ────────────────────────────────────────

describe('1. Multi-place data model', () => {
  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearData();
  });

  test('A memory can have primaryPlace set', async () => {
    const memory = await rememberMemory({
      content: 'memory with primary place',
      type: 'fact',
    });

    const rows = await queryAll('SELECT * FROM memories WHERE id = ?', memory.id);
    expect(rows.length).toBe(1);
    const row = rows[0] as any;
    expect(row.primary_place || row.primaryPlace).toBeTruthy();
  });

  test('A memory can belong to multiple places via memory_places', async () => {
    await initializeDefaultPlaces();

    const memory = await rememberMemory({
      content: 'decided to implement the fix',
      type: 'decision',
    });

    // Should have multiple assignments in memory_places
    const assignments = await queryAll(
      'SELECT * FROM memory_places WHERE memory_id = ?',
      memory.id
    );
    expect(assignments.length).toBeGreaterThanOrEqual(1);

    // Verify different place types exist in the assignments
    const placeTypes = [...new Set(assignments.map((a: any) => a.place_type || a.placeType))];
    expect(placeTypes.length).toBeGreaterThanOrEqual(1);
  });

  test('primaryPlace matches legacy placeType for backward compat', async () => {
    await initializeDefaultPlaces();

    const memory = await rememberMemory({
      content: 'backward compat test',
      type: 'observation',
    });

    const rows = await queryAll('SELECT * FROM memories WHERE id = ?', memory.id);
    expect(rows.length).toBe(1);
    const row = rows[0] as any;
    const primaryPlace = row.primary_place || row.primaryPlace;
    const legacyPlaceId = row.place_id || row.placeId;

    // primaryPlace should be set (a place type string like 'inbox', 'wip', etc.)
    expect(primaryPlace).toBeTruthy();
    // Legacy place_id should also be set (resolved from place type)
    expect(legacyPlaceId).toBeTruthy();
    expect(typeof legacyPlaceId).toBe('string');
    expect(legacyPlaceId.length).toBeGreaterThan(0);

    // Verify the place_id actually exists in the places table
    const placeRows = await queryAll('SELECT * FROM places WHERE id = ?', legacyPlaceId);
    expect(placeRows.length).toBe(1);
    // The place's place_type should match the memory's primaryPlace
    const placeType = (placeRows[0] as any).place_type || (placeRows[0] as any).placeType;
    expect(placeType).toBe(primaryPlace);
  });

  test('memory_places stores weight, reason, source for each place', async () => {
    await initializeDefaultPlaces();

    const memory = await rememberMemory({
      content: 'decided to implement the fix for the bug',
      type: 'decision',
    });

    const assignments = await queryAll(
      'SELECT * FROM memory_places WHERE memory_id = ?',
      memory.id
    );
    expect(assignments.length).toBeGreaterThanOrEqual(1);

    for (const a of assignments) {
      // weight should be a number between 0 and 1
      expect(typeof a.weight).toBe('number');
      expect(a.weight).toBeGreaterThanOrEqual(0);
      expect(a.weight).toBeLessThanOrEqual(1);

      // source should be one of the valid values
      expect(['heuristic', 'llm', 'manual', 'dream']).toContain(a.source);

      // reason can be null or a string
      if (a.reason !== null) {
        expect(typeof a.reason).toBe('string');
      }
    }
  });

  test('isPrimary flag is set on the highest-weight place', async () => {
    await initializeDefaultPlaces();

    const memory = await rememberMemory({
      content: 'decided to implement the fix',
      type: 'decision',
    });

    const assignments = await queryAll(
      'SELECT * FROM memory_places WHERE memory_id = ?',
      memory.id
    );

    // Find the isPrimary=1 assignment
    const primaryAssignments = assignments.filter((a: any) => a.is_primary || a.isPrimary);
    expect(primaryAssignments.length).toBe(1);

    // The primary assignment should have the highest weight
    const primaryWeight = (primaryAssignments[0] as any).weight;
    for (const a of assignments) {
      expect(a.weight).toBeLessThanOrEqual(primaryWeight + 0.001); // float tolerance
    }
  });
});

// ── 2. Tag normalization in storage ──────────────────────────────────

describe('2. Tag normalization in storage', () => {
  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearData();
  });

  test('Tags are stored normalized (lowercase, hyphens)', async () => {
    await initializeDefaultPlaces();

    const memory = await rememberMemory({
      content: 'tagged memory storage test',
      type: 'observation',
      tags: ['Machine Learning', 'NEURAL-NETWORK', 'deep learning'],
    });

    const tags = await queryAll(
      'SELECT * FROM memory_tags WHERE memory_id = ?',
      memory.id
    );

    expect(tags.length).toBeGreaterThan(0);
    const tagValues = tags.map((t: any) => t.tag);
    expect(tagValues).toContain('machine-learning');
    expect(tagValues).toContain('neural-network');
    expect(tagValues).toContain('deep-learning');
  });

  test('Duplicate tags are removed', async () => {
    await initializeDefaultPlaces();

    const memory = await rememberMemory({
      content: 'duplicate tags test',
      type: 'observation',
      tags: ['Squish', 'squish', 'SQUISH', 'squish-project'],
    });

    const tags = await queryAll(
      'SELECT * FROM memory_tags WHERE memory_id = ?',
      memory.id
    );

    const tagValues = tags.map((t: any) => t.tag);
    // Only one squish variant should exist
    const squishVariants = tagValues.filter(t => t === 'squish');
    expect(squishVariants.length).toBe(1);
    // squish-project should also exist
    expect(tagValues).toContain('squish-project');
  });

  test('Empty tags are filtered out', async () => {
    await initializeDefaultPlaces();

    const memory = await rememberMemory({
      content: 'empty tags test',
      type: 'observation',
      tags: ['', '  ', '-', 'real-tag'],
    });

    const tags = await queryAll(
      'SELECT * FROM memory_tags WHERE memory_id = ?',
      memory.id
    );

    const tagValues = tags.map((t: any) => t.tag);
    // Empty/whitespace-only tags should be filtered
    expect(tagValues).not.toContain('');
    expect(tagValues).not.toContain('-');
    expect(tagValues).toContain('real-tag');
  });

  test('Generic garbage tags are removed', async () => {
    await initializeDefaultPlaces();

    const memory = await rememberMemory({
      content: 'garbage tags test',
      type: 'observation',
      tags: ['ai', 'thing', 'important', 'real-concept', 'stuff', 'useful-pattern'],
    });

    const tags = await queryAll(
      'SELECT * FROM memory_tags WHERE memory_id = ?',
      memory.id
    );

    const tagValues = tags.map((t: any) => t.tag);
    // Garbage tags should be removed
    expect(tagValues).not.toContain('ai');
    expect(tagValues).not.toContain('thing');
    expect(tagValues).not.toContain('important');
    expect(tagValues).not.toContain('stuff');
    // Real tags should remain
    expect(tagValues).toContain('real-concept');
    expect(tagValues).toContain('useful-pattern');
  });

  test('Tags capped at config limit', async () => {
    const normalizer = createNormalizer({ tagCap: 3 });
    const tags = normalizer.normalizeTags([
      'alpha', 'bravo', 'charlie', 'delta', 'echo',
    ]);

    expect(tags.length).toBe(3);
    // Should be alphabetically sorted
    expect(tags).toEqual(['alpha', 'bravo', 'charlie']);
  });
});

// ── 3. Place retrieval from indexed tables ────────────────────────────

describe('3. Place retrieval from indexed tables', () => {
  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearData();
  });

  test('Query memory_places by placeType returns correct memories', async () => {
    await initializeDefaultPlaces();

    // Create two memories that go to different places
    const memory1 = await rememberMemory({
      content: 'decided to implement the fix',
      type: 'decision',
    });

    // Query memory_places for 'board' type (should contain our decision memory)
    const boardMemories = await queryAll(
      "SELECT * FROM memory_places WHERE place_type = 'board'"
    );

    // The "decided" keyword should route to board
    const memory1InBoard = boardMemories.find((m: any) => m.memory_id === memory1.id);
    expect(memory1InBoard).toBeTruthy();
  });

  test('Memory with secondary place (weight >= minWeight) is found in scoped search', async () => {
    await initializeDefaultPlaces();

    // Create a memory that matches multiple places
    const memory = await rememberMemory({
      content: 'decided to implement the fix for the bug',
      type: 'decision',
    });

    // Should have both 'board' (from "decided") and 'wip' (from "fix" or "Write" tool)
    const assignments = await queryAll(
      'SELECT * FROM memory_places WHERE memory_id = ?',
      memory.id
    );

    const placeTypes = assignments.map((a: any) => a.place_type || a.placeType);
    expect(placeTypes.length).toBeGreaterThanOrEqual(1);

    // At least one assignment should have sufficient weight
    const highWeightAssignments = assignments.filter((a: any) => a.weight >= 0.35);
    expect(highWeightAssignments.length).toBeGreaterThanOrEqual(1);
  });

  test('Memory below minWeight threshold is excluded from scoped search', async () => {
    await initializeDefaultPlaces();

    const memory = await rememberMemory({
      content: 'low weight memory test',
      type: 'observation',
    });

    // Manually insert a low-weight assignment
    const wipPlace = await getPlaceByType(undefined, 'wip');
    if (wipPlace) {
      await execSql(
        `INSERT OR IGNORE INTO memory_places (id, memory_id, place_type, weight, reason, source, is_primary)
         VALUES ('test-low-weight-${memory.id}', '${memory.id}', 'wip', 0.10, 'test low weight', 'manual', 0)`
      );
    }

    // Query with minWeight of 0.35 - should NOT include the low-weight assignment
    const config = getRetrievalConfig();
    const assignments = await queryAll(
      `SELECT * FROM memory_places WHERE place_type = 'wip' AND weight >= ${config.placeMinWeight}`
    );

    const found = assignments.find((a: any) => a.memory_id === memory.id);
    expect(found).toBeUndefined();
  });

  test('getMemoryPlace() returns the primary place correctly', async () => {
    await initializeDefaultPlaces();

    const memory = await rememberMemory({
      content: 'test getMemoryPlace',
      type: 'fact',
    });

    const placeId = await getMemoryPlace(memory.id);
    expect(placeId).toBeTruthy();
    expect(typeof placeId).toBe('string');
  });

  test('getPlaceMemories() returns all memories for a place via raw SQL', async () => {
    await initializeDefaultPlaces();

    // Create a memory
    const memory = await rememberMemory({
      content: 'test place memory lookup',
      type: 'observation',
    });

    // Get the place the memory was assigned to via raw SQL
    const mpRows = await queryAll(
      'SELECT place_type FROM memory_places WHERE memory_id = ? LIMIT 1',
      memory.id
    );
    expect(mpRows.length).toBeGreaterThanOrEqual(1);
    const placeType = (mpRows[0] as any).place_type;

    // Resolve placeType to placeId
    const placeRows = await queryAll(
      'SELECT id FROM places WHERE place_type = ? LIMIT 1',
      placeType
    );
    expect(placeRows.length).toBe(1);
    const placeId = (placeRows[0] as any).id;

    // Query memory_places by place_id directly via raw SQL
    const memories = await queryAll(
      'SELECT memory_id FROM memory_places WHERE place_type = ? LIMIT 50',
      placeType
    );
    const memoryIds = memories.map((m: any) => m.memory_id);
    expect(memoryIds).toContain(memory.id);
  });
});

// ── 4. Tag retrieval from indexed tables ──────────────────────────────

describe('4. Tag retrieval from indexed tables', () => {
  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearData();
  });

  test('Query memory_tags by tag returns correct memories', async () => {
    await initializeDefaultPlaces();

    const memory = await rememberMemory({
      content: 'tagged query test',
      type: 'observation',
      tags: ['machine-learning', 'neural-network'],
    });

    const results = await queryAll(
      "SELECT * FROM memory_tags WHERE tag = 'machine-learning'"
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    const found = results.find((r: any) => r.memory_id === memory.id);
    expect(found).toBeTruthy();
  });

  test('Multiple tags can be queried and overlap counted', async () => {
    await initializeDefaultPlaces();

    const memory1 = await rememberMemory({
      content: 'multi tag query test memory one',
      type: 'observation',
      tags: ['machine-learning', 'deep-learning'],
    });

    const memory2 = await rememberMemory({
      content: 'multi tag query test memory two',
      type: 'observation',
      tags: ['machine-learning', 'neural-network'],
    });

    // Query for memories with both tags
    const results = await queryAll(
      "SELECT * FROM memory_tags WHERE tag IN ('machine-learning', 'deep-learning', 'neural-network')"
    );

    // memory1 should appear twice (ml + dl), memory2 should appear twice (ml + nn)
    const mem1Hits = results.filter((r: any) => r.memory_id === memory1.id);
    const mem2Hits = results.filter((r: any) => r.memory_id === memory2.id);
    expect(mem1Hits.length).toBe(2);
    expect(mem2Hits.length).toBe(2);
  });

  test('Tag overlap count is correct for memories with shared tags', async () => {
    await initializeDefaultPlaces();

    const memory1 = await rememberMemory({
      content: 'overlap test memory one',
      type: 'observation',
      tags: ['react', 'typescript', 'frontend'],
    });

    const memory2 = await rememberMemory({
      content: 'overlap test memory two',
      type: 'observation',
      tags: ['react', 'typescript', 'backend'],
    });

    // Query for both react and typescript
    const results = await queryAll(
      "SELECT * FROM memory_tags WHERE tag IN ('react', 'typescript')"
    );

    // Both memories should have 2 matches each (react + typescript)
    const mem1Count = results.filter((r: any) => r.memory_id === memory1.id).length;
    const mem2Count = results.filter((r: any) => r.memory_id === memory2.id).length;
    expect(mem1Count).toBe(2);
    expect(mem2Count).toBe(2);
  });
});

// ── 6. Question routing integration ──────────────────────────────────

describe('6. Question routing integration', () => {
  test('"What do I prefer?" routes to board', () => {
    const query = 'What do I prefer for the frontend?';
    expect(detectQuestionType(query)).toBe('preference');
    expect(questionPlaceType(query)).toBe('board');
  });

  test('"What happened last week?" routes to ref', () => {
    const query = 'What happened last week?';
    expect(detectQuestionType(query)).toBe('event');
    expect(questionPlaceType(query)).toBe('wip');
  });

  test('"What are we building?" routes to wip', () => {
    const query = 'What are we building?';
    expect(detectQuestionType(query)).toBe('active_work');
    expect(questionPlaceType(query)).toBe('wip');
  });
});

// ── 7. Supersession filtering ────────────────────────────────────────

describe('7. Supersession filtering', () => {
  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearData();
  });

  test('Superseded memories are filtered when includeSuperseded=false', async () => {
    await initializeDefaultPlaces();

    // Create two memories
    const memory1 = await rememberMemory({
      content: 'supersession filter test old',
      type: 'fact',
    });
    const memory2 = await rememberMemory({
      content: 'supersession filter test new',
      type: 'fact',
    });

    // Mark memory1 as superseded by memory2
    await execSql(
      `UPDATE memories SET superseded_by = '${memory2.id}' WHERE id = '${memory1.id}'`
    );

    // Query with includeSuperseded=false
    const config = getRetrievalConfig({ includeSuperseded: false });
    expect(config.includeSuperseded).toBe(false);

    // Verify memory1 is marked superseded in DB
    const rows = await queryAll(
      'SELECT * FROM memories WHERE id = ?',
      memory1.id
    );
    expect((rows[0] as any).superseded_by || (rows[0] as any).supersededBy).toBeTruthy();
  });

  test('Superseded memories included with penalty when includeSuperseded=true', () => {
    const config = getRetrievalConfig({ includeSuperseded: true });
    expect(config.includeSuperseded).toBe(true);

  });

  test('Trace metadata counts supersededFiltered correctly', () => {
    // Verify the RetrievalTrace interface accepts supersededFiltered
    const trace: RetrievalTrace = {
      selectedPlace: 'wip',
      fallbackUsed: false,
      fallbackPlaces: [],
      matchedPlaces: ['wip'],
      matchedTags: [],
      scoreBreakdown: {},
      scoreBreakdowns: [],
      supersededFiltered: 5,
      totalCandidates: 20,
      finalOrder: [],
      finalResultCount: 15,
    };

    expect(trace.supersededFiltered).toBe(5);
    expect(trace.totalCandidates).toBe(20);
    expect(trace.finalResultCount).toBe(15);
    expect(trace.totalCandidates - trace.supersededFiltered).toBe(trace.finalResultCount);
  });
});

// ── 8. Cross-module integration ──────────────────────────────────────

describe('8. Cross-module integration', () => {
  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearData();
  });

  test('Full pipeline: create memory -> multi-place assignment -> tag storage -> retrieval config', async () => {
    await initializeDefaultPlaces();

    // Step 1: Create a memory with tags
    const memory = await rememberMemory({
      content: 'decided to implement the fix for the neural network module',
      type: 'decision',
      tags: ['neural-network', 'machine-learning'],
    });

    expect(memory.id).toBeTruthy();
    expect(memory.type).toBe('decision');

    // Step 2: Verify multi-place assignment happened
    const assignments = await queryAll(
      'SELECT * FROM memory_places WHERE memory_id = ?',
      memory.id
    );
    expect(assignments.length).toBeGreaterThanOrEqual(1);

    // Step 3: Verify tags were stored normalized
    const tags = await queryAll(
      'SELECT * FROM memory_tags WHERE memory_id = ?',
      memory.id
    );
    const tagValues = tags.map((t: any) => t.tag);
    expect(tagValues).toContain('machine-learning');
    expect(tagValues).toContain('neural-network');

    // Step 4: Verify primaryPlace is set
    const rows = await queryAll('SELECT * FROM memories WHERE id = ?', memory.id);
    const primaryPlace = (rows[0] as any).primary_place || (rows[0] as any).primaryPlace;
    expect(primaryPlace).toBeTruthy();
  });

  test('getAdjacentPlaces returns valid results for all place types', () => {
    const placeTypes = ['board', 'wip', 'sparks', 'ref', 'inbox', 'sandbox', 'archive'] as const;

    for (const pt of placeTypes) {
      const adjacent = getAdjacentPlaces(pt);
      expect(adjacent).toBeArray();
      expect(adjacent.length).toBeGreaterThan(0);
    }
  });

  test('ADJACENT_PLACES map matches function output', () => {
    for (const [place, adjacent] of Object.entries(ADJACENT_PLACES)) {
      const functionResult = getAdjacentPlaces(place as any);
      expect(functionResult).toEqual(adjacent);
    }
  });
});
