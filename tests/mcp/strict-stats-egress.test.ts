import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QMDClient } from '../../core/embeddings/qmd-client.js';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-strict-stats-egress-'));
const envKeys = ['SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID'] as const;
const savedEnv = new Map<string, string | undefined>();

describe('strict stats egress boundary', () => {
  let closeAllDbs: typeof import('../../db/index.js').closeAllDbs;

  beforeAll(async () => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-egress-test-user';
    const db = await import('../../db/index.js');
    closeAllDbs = db.closeAllDbs;
    await db.getDb();
  });

  afterAll(async () => {
    await closeAllDbs?.();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may briefly retain the closed SQLite handle. */ }
  });

  it('withholds strict aggregate stats before QMD can start its local model subprocess', async () => {
    const qmdAvailability = spyOn(QMDClient.prototype, 'isAvailable').mockResolvedValue(true);
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    const { registerMemoryTools } = await import('../../mcp/tools/memory.js');
    registerMemoryTools({
      register: (_server, name, _definition, handler) => {
        handlers.set(name, handler);
        return true;
      },
      server: {} as never,
      sdkClient: {} as never,
      resolveProjectPath: () => undefined,
      errorResponse: (code, message, detail) => ({ content: [{ type: 'text', text: JSON.stringify({ error: code, message, detail }) }] }),
      SERVER_VERSION: 'test',
    });

    try {
      const handler = handlers.get('squish_stats');
      expect(handler).toBeDefined();
      const response = await handler!({ action: 'status', user: 'strict-egress-test-user' });
      const body = JSON.parse((response as { content: Array<{ text: string }> }).content[0]!.text) as { error: string };
      expect(body.error).toBe('strict_stats_unavailable');
      expect(qmdAvailability).not.toHaveBeenCalled();
    } finally {
      qmdAvailability.mockRestore();
    }
  });
});
