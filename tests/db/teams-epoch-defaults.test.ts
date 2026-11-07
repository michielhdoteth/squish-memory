/**
 * The five team timestamp columns, end to end.
 *
 * db/migrations/teams.ts:18,19,36,57,76 and db/drizzle/schema-sqlite.ts:1430,
 * 1431, 1444, 1461, 1476 both declared the five team timestamp columns with
 * `CURRENT_TIMESTAMP`. On a real bootstrapped database that stores TEXT, because
 * drizzle-orm 0.45.2 inlines the declared default into every INSERT rather than
 * deferring to the DDL default
 * (node_modules/drizzle-orm/sqlite-core/dialect.js:364-367). TEXT in an epoch
 * column defeats every comparison predicate (SQLite sorts TEXT after every
 * INTEGER) and reads back as an Invalid Date, not null, because
 * `SQLiteTimestamp.mapFromDriverValue` is `new Date(value * 1e3)`.
 *
 * Both layers now name `(strftime('%s','now'))`. These tests assert that from
 * both sides: the DDL default read through PRAGMA, and the storage class of what
 * a real drizzle insert actually stores. The suite previously ran with the DDL
 * half green and the drizzle half as `test.todo` plus three tests that pinned the
 * broken behaviour; all of those now assert the corrected behaviour instead, so
 * a reversion is caught by name.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';

import { eq } from 'drizzle-orm';
import { closeAllDbs, getDb, resetDb } from '../../db/index.js';
import { teams, team_members, team_invitations, team_shares } from '../../db/drizzle/schema-sqlite.js';

const testDataDir = join(
  tmpdir(),
  `squish-teams-epoch-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

interface RawSqlite {
  prepare: (sql: string) => { all: () => unknown[]; run: () => unknown; get: () => unknown };
  exec: (sql: string) => unknown;
}

let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let raw: RawSqlite;

beforeAll(async () => {
  savedDataDir = process.env.SQUISH_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  resetDb();
  const db = await getDb();
  raw = (db as unknown as { $client: RawSqlite }).$client;

  // Foreign-key parents for the inserts below.
  raw
    .prepare("INSERT INTO users (id, email) VALUES ('teams-epoch-user','teams-epoch@example.invalid')")
    .run();
  raw
    .prepare("INSERT INTO memories (id, type, content, tokens_estimate) VALUES ('teams-epoch-mem','fact','m',0)")
    .run();
  raw
    .prepare("INSERT INTO teams (id, name, slug) VALUES ('teams-epoch-team','Epoch Team','epoch-team')")
    .run();
});

afterAll(async () => {
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  await closeAllDbs();
  resetDb();
});

/**
 * DDL defaults are read from a live bootstrapped database with PRAGMA
 * table_info, never from the source text: a regex-based DDL lookup silently
 * missed knowledge_edges.created_at before, and the same failure mode applies
 * to any default that only appears on one line of a multi-line CREATE TABLE.
 */
function ddlDefault(table: string, column: string): string | null {
  const info = raw
    .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all() as Array<{ name: string; dflt_value: string | null }>;
  const found = info.find((c) => c.name === column);
  expect(found, `${table}.${column} must exist in a bootstrapped database`).toBeDefined();
  return found!.dflt_value;
}

describe('teams DDL stores epoch seconds, not a TEXT datetime', () => {
  test('all four team tables exist in a bootstrapped database', () => {
    for (const table of ['teams', 'team_members', 'team_invitations', 'team_shares']) {
      const row = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      expect(row, `${table} must be created by the migration chain`).toBeDefined();
    }
  });

  test.each([
    ['teams', 'created_at'],
    ['teams', 'updated_at'],
    ['team_members', 'joined_at'],
    ['team_invitations', 'created_at'],
    ['team_shares', 'created_at'],
  ])('%s.%s defaults to the epoch expression, not CURRENT_TIMESTAMP', (table, column) => {
    // PRAGMA reports the bare expression; db/migrations/teams.ts writes it
    // wrapped in one layer of parentheses, which is not a difference.
    const value = ddlDefault(table, column);
    expect(value, `${table}.${column} must not be CURRENT_TIMESTAMP`).not.toBe('CURRENT_TIMESTAMP');
    expect(value, `${table}.${column} DDL default`).toContain("strftime('%s','now')");
  });
});

describe('team timestamp columns written through drizzle', () => {
  /**
   * Mirrors the per-column pattern in tests/db/epoch-timestamp-defaults.test.ts:
   * a real drizzle insert omitting the column, then typeof() on the stored
   * value. The storage class has to be read back from the stored row - a bare
   * `typeof(strftime('%s','now'))` answers 'text' because the expression has no
   * column affinity context, which is the vacuous check to avoid.
   *
   * The 'text' branch is retained on purpose even though nothing calls it with
   * that class any more. It is the shape the defect produced
   * ('YYYY-MM-DD HH:MM:SS', which sorts after every INTEGER and so defeats every
   * epoch comparison), and it is what a reversion would fail against with a
   * legible message instead of a bare class mismatch.
   */
  async function assertStoredClass(
    table: string,
    columns: string[],
    expectedClass: 'integer' | 'text',
    insert: (db: Awaited<ReturnType<typeof getDb>>) => Promise<void>,
  ): Promise<void> {
    const db = await getDb();
    await insert(db);

    const projection = columns
      .map((c) => `${c}, typeof(${c}) AS typeof_${c}`)
      .join(', ');
    const row = raw
      .prepare(`SELECT ${projection} FROM ${table} ORDER BY rowid DESC LIMIT 1`)
      .get() as Record<string, unknown>;

    expect(row, `${table} row must exist`).toBeDefined();
    const nowSeconds = Date.now() / 1000;
    for (const column of columns) {
      expect(row[`typeof_${column}`], `${table}.${column} storage class`).toBe(expectedClass);
      if (expectedClass === 'integer') {
        expect(typeof row[column], `${table}.${column} JS type`).toBe('number');
        expect(
          Math.abs((row[column] as number) - nowSeconds),
          `${table}.${column} must be epoch seconds`,
        ).toBeLessThan(120);
      } else {
        expect(String(row[column]), `${table}.${column} TEXT datetime shape`).toMatch(
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // The drizzle declarations for these five columns now name the epoch
  // expression too (db/drizzle/schema-sqlite.ts:1430, 1431, 1444, 1461, 1476),
  // so both layers agree and every insert below stores epoch seconds.
  //
  // These were `test.todo` while the declarations still read
  // `default(sql`CURRENT_TIMESTAMP`)`. They are now live assertions: drizzle
  // inlines its declared default into every INSERT
  // (node_modules/drizzle-orm/sqlite-core/dialect.js:364-367), so the
  // declaration - not the DDL - decides the storage class, and a reversion to
  // CURRENT_TIMESTAMP turns these red again with the storage class named in the
  // failure message.
  // ---------------------------------------------------------------------

  test('teams.created_at and teams.updated_at store epoch seconds', async () => {
    await assertStoredClass('teams', ['created_at', 'updated_at'], 'integer', async (db) => {
      await db.insert(teams).values({ name: 'Epoch Team', slug: 'epoch-team-drizzle' });
    });
  });

  test('team_members.joined_at stores epoch seconds', async () => {
    await assertStoredClass('team_members', ['joined_at'], 'integer', async (db) => {
      await db.insert(team_members).values({
        teamId: 'teams-epoch-team',
        userId: 'teams-epoch-user',
        role: 'member',
      });
    });
  });

  test('team_invitations.created_at stores epoch seconds', async () => {
    await assertStoredClass('team_invitations', ['created_at'], 'integer', async (db) => {
      await db.insert(team_invitations).values({
        teamId: 'teams-epoch-team',
        email: 'invitee@example.invalid',
        code: 'teams-epoch-code',
      });
    });
  });

  test('team_shares.created_at stores epoch seconds', async () => {
    await assertStoredClass('team_shares', ['created_at'], 'integer', async (db) => {
      await db.insert(team_shares).values({
        memoryId: 'teams-epoch-mem',
        teamId: 'teams-epoch-team',
        sharedBy: 'teams-epoch-user',
      });
    });
  });

  test('a drizzle read of teams.created_at is a real Date, not an Invalid Date', async () => {
    // SQLiteTimestamp.mapFromDriverValue is `new Date(value * 1e3)`, so a TEXT
    // value read back as an Invalid Date (NaN) rather than null. This asserts the
    // corrected half of the same fact.
    const db = await getDb();
    const rows = await db.select().from(teams).where(eq(teams.slug, 'epoch-team-drizzle'));
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN(rows[0].createdAt.getTime())).toBe(false);
    expect(Math.abs(rows[0].createdAt.getTime() - Date.now())).toBeLessThan(120_000);
  });

  test('a raw SQL insert relying only on the DDL default already stores epoch seconds', async () => {
    // Proves the DDL half of the fix is complete and independently correct:
    // bypass drizzle, omit the column, and let the corrected DDL default fire.
    // This is the path db/migrations/knowledge.ts uses when it copies created_at
    // across, and it is the part this work owns.
    raw
      .prepare("INSERT INTO teams (id, name, slug) VALUES ('teams-raw','Raw Team','teams-raw-slug')")
      .run();
    const row = raw
      .prepare("SELECT created_at, typeof(created_at) AS t FROM teams WHERE id='teams-raw'")
      .get() as { created_at: unknown; t: string };
    expect(row.t, 'teams.created_at storage class via DDL default').toBe('integer');
    expect(typeof row.created_at).toBe('number');
    expect(Math.abs((row.created_at as number) - Date.now() / 1000)).toBeLessThan(120);
  });

  test('none of these five drizzle declarations is CURRENT_TIMESTAMP any more', () => {
    // The five declarations that used to read `default(sql`CURRENT_TIMESTAMP`)`.
    // Read off the declaration objects, not off source text, so a reversion is
    // caught by this even if the source line is reformatted. Kept as a named
    // check rather than folded into the DDL describe block because it is the
    // drizzle side that decides the stored storage class: drizzle inlines the
    // declared default into every INSERT rather than deferring to the DDL.
    const formerlyBroken = [
      [teams.createdAt, 'teams.created_at'],
      [teams.updatedAt, 'teams.updated_at'],
      [team_members.joinedAt, 'team_members.joined_at'],
      [team_invitations.createdAt, 'team_invitations.created_at'],
      [team_shares.createdAt, 'team_shares.created_at'],
    ] as const;

    for (const [column, label] of formerlyBroken) {
      const declared = column.default;
      const text = declared && typeof declared === 'object' && 'toQuery' in declared
        ? (declared as { toQuery: (i: unknown) => { sql: string } }).toQuery({}).sql
        : String(declared);
      expect(text, `${label} must not be CURRENT_TIMESTAMP`).not.toBe('CURRENT_TIMESTAMP');
      expect(text, `${label} drizzle default`).toContain("strftime('%s','now')");
    }
  });

  test('a drizzle insert into every team table stores epoch seconds', async () => {
    // The end-to-end symptom, inverted. This is the path
    // db/team-adapter.ts createTeam() and addTeamMember() take, so it is the
    // assertion that matters to a caller rather than to the schema.
    await assertStoredClass('teams', ['created_at', 'updated_at'], 'integer', async (db) => {
      await db.insert(teams).values({ name: 'Symptom Team', slug: 'symptom-team' });
    });
    await assertStoredClass('team_members', ['joined_at'], 'integer', async (db) => {
      // A second user: team_members declares UNIQUE(team_id, user_id), so the
      // member row above already owns (teams-epoch-team, teams-epoch-user).
      raw
        .prepare("INSERT INTO users (id, email) VALUES ('teams-epoch-user-2','teams-epoch-2@example.invalid')")
        .run();
      await db.insert(team_members).values({
        teamId: 'teams-epoch-team',
        userId: 'teams-epoch-user-2',
        role: 'admin',
      });
    });
  });

  test('createTeam() returns a usable createdAt, not an Invalid Date', async () => {
    // End-to-end through the real adapter. Its prior form asserted the read was
    // an Invalid Date, which recorded the defect; that assertion is now wrong
    // and is inverted here rather than deleted.
    const { createTeam } = await import('../../db/team-adapter.js');
    const team = await createTeam({
      name: 'Adapter Team',
      slug: 'adapter-team',
      ownerId: 'teams-epoch-user',
    });

    expect(team.createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN(team.createdAt.getTime())).toBe(false);
    expect(Math.abs(team.createdAt.getTime() - Date.now())).toBeLessThan(120_000);
  });
});

