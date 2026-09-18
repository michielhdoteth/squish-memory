/**
 * ACL search wiring test (fix for dead-code acl gate):
 * A real SDK-level client.search() must automatically build the ACL context
 * when visibility rules exist, log would-filter decisions in log-only mode,
 * and actually filter in enforce mode. With no rules defined the gate must
 * stay completely inert.
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

let testDataDir: string;
let savedEnv: Record<string, string | undefined>;

let SquishClient: typeof import('../../../core/runtime/squish-runtime.js').SquishRuntime;
let setVisibilityRule: typeof import('../../../core/loadout/loadout.js').setVisibilityRule;
let removeVisibilityRule: typeof import('../../../core/loadout/loadout.js').removeVisibilityRule;
let getAclLog: typeof import('../../../core/acl/acl-log.js').getAclLog;
let clearAclLog: typeof import('../../../core/acl/acl-log.js').clearAclLog;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';

async function seedMemory(id: string, content: string): Promise<void> {
  const db = await getDb();
  const sqlite = (db as any).$client;
  sqlite.exec(`INSERT INTO memories (id, content, type, status, created_at) VALUES ('${id}', '${content.replace(/'/g, "''")}', 'fact', 'active', '${new Date().toISOString()}')`);
}

describe('SDK search ACL wiring', () => {
  beforeAll(async () => {
    savedEnv = {
      SQUISH_DATA_DIR: process.env.SQUISH_DATA_DIR,
      DATABASE_URL: process.env.DATABASE_URL,
      SQUISH_ACL_ENFORCE: process.env.SQUISH_ACL_ENFORCE,
    };

    testDataDir = join(tmpdir(), `squish-acl-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDataDir, { recursive: true });
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';

    const sdkMod = await import('../../../core/runtime/squish-runtime.js');
    const loadoutMod = await import('../../../core/loadout/loadout.js');
    const logMod = await import('../../../core/acl/acl-log.js');
    const dbMod = await import('../../../db/index.js');
    SquishClient = sdkMod.SquishRuntime;
    setVisibilityRule = loadoutMod.setVisibilityRule;
    removeVisibilityRule = loadoutMod.removeVisibilityRule;
    getAclLog = logMod.getAclLog;
    clearAclLog = logMod.clearAclLog;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;

    await resetDb();

    // mem-private: rule grants only STRANGER -> hidden from OWNER in enforce mode
    // mem-open: rule grants everyone -> always served
    await seedMemory('mem-wired-private', 'confidential roadmap details');
    await seedMemory('mem-wired-open', 'public changelog notes');

    await setVisibilityRule({
      assetType: 'memory',
      assetId: 'mem-wired-private',
      ruleType: 'allow',
      granteeType: 'user',
      granteeId: STRANGER,
      permission: 'read',
    });
    await setVisibilityRule({
      assetType: 'memory',
      assetId: 'mem-wired-open',
      ruleType: 'allow',
      granteeType: 'everyone',
      granteeId: '*',
      permission: 'read',
    });
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { await removeVisibilityRule('memory', 'mem-wired-private', 'user', STRANGER); } catch {}
    try { await removeVisibilityRule('memory', 'mem-wired-open', 'everyone', '*'); } catch {}
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  });

  test('log-only mode: SDK search serves everything but logs would-filter', async () => {
    delete process.env.SQUISH_ACL_ENFORCE;
    clearAclLog();

    // No explicit user -> auto context falls back to 'local-agent', who is not
    // granted on mem-wired-private. Log-only mode must still serve it.
    const client = new SquishClient({ dataDir: testDataDir });
    const results = await client.search('roadmap');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const logged = getAclLog('acl_would_filter');
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(logged.some((e) => e.memoryId === 'mem-wired-private')).toBe(true);
  });

  test('enforce mode: SDK search filters disallowed results', async () => {
    process.env.SQUISH_ACL_ENFORCE = 'true';

    const client = new SquishClient({ dataDir: testDataDir });
    const results = await client.search('notes', { limit: 50 });
    const ids = results.map((r: any) => r.memory?.id);
    expect(ids).not.toContain('mem-wired-private');
    expect(ids).toContain('mem-wired-open');

    delete process.env.SQUISH_ACL_ENFORCE;
  });
});
