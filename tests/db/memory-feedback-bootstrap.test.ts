/**
 * Regression guard: a fresh database must be able to create memory_feedback.
 *
 * `memory_feedback` was declared in db/drizzle/schema-sqlite.ts but no DDL
 * anywhere created the table. The declaration is live, not dormant:
 *   - core/memory/feedback-tracker.ts:6 imports it at module scope
 *   - core/memory/reinforcement.ts:236,267,300 dynamically imports that module,
 *     and is reached from core/runtime/squish-runtime.ts:1212 (the
 *     `squish_feedback` MCP path) and mcp/tools/skill.ts:232
 *   - core/scheduler/job-runner.ts:8 imports it directly for retention cleanup
 * Every insert and every select therefore failed with `no such table`, the same
 * class of defect as `maintenance_job_history.created_at`, which silently
 * discarded 100% of maintenance job history while probeSchemaHealth() said `ok`.
 *
 * The column set below is the drizzle declaration's, verified column by column
 * against every read and write in feedback-tracker.ts and job-runner.ts. It
 * must stay identical: drizzle-orm 0.45.x emits EVERY declared column in an
 * INSERT column list and in a field-less `select()`, so one column in one file
 * without a physical counterpart breaks every read and write on the table.
 *
 * KNOWN DEFECT, NOW FIXED: schema-sqlite.ts:1080 used to declare
 * `createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`)`.
 * drizzle inlines that default into every INSERT column list, so a row written
 * through the drizzle declaration stored the TEXT datetime 'YYYY-MM-DD HH:MM:SS'
 * into an INTEGER epoch column instead of the DDL's strftime('%s','now')
 * default, read back as an Invalid Date, and never matched the
 * job-runner.ts:187 retention predicate. The declaration was then swept
 * across all 52 affected columns. tests/db/epoch-timestamp-defaults.test.ts is
 * the guard for the whole family; the tests below are this table's own instance
 * of it.
 *
 * This file also carries two guards for the live table contract:
 *   1. a drizzle-declared column the DDL does not create breaks the insert, and
 *   2. an epoch-seconds `created_at` default, not a TEXT datetime, because
 *      job-runner.ts:186-187 compares it against a Date via drizzle `lt()`.
 *
 * db/schema-probe.ts now lists `memory_feedback` in REQUIRED_TABLES and all
 * eleven of its columns in REQUIRED_COLUMNS, so the table going missing is
 * detected. The direction that breaks healthy databases is guarded too: a probe
 * entry for a column the DDL does not create would make every correctly
 * bootstrapped database report `drifted` and turn every MCP tool into an error.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import { eq, getTableColumns, lt, type Table } from 'drizzle-orm';

import { memoryFeedback } from '../../db/drizzle/schema-sqlite.js';
import { probeSchemaHealth, REQUIRED_COLUMNS } from '../../db/schema-probe.js';

const testDataDir = join(
  tmpdir(),
  `squish-memory-feedback-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

/**
 * Physical column set, in DDL order, with the code that requires each one.
 * `memory_feedback` has no migration file, so the drizzle declaration is the
 * only specification; every entry below is cross-checked against it by the
 * "matches the drizzle declaration exactly" test rather than asserted by hand.
 */
const EXPECTED_COLUMNS = [
  'id',                        // primary key, drizzle $default randomUUID
  'memory_id',                 // feedback-tracker insert; NOT NULL, cascades from memories
  'session_id',                // feedback-tracker insert + the (memory_id, session_id) lookup at :92-95
  'conversation_id',           // nullable, set null on conversation delete
  'was_injected',              // feedback-tracker sets true; getMemoryFeedbackStats counts on it
  'was_referenced',            // feedback-tracker update; getMemoryFeedbackStats counts on it
  'reference_count',           // feedback-tracker insert 0, update to 1
  'retrieval_priority_delta',  // getMemoryFeedbackStats averages it
  'injected_at',               // feedback-tracker insert, Date
  'referenced_at',             // feedback-tracker update, Date or null
  'created_at',                // job-runner retention cleanup, lt() against a Date
] as const;

/** Indexes the drizzle declaration declares, named in schema-sqlite.ts:1082-1085. */
const EXPECTED_INDEXES = [
  'memory_feedback_memory_idx',
  'memory_feedback_session_idx',
  'memory_feedback_referenced_idx',
  'memory_feedback_conversation_idx',
] as const;

/**
 * The columns db/schema-probe.ts lists for this table. Asserted against the DDL
 * below so the entry can never outlive the column it names.
 */
const PROBE_REQUIRED_COLUMNS: readonly string[] = EXPECTED_COLUMNS;

interface RawSqlite {
  prepare: (sql: string) => { all: () => unknown[]; run: () => unknown; get: () => unknown };
}

let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let sqlite: RawSqlite;
let memorySeq = 0;

/** Insert a memory row directly so the memory_id foreign key is satisfiable. */
function seedMemory(label: string): string {
  memorySeq += 1;
  const id = `fb-mem-${label}-${memorySeq}`;
  sqlite
    .prepare("INSERT INTO memories (id, type, content, tokens_estimate) VALUES (?, 'fact', 'm', 0)")
    .run(id);
  return id;
}

beforeAll(async () => {
  savedDataDir = process.env.SQUISH_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  const { resetDb, getDb } = await import('../../db/index.js');
  resetDb();
  const db = await getDb();
  sqlite = (db as unknown as { $client: RawSqlite }).$client;
});

afterAll(async () => {
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  const { closeAllDbs, resetDb } = await import('../../db/index.js');
  await closeAllDbs();
  resetDb();
  // The temp dir under os.tmpdir() is deliberately left in place: on Windows the
  // SQLite WAL/SHM files keep it locked well past close(), which makes removal a
  // platform-specific flake. Other suites in tests/db do the same.
});

describe('memory_feedback bootstrap DDL', () => {
  test('a bootstrapped database has the memory_feedback table', () => {
    const table = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_feedback'")
      .get();
    expect(table).toBeDefined();
  });

  test('memory_feedback has exactly the expected column set', () => {
    const columns = sqlite.prepare('PRAGMA table_info("memory_feedback")').all().map((r) => r.name);
    expect(columns.slice().sort()).toEqual([...EXPECTED_COLUMNS].sort());
  });

  test('the physical column set matches the drizzle declaration exactly', () => {
    // The real guard. drizzle-orm emits every declared column in an INSERT
    // column list and in a field-less select(), so any column present in one
    // place and absent in the other is a runtime failure waiting to happen.
    const declared = Object.values(getTableColumns(memoryFeedback as Table)).map((c) => c.name);
    const physical = sqlite
      .prepare('PRAGMA table_info("memory_feedback")')
      .all()
      .map((r) => r.name);

    expect(physical.slice().sort()).toEqual([...declared].sort());
    expect(declared.slice().sort()).toEqual([...EXPECTED_COLUMNS].sort());
  });

  test('memory_feedback has the declared index set', () => {
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_feedback'")
      .all()
      .map((r) => r.name);
    for (const index of EXPECTED_INDEXES) {
      expect(rows).toContain(index);
    }
  });

  test('the declared foreign keys are present with their delete actions', () => {
    // schema-sqlite.ts:1071,1073 - memory_id cascades, conversation_id sets null.
    const rows = sqlite.prepare('PRAGMA foreign_key_list("memory_feedback")').all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const actual = rows.map((r) => ({ from: r.from, table: r.table, to: r.to, onDelete: r.on_delete }));
    expect(actual).toEqual(
      expect.arrayContaining([
        { from: 'memory_id', table: 'memories', to: 'id', onDelete: 'CASCADE' },
        { from: 'conversation_id', table: 'conversations', to: 'id', onDelete: 'SET NULL' },
      ])
    );
  });

  test('an insert and a field-less select through drizzle work on a fresh database', async () => {
    // This is the exact call recordInjection makes (feedback-tracker.ts:38-46).
    // It used to throw `no such table: memory_feedback` on every session.
    const { getDb } = await import('../../db/index.js');
    const db = await getDb();
    const memoryId = seedMemory('insert');
    const injectedAt = new Date('2026-03-04T05:06:07.000Z');

    await db.insert(memoryFeedback).values({
      memoryId,
      sessionId: 'session-insert',
      wasInjected: true,
      wasReferenced: false,
      referenceCount: 0,
      retrievalPriorityDelta: 0,
      injectedAt,
    });

    // getMemoryFeedbackStats does a field-less select (feedback-tracker.ts:176-178).
    const rows = await db.select().from(memoryFeedback);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.memoryId).toBe(memoryId);
    expect(row.sessionId).toBe('session-insert');
    expect(row.wasInjected).toBe(true);
    expect(row.wasReferenced).toBe(false);
    expect(row.injectedAt).toBeInstanceOf(Date);
    expect((row.injectedAt as Date).toISOString()).toBe(injectedAt.toISOString());
    // Every declared column must be readable, which is what a missing column
    // in the DDL breaks.
    expect(row.conversationId).toBeNull();
    expect(row.referencedAt).toBeNull();
    expect(row.retrievalPriorityDelta).toBe(0);
  });

  test('the update path from analyzeAndRecordFeedback works', async () => {
    // feedback-tracker.ts:99-107: update by id after the (memory_id,
    // session_id) lookup at :89-96.
    const { getDb } = await import('../../db/index.js');
    const db = await getDb();
    const memoryId = seedMemory('update');
    const referencedAt = new Date('2026-03-04T05:07:08.000Z');

    await db.insert(memoryFeedback).values({
      memoryId,
      sessionId: 'session-update',
      wasInjected: true,
      wasReferenced: false,
      referenceCount: 0,
      retrievalPriorityDelta: 0,
    });

    const existing = await db.select().from(memoryFeedback);
    const target = existing.find((r) => r.sessionId === 'session-update');
    expect(target).toBeDefined();

    await db
      .update(memoryFeedback)
      .set({
        wasReferenced: true,
        referenceCount: 1,
        retrievalPriorityDelta: 5,
        referencedAt,
      })
      .where(eq(memoryFeedback.id, target!.id));

    const [after] = await db.select().from(memoryFeedback).where(eq(memoryFeedback.id, target!.id));
    expect(after.wasReferenced).toBe(true);
    expect(after.referenceCount).toBe(1);
    expect(after.retrievalPriorityDelta).toBe(5);
    expect((after.referencedAt as Date).toISOString()).toBe(referencedAt.toISOString());
  });

  test('the job-runner retention predicate lt(createdAt, Date) matches a fresh row', async () => {
    // core/scheduler/job-runner.ts:182-187 deletes with lt() against a Date.
    // drizzle `mode: 'timestamp'` binds that Date as unix seconds, so
    // created_at must hold unix seconds. A TEXT datetime sorts after every
    // integer in SQLite, so the cleanup would silently match nothing and
    // feedback rows would accumulate forever.
    //
    // created_at is deliberately NOT passed: the declared default must supply it.
    // While schema-sqlite.ts:1080 defaulted it to CURRENT_TIMESTAMP this
    // predicate matched nothing and the row had to be written with an explicit
    // created_at for the test to say anything.
    const { getDb } = await import('../../db/index.js');
    const db = await getDb();
    const memoryId = seedMemory('retention');

    await db.insert(memoryFeedback).values({
      memoryId,
      sessionId: 'session-retention',
      wasInjected: true,
    });

    const future = new Date(Date.now() + 60_000);
    const matched = await db.select().from(memoryFeedback).where(lt(memoryFeedback.createdAt, future));
    expect(matched.map((r) => r.sessionId)).toContain('session-retention');

    const before = new Date(Date.now() - 60 * 60 * 1000);
    const tooOld = await db.select().from(memoryFeedback).where(lt(memoryFeedback.createdAt, before));
    expect(tooOld.map((r) => r.sessionId)).not.toContain('session-retention');
  });

  test('the drizzle declared default stores epoch seconds, not a TEXT datetime', async () => {
    // Same assertion as the DDL-default test above, but for the value drizzle
    // itself supplies: it inlines the declared default into the INSERT column
    // list rather than deferring to the DDL, so the declaration is a second,
    // independent source of the stored value.
    const { getDb } = await import('../../db/index.js');
    const db = await getDb();
    const memoryId = seedMemory('drizzle-default');

    await db
      .insert(memoryFeedback)
      .values({ memoryId, sessionId: 'session-drizzle-default' });

    const row = sqlite
      .prepare("SELECT created_at, typeof(created_at) AS t FROM memory_feedback WHERE session_id = ?")
      .get('session-drizzle-default') as { created_at: unknown; t: string };
    expect(row.t).toBe('integer');
    expect(typeof row.created_at).toBe('number');
    expect(Math.abs((row.created_at as number) - Date.now() / 1000)).toBeLessThan(120);

    // And the epoch default must survive the round trip through drizzle's
    // `mode: 'timestamp'` reader rather than becoming an Invalid Date.
    const [read] = await db
      .select()
      .from(memoryFeedback)
      .where(eq(memoryFeedback.sessionId, 'session-drizzle-default'));
    expect(read.createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN((read.createdAt as Date).getTime())).toBe(false);
    expect(Math.abs((read.createdAt as Date).getTime() - Date.now())).toBeLessThan(120_000);
  });

  test('the DDL created_at default is epoch seconds, not a TEXT datetime', () => {
    // Inserted as raw SQL so the assertion is about the DDL default itself and
    // not about whatever drizzle emits for the declared default.
    const memoryId = seedMemory('default');
    sqlite
      .prepare(
        `INSERT INTO memory_feedback (memory_id, session_id) VALUES (?, 'session-default')`
      )
      .run(memoryId);

    const row = sqlite
      .prepare('SELECT created_at FROM memory_feedback WHERE session_id = ?')
      .get('session-default') as { created_at: unknown };
    expect(typeof row.created_at).toBe('number');
    expect(Math.abs((row.created_at as number) - Date.now() / 1000)).toBeLessThan(120);
  });

  test('every column proposed for REQUIRED_COLUMNS is created by the DDL', () => {
    // Guards the direction that breaks healthy databases: a probe entry for a
    // column no DDL creates makes every correctly bootstrapped database report
    // `drifted` and turns every MCP tool into an error.
    const physical = new Set(
      sqlite
        .prepare('PRAGMA table_info("memory_feedback")')
        .all()
        .map((r) => (r as { name: string }).name)
    );
    for (const column of PROBE_REQUIRED_COLUMNS) {
      expect(physical.has(column), `memory_feedback.${column} must exist before probing it`).toBe(true);
    }
  });

  test('no REQUIRED_COLUMNS entry names a column the DDL does not create', () => {
    // Catches an over-broad entry landing for this table, whichever agent adds it.
    const physical = new Set(
      sqlite
        .prepare('PRAGMA table_info("memory_feedback")')
        .all()
        .map((r) => (r as { name: string }).name)
    );
    const overBroad = REQUIRED_COLUMNS.filter(
      (entry) => entry.table === 'memory_feedback' && !physical.has(entry.column)
    );
    expect(overBroad).toEqual([]);
  });

  test('a fresh database still probes as ok', async () => {
    const probe = await probeSchemaHealth();
    expect(probe.missingTables).toEqual([]);
    expect(probe.missingColumns).toEqual([]);
    expect(probe.status).toBe('ok');
  });
});

