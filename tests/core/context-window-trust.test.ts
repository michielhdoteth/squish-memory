import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-context-window-trust-'));
const envKeys = ['SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID'] as const;
const savedEnv = new Map<string, string | undefined>();

describe('strict trust for context-window reads', () => {
  let getDb: typeof import('../../db/index.js').getDb;
  let closeAllDbs: typeof import('../../db/index.js').closeAllDbs;
  let getTokenUsage: typeof import('../../core/context/context-window.js').getTokenUsage;
  let getOptimizationSuggestions: typeof import('../../core/context/context-window.js').getOptimizationSuggestions;
  let getContextWindowStatus: typeof import('../../core/context/context-window.js').getContextWindowStatus;

  beforeAll(async () => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'context-window-test-caller';

    ({ getDb, closeAllDbs } = await import('../../db/index.js'));
    ({ getTokenUsage, getOptimizationSuggestions, getContextWindowStatus } = await import('../../core/context/context-window.js'));
    const sqlite = (await getDb() as any).$client;
    sqlite.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
      .run('context-window-private-project', 'private', join(dataDir, 'private'));
    sqlite.prepare(`INSERT INTO memories (
      id, project_id, type, content, status, is_active, importance_score,
      access_count, tokens_estimate, is_pinned, is_protected, created_at
    ) VALUES (?, ?, ?, ?, 'active', 1, 10, 0, 10, 0, 0, ?)`)
      .run('context-window-private-memory', 'context-window-private-project', 'note', 'sensitive context-window preview marker', Date.now() - 100 * 86400000);
  });

  afterAll(async () => {
    await closeAllDbs();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* SQLite may retain a closed handle briefly on Windows. */ }
  });

  it('denies raw context-window optimization previews under strict trust', { timeout: 30000 }, async () => {
    const projectPath = join(dataDir, 'private');
    await expect(getTokenUsage(projectPath)).rejects.toThrow('strict trust');
    await expect(getOptimizationSuggestions(join(dataDir, 'private')))
      .rejects.toThrow('strict trust');
    await expect(getContextWindowStatus(projectPath)).rejects.toThrow('strict trust');
  });
});
