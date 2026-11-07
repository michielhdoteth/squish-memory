import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeAllDbs, getDb, resetDb } from '../../../db/index.js';
import { users } from '../../../db/drizzle/schema-sqlite.js';
import { requireTeamRole, TeamAuthorizationError } from '../../../core/acl/team-authorization.js';

const dataDir = join(tmpdir(), `squish-team-authorization-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let previousDataDir: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDataDir = process.env.SQUISH_DATA_DIR;
  previousDatabaseUrl = process.env.DATABASE_URL;
  mkdirSync(dataDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  resetDb();
  await getDb();
});

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = previousDataDir;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  await closeAllDbs();
  resetDb();
});

describe('team role authorization audit', () => {
  it('fails closed and records a minimized denial when membership storage is unavailable', async () => {
    const db = await getDb();
    const raw = (db as unknown as {
      $client: {
        exec: (sql: string) => void;
        prepare: (sql: string) => { all: () => Array<Record<string, string>> };
      };
    }).$client;
    await db.insert(users).values({ id: 'private-actor-id', externalId: 'private-actor-id' });
    raw.exec('DROP TABLE team_members');

    await expect(requireTeamRole({
      actorId: 'private-actor-id',
      teamId: 'private-team-id',
      action: 'invite',
      roles: ['owner', 'admin'],
    })).rejects.toBeInstanceOf(TeamAuthorizationError);

    const rows = raw.prepare(
      'SELECT actor_hash, team_hash, action, decision, reason FROM team_security_audit',
    ).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'invite',
      decision: 'deny',
      reason: 'membership_unavailable',
    });
    expect(rows[0]?.actor_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]?.team_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain('private-actor-id');
    expect(JSON.stringify(rows)).not.toContain('private-team-id');
  });
});
