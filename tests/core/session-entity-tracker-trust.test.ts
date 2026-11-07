import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRequestPrincipal } from '../../core/acl/request-principal.js';

const SESSION_ID = 'shared-session-id';
const OWNER = 'entity-session-owner';
const OTHER = 'entity-session-owner:other';

let dataDir: string;
let savedEnv: Record<string, string | undefined>;
let resetDb: typeof import('../../db/index.js').resetDb;
let closeAllDbs: typeof import('../../db/index.js').closeAllDbs;
let getDb: typeof import('../../db/index.js').getDb;
let trackEntityInSession: typeof import('../../core/session/entity-tracker.js').trackEntityInSession;
let resolveReference: typeof import('../../core/session/entity-tracker.js').resolveReference;
let getActiveSessionEntities: typeof import('../../core/session/entity-tracker.js').getActiveSessionEntities;
let clearSessionEntities: typeof import('../../core/session/entity-tracker.js').clearSessionEntities;
let persistSessionEntities: typeof import('../../core/session/entity-tracker.js').persistSessionEntities;
let loadSessionEntities: typeof import('../../core/session/entity-tracker.js').loadSessionEntities;

describe('strict session entity cache isolation', () => {
  beforeAll(async () => {
    savedEnv = {
      SQUISH_DATA_DIR: process.env.SQUISH_DATA_DIR,
      DATABASE_URL: process.env.DATABASE_URL,
      SQUISH_TRUST_POLICY: process.env.SQUISH_TRUST_POLICY,
      SQUISH_TRUSTED_CALLER_ID: process.env.SQUISH_TRUSTED_CALLER_ID,
    };
    dataDir = join(tmpdir(), `squish-session-entities-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    delete process.env.SQUISH_TRUSTED_CALLER_ID;

    ({ resetDb, closeAllDbs, getDb } = await import('../../db/index.js'));
    ({ trackEntityInSession, resolveReference, getActiveSessionEntities, clearSessionEntities,
      persistSessionEntities, loadSessionEntities } = await import('../../core/session/entity-tracker.js'));
    resetDb();
    const db = await getDb();
    const sqlite = (db as unknown as { $client: { exec(sql: string): void } }).$client;
    sqlite.exec(`
      INSERT INTO users (id) VALUES ('${OWNER}'), ('${OTHER}');
      INSERT INTO context_sessions (id, session_id, user_id, metadata)
      VALUES ('entity-session-row', '${SESSION_ID}', '${OWNER}', '{}');
      INSERT INTO context_sessions (id, session_id, metadata)
      VALUES ('entity-local-row', 'local-session-id', '{}');
    `);
  });

  afterAll(async () => {
    await withRequestPrincipal(OWNER, () => clearSessionEntities(SESSION_ID));
    await withRequestPrincipal(OTHER, () => clearSessionEntities(SESSION_ID));
    await closeAllDbs();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may briefly retain a closed SQLite handle. */ }
  });

  it('isolates same-ID cache state and persists only into the caller-owned session row', async () => {
    await withRequestPrincipal(OWNER, async () => {
      trackEntityInSession(SESSION_ID, 'alice', 'Alice', 'person');
      await persistSessionEntities(SESSION_ID);
    });

    await withRequestPrincipal(OTHER, async () => {
      expect(getActiveSessionEntities(SESSION_ID)).toHaveLength(0);
      clearSessionEntities(SESSION_ID);
      await loadSessionEntities(SESSION_ID);
      expect(getActiveSessionEntities(SESSION_ID)).toHaveLength(0);
      trackEntityInSession(SESSION_ID, 'bob', 'Bob', 'person');
      await persistSessionEntities(SESSION_ID);
    });

    await withRequestPrincipal(OWNER, async () => {
      clearSessionEntities(SESSION_ID);
      await loadSessionEntities(SESSION_ID);
      expect(getActiveSessionEntities(SESSION_ID).map((entity) => entity.entityName)).toEqual(['Alice']);
    });
  });

  it('rejects session cache access without an authenticated principal under strict trust', () => {
    expect(() => getActiveSessionEntities(SESSION_ID)).toThrow('authenticated transport principal');
    expect(() => trackEntityInSession(SESSION_ID, 'unauth', 'Unauthenticated', 'person')).toThrow('authenticated transport principal');
  });

  it('returns detached entity snapshots so consumers cannot mutate cached references', async () => {
    await withRequestPrincipal(OWNER, () => {
      const sessionId = 'detached-reference-snapshot';
      trackEntityInSession(sessionId, 'alice', 'Alice', 'person');
      const first = resolveReference(sessionId, 'alice');
      expect(first?.entityName).toBe('Alice');
      first!.entityName = 'Mallory';
      first!.lastMentionedAt.setTime(0);

      const next = resolveReference(sessionId, 'alice');
      expect(next?.entityName).toBe('Alice');
      expect(next!.lastMentionedAt.getTime()).toBeGreaterThan(0);
      clearSessionEntities(sessionId);
    });
  });

  it('keeps local-compatible persistence working and serializes session metadata', async () => {
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    try {
      trackEntityInSession('local-session-id', 'local-entity', 'Local Entity', 'concept');
      await persistSessionEntities('local-session-id');
      clearSessionEntities('local-session-id');
      await loadSessionEntities('local-session-id');
      expect(getActiveSessionEntities('local-session-id').map((entity) => entity.entityName)).toEqual(['Local Entity']);
    } finally {
      clearSessionEntities('local-session-id');
      process.env.SQUISH_TRUST_POLICY = 'strict';
    }
  });
});
