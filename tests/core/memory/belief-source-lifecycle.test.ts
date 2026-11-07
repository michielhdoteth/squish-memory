import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { buildBeliefSourceLifecyclePredicate } from '../../../core/memory/belief-search.js';

describe('belief source lifecycle filtering', () => {
  test('suppresses projections whose source is expired, inactive, or missing', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        status TEXT,
        is_active INTEGER,
        valid_from INTEGER,
        valid_to INTEGER,
        expires_at INTEGER
      );
      CREATE TABLE knowledge (id TEXT PRIMARY KEY, metadata TEXT);
    `);

    const nowSeconds = 2_000_000_000;
    const insertMemory = db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?)');
    insertMemory.run('source-active', 'active', 1, null, null, null);
    insertMemory.run('source-current-valid-from', 'active', 1, nowSeconds - 600, null, null);
    insertMemory.run('source-current-valid-from-ms', 'active', 1, (nowSeconds - 600) * 1000, null, null);
    insertMemory.run('source-expired-deadline', 'active', 1, null, null, nowSeconds - 1);
    insertMemory.run('source-expired-deadline-ms', 'active', 1, null, null, (nowSeconds - 1) * 1000);
    insertMemory.run('source-future-deadline-ms', 'active', 1, null, null, (nowSeconds + 600) * 1000);
    insertMemory.run('source-expired-validity', 'active', 1, null, nowSeconds, null);
    insertMemory.run('source-expired-validity-ms', 'active', 1, null, nowSeconds * 1000, null);
    insertMemory.run('source-future-valid-to-ms', 'active', 1, null, (nowSeconds + 600) * 1000, null);
    insertMemory.run('source-future-start', 'active', 1, nowSeconds + 600, null, null);
    insertMemory.run('source-future-start-ms', 'active', 1, (nowSeconds + 600) * 1000, null, null);
    insertMemory.run('source-inactive', 'active', 0, null, null, null);
    insertMemory.run('source-archived', 'archived', 0, null, null, null);

    const insertKnowledge = db.prepare('INSERT INTO knowledge VALUES (?, ?)');
    for (const sourceId of [
      'source-active',
      'source-current-valid-from',
      'source-current-valid-from-ms',
      'source-expired-deadline',
      'source-expired-deadline-ms',
      'source-future-deadline-ms',
      'source-expired-validity',
      'source-expired-validity-ms',
      'source-future-valid-to-ms',
      'source-future-start',
      'source-future-start-ms',
      'source-inactive',
      'source-archived',
      'source-missing',
    ]) {
      insertKnowledge.run(`belief-${sourceId}`, JSON.stringify({ sourceMemoryId: sourceId }));
    }
    insertKnowledge.run('belief-standalone', JSON.stringify({ source: 'manual' }));

    const predicate = buildBeliefSourceLifecyclePredicate(new Date(nowSeconds * 1000));
    const visible = db.prepare(`SELECT id FROM knowledge WHERE ${predicate.sql} ORDER BY id`)
      .all(...predicate.params) as Array<{ id: string }>;
    const visibleIds = new Set(visible.map((row) => row.id));

    expect(visibleIds.has('belief-source-active')).toBe(true);
    expect(visibleIds.has('belief-source-current-valid-from')).toBe(true);
    expect(visibleIds.has('belief-source-current-valid-from-ms')).toBe(true);
    expect(visibleIds.has('belief-source-future-deadline-ms')).toBe(true);
    expect(visibleIds.has('belief-source-future-valid-to-ms')).toBe(true);
    expect(visibleIds.has('belief-source-future-start')).toBe(false);
    expect(visibleIds.has('belief-source-future-start-ms')).toBe(false);
    expect(visibleIds.has('belief-standalone')).toBe(true);
    expect(visibleIds.has('belief-source-expired-deadline')).toBe(false);
    expect(visibleIds.has('belief-source-expired-deadline-ms')).toBe(false);
    expect(visibleIds.has('belief-source-expired-validity')).toBe(false);
    expect(visibleIds.has('belief-source-expired-validity-ms')).toBe(false);
    expect(visibleIds.has('belief-source-inactive')).toBe(false);
    expect(visibleIds.has('belief-source-archived')).toBe(false);
    expect(visibleIds.has('belief-source-missing')).toBe(false);
    db.close();
  });
});
