import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';

const dataDir = join(tmpdir(), `squish-reviewed-compaction-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(dataDir, { recursive: true });

const envKeys = [
  'SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_EMBEDDINGS_PROVIDER',
  'SQUISH_LOCAL_BUNDLED_MODEL', 'SQUISH_SKIP_CONTRADICTION', 'SQUISH_TRUST_POLICY',
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
process.env.SQUISH_SKIP_CONTRADICTION = 'true';
delete process.env.SQUISH_TRUST_POLICY;

const sourceContent = [
  'Project Orion stores the release cache in SQLite and does not store API keys there.',
  'Exports must keep source IDs and creation dates. Failed exports should be retried only after the provider recovers.',
  'The cache stays in SQLite; the cache stays in SQLite. This was confirmed during the migration review.',
].join(' ');
const compactedContent = 'Project Orion keeps the release cache in SQLite, not API keys. Exports keep source IDs and dates; retry failures only after provider recovery.';

let sqlite: { exec: (sql: string) => void; prepare: (sql: string) => {
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  all: (...args: unknown[]) => Array<Record<string, unknown>>;
  run: (...args: unknown[]) => unknown;
} };
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let applyReviewedMemoryCompaction: typeof import('../../../core/memory/consolidation.js').applyReviewedMemoryCompaction;
let sourceMemoryId = '';

beforeAll(async () => {
  const dbModule = await import('../../../db/index.js');
  dbModule.resetDb();
  const db = await dbModule.getDb();
  sqlite = db.$client;
  ({ rememberMemory } = await import('../../../core/memory/memories.js'));
  ({ applyReviewedMemoryCompaction } = await import('../../../core/memory/consolidation.js'));
  const source = await rememberMemory({ content: sourceContent, type: 'fact' });
  sourceMemoryId = source.id;
});

afterAll(async () => {
  try { sqlite?.exec('DROP TRIGGER IF EXISTS fail_reviewed_compaction_source_link;'); } catch {}
  const dbModule = await import('../../../db/index.js');
  await dbModule.closeAllDbs();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

test('reviewed compaction rolls back the derived record when source linking fails and repairs idempotently', async () => {
  sqlite.exec(`CREATE TRIGGER fail_reviewed_compaction_source_link
    BEFORE UPDATE OF is_consolidated ON memories
    WHEN OLD.id = '${sourceMemoryId}' AND NEW.is_consolidated = 1
    BEGIN SELECT RAISE(ABORT, 'forced reviewed compaction link failure'); END;`);

  await expect(applyReviewedMemoryCompaction({
    contractVersion: 1,
    sourceMemoryId,
    compactedContent,
    modelId: 'test:deterministic',
    promptVersion: 'reviewed-compaction-test-v1',
  })).rejects.toThrow('forced reviewed compaction link failure');

  expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories').get()?.count).toBe(1);
  expect(sqlite.prepare('SELECT is_consolidated AS linked FROM memories WHERE id = ?').get(sourceMemoryId)?.linked).toBe(0);
  sqlite.exec('DROP TRIGGER fail_reviewed_compaction_source_link;');

  const applied = await applyReviewedMemoryCompaction({
    contractVersion: 1,
    sourceMemoryId,
    compactedContent,
    modelId: 'test:deterministic',
    promptVersion: 'reviewed-compaction-test-v1',
  });
  expect(sqlite.prepare('SELECT is_consolidated AS linked, consolidated_into AS target FROM memories WHERE id = ?').get(sourceMemoryId))
    .toEqual({ linked: 1, target: applied.memoryId });
  expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories').get()?.count).toBe(2);

  // Simulate a pre-fix partial write and ensure replay of the same approval
  // repairs the source link without creating another derived memory.
  sqlite.prepare('UPDATE memories SET is_consolidated = 0, consolidated_into = NULL, consolidated_at = NULL WHERE id = ?').run(sourceMemoryId);
  const replayed = await applyReviewedMemoryCompaction({
    contractVersion: 1,
    sourceMemoryId,
    compactedContent,
    modelId: 'test:deterministic',
    promptVersion: 'reviewed-compaction-test-v1',
  });
  expect(replayed.memoryId).toBe(applied.memoryId);
  expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories').get()?.count).toBe(2);
  expect(sqlite.prepare('SELECT is_consolidated AS linked, consolidated_into AS target FROM memories WHERE id = ?').get(sourceMemoryId))
    .toEqual({ linked: 1, target: applied.memoryId });
});
