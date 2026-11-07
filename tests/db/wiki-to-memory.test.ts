/**
 * Tests for the one-time wiki -> memory migration (Batch 8).
 *
 * Covers: legacy DB migration (pages -> memories tagged wiki-origin,
 * resolvable wikilinks -> associations, legacy tables dropped, marker
 * recorded), idempotency, dry-run gating, and fresh-install no-op.
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';

let testCounter = 0;
const testDataDirRoot = join(tmpdir(), `squish-wiki-mig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.SQUISH_DATA_DIR = testDataDirRoot;
process.env.DATABASE_URL = '';

if (!existsSync(testDataDirRoot)) mkdirSync(testDataDirRoot, { recursive: true });

import { describe, test, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';

import { ensureSqliteSchema } from '../../db/bootstrap.js';
import {
  runWikiToMemoryMigration,
  WIKI_TO_MEMORY_MARKER,
} from '../../db/migrations/wiki-to-memory.js';

const savedDryRun = process.env.SQUISH_WIKI_MIGRATE_DRY_RUN;

afterEach(() => {
  if (savedDryRun === undefined) delete process.env.SQUISH_WIKI_MIGRATE_DRY_RUN;
  else process.env.SQUISH_WIKI_MIGRATE_DRY_RUN = savedDryRun;
});

function newDbPath(): string {
  const dataDir = join(testDataDirRoot, `test-${testCounter++}`);
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, 'squish.db');
}

async function freshDb(): Promise<Database> {
  const sqlite = new Database(newDbPath());
  sqlite.exec('PRAGMA foreign_keys = OFF');
  // Bootstrap the current schema exactly like a real install. The migration
  // hook inside no-ops here because legacy wiki tables do not exist yet -
  // which is precisely the fresh-install path.
  await ensureSqliteSchema(sqlite);
  return sqlite;
}

/** Re-create the legacy wiki tables an old install would still have + seed rows. */
function seedLegacyTables(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      content TEXT,
      summary TEXT,
      page_type TEXT NOT NULL DEFAULT 'article',
      status TEXT NOT NULL DEFAULT 'draft',
      visibility TEXT NOT NULL DEFAULT 'private',
      tags TEXT,
      metadata TEXT,
      word_count INTEGER DEFAULT 0,
      last_indexed_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wiki_links (
      id TEXT PRIMARY KEY,
      source_page_id TEXT NOT NULL,
      target_page_id TEXT,
      target_slug TEXT NOT NULL,
      context TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wiki_page_versions (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      change_summary TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
    );
    DELETE FROM _schema_versions WHERE version IN ('${WIKI_TO_MEMORY_MARKER}', '2.2.1-wiki-links-knowledge-edges');
  `);

  const now = Math.floor(Date.now() / 1000);
  const ins = sqlite.prepare(`
    INSERT INTO wiki_pages (id, project_id, title, slug, content, summary, page_type, status, tags, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  ins.run('wp-1', 'Architecture Overview', 'architecture-overview', 'System uses SQLite locally.', 'The gist', 'reference', 'published', JSON.stringify(['docs', 'arch']), now, now);
  ins.run('wp-2', 'Decision Log', 'decision-log', 'We picked Bun over Node.', null, 'decision', 'draft', '[]', now, now);
  ins.run('wp-3', 'Orphan Notes', 'orphan-notes', 'Points at [[Missing Page]].', null, 'note', 'draft', '[]', now, now);

  sqlite.prepare(`INSERT INTO wiki_links (id, source_page_id, target_page_id, target_slug) VALUES ('wl-1', 'wp-1', 'wp-2', 'decision-log')`).run();
  // Unresolvable link: target page does not exist.
  sqlite.prepare(`INSERT INTO wiki_links (id, source_page_id, target_page_id, target_slug) VALUES ('wl-2', 'wp-3', NULL, 'missing-page')`).run();
}

describe('wiki-to-memory migration', () => {
  test('startup reconciles wiki-imported memories and links into canonical knowledge edges', async () => {
    const sqlite = await freshDb();
    seedLegacyTables(sqlite);

    await ensureSqliteSchema(sqlite);

    const memoryCount = sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge WHERE knowledge_kind='memory' AND json_extract(metadata, '$.wikiOrigin')=1").get() as { count: number };
    const edgeCount = sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE edge_type='relates_to' AND json_extract(metadata, '$.coactivation_count')=1").get() as { count: number };
    const legacyTable = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_associations'").get();
    const migrationMarker = sqlite.prepare("SELECT 1 FROM _schema_versions WHERE version='2.2.1-wiki-links-knowledge-edges'").get();

    expect(memoryCount.count).toBe(3);
    expect(edgeCount.count).toBe(1);
    expect(legacyTable).toBeNull();
    expect(migrationMarker).toBeDefined();
    sqlite.close();
  });

  test('migrates pages into memories, links into associations, drops legacy tables', async () => {
    const sqlite = await freshDb();
    seedLegacyTables(sqlite);

    const report = runWikiToMemoryMigration(sqlite);
    expect(report.ran).toBe(true);
    expect(report.pagesFound).toBe(3);
    expect(report.pagesMigrated).toBe(3);
    expect(report.linksResolved).toBe(1);
    expect(report.linksUnresolved).toBe(1);

    const memories = sqlite.prepare("SELECT * FROM memories WHERE source = 'wiki-migration'").all() as any[];
    expect(memories.length).toBe(3);

    const arch = memories.find((m) => String(m.content).includes('Architecture Overview'))!;
    expect(arch).toBeDefined();
    expect(String(arch.content)).toContain('# Architecture Overview');
    expect(String(arch.content)).toContain('System uses SQLite locally.');
    expect(String(arch.summary)).toBe('The gist');
    expect(String(arch.type)).toBe('fact');
    expect(JSON.parse(arch.tags as string)).toContain('wiki-origin');
    expect(arch.sector).toBe('semantic');
    const meta = JSON.parse(arch.metadata as string);
    expect(meta.wikiOrigin).toBe(true);
    expect(meta.wikiSlug).toBe('architecture-overview');

    const decision = memories.find((m) => String(m.content).includes('Decision Log'))!;
    expect(decision.type).toBe('decision');

    // Resolvable link became a canonical graph edge; unresolvable did not.
    const assocs = sqlite.prepare("SELECT * FROM knowledge_edges WHERE edge_type = 'relates_to' AND json_extract(metadata, '$.source')='wiki-migration'").all() as any[];
    expect(assocs.length).toBe(1);
    const fromMem = memIdBySlug(sqlite, 'architecture-overview');
    const toMem = memIdBySlug(sqlite, 'decision-log');
    expect([assocs[0].from_id, assocs[0].to_id].sort()).toEqual([fromMem, toMem].sort());

    // Legacy tables dropped, marker recorded.
    const leftover = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wiki%'"
    ).all() as any[];
    expect(leftover.length).toBe(0);
    const marker = sqlite.prepare('SELECT version FROM _schema_versions WHERE version = ?').get(WIKI_TO_MEMORY_MARKER);
    expect(marker).toBeDefined();

    sqlite.close();
  });

  test('is idempotent - second run is a no-op', async () => {
    const sqlite = await freshDb();
    seedLegacyTables(sqlite);
    runWikiToMemoryMigration(sqlite);

    const count = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM memories WHERE source = 'wiki-migration'").get() as any).n;
    const before = count();
    const second = runWikiToMemoryMigration(sqlite);
    expect(second.ran).toBe(false);
    expect(count()).toBe(before);
    sqlite.close();
  });

  test('dry-run writes nothing and leaves the marker unset', async () => {
    const sqlite = await freshDb();
    seedLegacyTables(sqlite);
    process.env.SQUISH_WIKI_MIGRATE_DRY_RUN = 'true';

    const report = runWikiToMemoryMigration(sqlite);
    expect(report.dryRun).toBe(true);
    expect(report.pagesFound).toBe(3);
    expect(report.pagesMigrated).toBe(0);

    const migrated = sqlite.prepare("SELECT COUNT(*) AS n FROM memories WHERE source = 'wiki-migration'").get() as any;
    expect(migrated.n).toBe(0);
    const marker = sqlite.prepare('SELECT version FROM _schema_versions WHERE version = ?').get(WIKI_TO_MEMORY_MARKER);
    expect(marker).toBeNull();
    // Legacy tables still present for a later real run.
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'wiki_pages'").all();
    expect(tables.length).toBe(1);

    delete process.env.SQUISH_WIKI_MIGRATE_DRY_RUN;

    // Real run after dry-run works.
    const applied = runWikiToMemoryMigration(sqlite);
    expect(applied.ran).toBe(true);
    expect(applied.pagesMigrated).toBe(3);
    sqlite.close();
  });

  test('fresh installs record the marker without erroring', async () => {
    const sqlite = await freshDb(); // bootstrap already ran the no-op path
    // Force a second look with the marker cleared: still no legacy table.
    sqlite.exec(`DELETE FROM _schema_versions WHERE version = '${WIKI_TO_MEMORY_MARKER}'`);
    const report = runWikiToMemoryMigration(sqlite);
    expect(report.ran).toBe(false);
    expect(report.pagesFound).toBe(0);
    const marker = sqlite.prepare('SELECT version FROM _schema_versions WHERE version = ?').get(WIKI_TO_MEMORY_MARKER);
    expect(marker).toBeDefined();
    sqlite.close();
  });
});

function memIdBySlug(sqlite: Database, slug: string): string | undefined {
  const rows = sqlite.prepare("SELECT id, metadata FROM memories WHERE source = 'wiki-migration'").all() as any[];
  for (const r of rows) {
    const meta = JSON.parse(r.metadata as string);
    if (meta.wikiOrigin && meta.wikiSlug === slug) return r.id;
  }
  return undefined;
}
