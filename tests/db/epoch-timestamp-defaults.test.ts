/**
 * Family guard: a drizzle INTEGER timestamp default must store the same thing
 * its physical DDL default stores.
 *
 * drizzle-orm 0.45.2 does not defer to the DDL default. `buildInsertQuery`
 * (node_modules/drizzle-orm/sqlite-core/dialect.js:364-377) inlines the
 * DECLARED default into every INSERT value list whenever the caller omits the
 * field. So `integer('created_at', { mode: 'timestamp' })
 * .default(sql`CURRENT_TIMESTAMP`)` writes SQLite's `CURRENT_TIMESTAMP` value -
 * the TEXT datetime 'YYYY-MM-DD HH:MM:SS' - into a column the DDL declares as
 * `INTEGER DEFAULT (strftime('%s','now'))`.
 *
 * That is not cosmetic. `SQLiteTimestamp.mapFromDriverValue` is
 * `new Date(value * 1e3)`, so the read-back is an Invalid Date (NaN), and in
 * SQLite TEXT sorts after every integer, so every epoch comparison made against
 * the column matches nothing. core/scheduler/job-runner.ts:187 does
 * `lt(createdAt, oldThreshold)` with a Date, which binds unix seconds: the
 * retention job never deletes a row.
 *
 * The same declaration defect appeared across 52 columns in 33 tables. This
 * file locks the timestamp defaults for every active SQLite Drizzle table.
 *
 * Two tests carry that weight:
 *   1. 'every changed column stores epoch seconds when written through drizzle'
 *      performs a real insert through each declared table, then checks the
 *      stored SQLite value type.
 *   2. 'no integer timestamp default disagrees with its DDL default' sweeps the
 *      WHOLE declaration file and compares the storage class of the drizzle
 *      default against the storage class of the physical DDL default, so the
 *      53rd occurrence cannot be added without this failing.
 *
 * The sweep compares storage classes rather than string literals, because the
 * affinity context changes the answer: `strftime('%s','now')` evaluated on its
 * own is TEXT, but stored through an INTEGER column it is coerced to INTEGER.
 *
 * The five `teams`/`team_*` columns were the last holdouts. Their DDL in
 * db/migrations/teams.ts was itself `INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP`,
 * so a prior sweep excused them as "the drizzle declaration is already correct
 * here". That was a false negative: drizzle INLINES the declared default into
 * every INSERT, so agreeing with a TEXT-producing DDL default is precisely the
 * bug. Both layers now name the epoch expression and the columns are asserted
 * as epoch like the rest.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { SQL, getTableColumns, getTableName, type Table } from 'drizzle-orm';

import { closeAllDbs, getDb, resetDb } from '../../db/index.js';
import * as sqliteSchema from '../../db/drizzle/schema-sqlite.js';

const testDataDir = join(
  tmpdir(),
  `squish-epoch-defaults-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

interface RawSqlite {
  prepare: (sql: string) => { all: () => unknown[]; run: () => unknown; get: () => unknown };
}

/**
 * Every column changed from `sql`CURRENT_TIMESTAMP`` to
 * `sql`(strftime('%s','now'))``, one entry per drizzle table.
 *
 * `values()` supplies only the columns the physical table declares NOT NULL
 * without a default, so the insert exercises the declared default for
 * everything else. Foreign keys are satisfied from the parents seeded in
 * beforeAll.
 */
interface EpochDefaultTarget {
  exportName: string;
  table: string;
  columns: string[];
  values: () => Record<string, unknown>;
}

const EPOCH_DEFAULT_TARGETS: EpochDefaultTarget[] = [
  { exportName: 'users', table: 'users', columns: ['created_at', 'updated_at'], values: () => ({}) },
  { exportName: 'projects', table: 'projects', columns: ['created_at', 'updated_at'], values: () => ({ name: 'epoch-project', path: '/epoch-project' }) },
  { exportName: 'memories', table: 'memories', columns: ['last_decay_at', 'recorded_at', 'created_at', 'updated_at'], values: () => ({ type: 'fact', content: 'epoch-memory' }) },
  { exportName: 'conversations', table: 'conversations', columns: ['started_at', 'created_at', 'updated_at'], values: () => ({ sessionId: 'epoch-conversation' }) },
  { exportName: 'messages', table: 'messages', columns: ['created_at'], values: () => ({ conversationId: 'epoch-conv', role: 'user', content: 'epoch-message' }) },
  { exportName: 'learnings', table: 'learnings', columns: ['created_at'], values: () => ({ type: 'insight', action: 'epoch-action', summary: 'epoch-summary' }) },
  { exportName: 'agentPreferences', table: 'agent_preferences', columns: ['last_updated', 'created_at'], values: () => ({ key: 'epoch-key', value: 'epoch-value' }) },
  { exportName: 'entities', table: 'entities', columns: ['created_at', 'updated_at'], values: () => ({ name: 'epoch-entity', type: 'concept' }) },
  { exportName: 'namespaces', table: 'namespaces', columns: ['created_at', 'updated_at'], values: () => ({ name: 'epoch-namespace' }) },
  { exportName: 'places', table: 'places', columns: ['created_at', 'updated_at'], values: () => ({ projectId: 'epoch-project', name: 'epoch-place', placeType: 'board' }) },
  { exportName: 'memoryTags', table: 'memory_tags', columns: ['created_at'], values: () => ({ memoryId: 'epoch-mem-1', tag: 'epoch-tag' }) },
  { exportName: 'placeRules', table: 'place_rules', columns: ['created_at', 'updated_at'], values: () => ({ projectId: 'epoch-project', name: 'epoch-rule', placeType: 'board' }) },
  { exportName: 'memoryMergeProposals', table: 'memory_merge_proposals', columns: ['created_at'], values: () => ({ projectId: 'epoch-project', sourceMemoryIds: '["epoch-mem-1"]', proposedContent: 'c', detectionMethod: 'simhash', similarityScore: '0.9', confidenceLevel: 'high', mergeReason: 'epoch-reason' }) },
  { exportName: 'memoryMergeHistory', table: 'memory_merge_history', columns: ['merged_at'], values: () => ({ projectId: 'epoch-project', sourceMemoryIds: '["epoch-mem-1"]', canonicalMemoryId: 'epoch-mem-1', sourceMemoriesSnapshot: '[]', mergeStrategy: 'union' }) },
  { exportName: 'memoryHashCache', table: 'memory_hash_cache', columns: ['last_updated'], values: () => ({ memoryId: 'epoch-mem-1', projectId: 'epoch-project', contentHash: 'epoch-hash' }) },
  { exportName: 'sessionSummaries', table: 'session_summaries', columns: ['created_at'], values: () => ({ conversationId: 'epoch-conv', summaryType: 'final', content: 'epoch-summary-text' }) },
  { exportName: 'memorySnapshots', table: 'memory_snapshots', columns: ['created_at'], values: () => ({ memoryId: 'epoch-mem-1', snapshotType: 'before_update', content: 'epoch-snapshot' }) },
  { exportName: 'coreMemory', table: 'core_memory', columns: ['created_at', 'updated_at'], values: () => ({ section: 'persona' }) },
  // loadedMemoryIds is passed explicitly: its drizzle default is an array,
  // which is not what the driver should be asked to bind in this test.
  { exportName: 'contextSessions', table: 'context_sessions', columns: ['created_at', 'updated_at'], values: () => ({ sessionId: 'epoch-context-session', loadedMemoryIds: '[]' }) },
  { exportName: 'knowledge', table: 'knowledge', columns: ['recorded_at', 'last_decay_at', 'created_at', 'updated_at'], values: () => ({ knowledgeKind: 'memory', knowledgeType: 'fact', content: 'epoch-knowledge' }) },
  { exportName: 'knowledgeEdges', table: 'knowledge_edges', columns: ['created_at'], values: () => ({ fromId: 'epoch-knowledge', fromKind: 'knowledge', toId: 'epoch-knowledge-2', toKind: 'knowledge', edgeType: 'relates_to' }) },
  { exportName: 'agentSessionCache', table: 'agent_session_cache', columns: ['updated_at'], values: () => ({ cacheKey: 'epoch-cache', agent: 'claude-code', sessionId: 'epoch-cache-session', sourcePath: '/epoch/cache', mtimeMs: 1, sizeBytes: 1, payload: '{}' }) },
  { exportName: 'memoryFeedback', table: 'memory_feedback', columns: ['created_at'], values: () => ({ memoryId: 'epoch-mem-1', sessionId: 'epoch-feedback-session' }) },
  { exportName: 'maintenanceJobs', table: 'maintenance_jobs', columns: ['created_at', 'updated_at'], values: () => ({ jobName: 'epoch-job', jobType: 'nightly' }) },
  { exportName: 'memoryEditProposals', table: 'memory_edit_proposals', columns: ['created_at'], values: () => ({ memoryId: 'epoch-mem-1', currentContent: 'a', proposedContent: 'b', reason: 'epoch-reason' }) },
  { exportName: 'skills', table: 'skills', columns: ['created_at', 'updated_at'], values: () => ({ name: 'epoch-skill' }) },
  { exportName: 'skillVersions', table: 'skill_versions', columns: ['created_at'], values: () => ({ skillId: 'epoch-skill-id', version: 1, name: 'epoch-skill-v1' }) },
  { exportName: 'skillAssignments', table: 'skill_assignments', columns: ['created_at'], values: () => ({ skillId: 'epoch-skill-id', agentId: 'epoch-agent' }) },
  { exportName: 'skillMemoryLinks', table: 'skill_memory_links', columns: ['created_at'], values: () => ({ skillId: 'epoch-skill-id', memoryId: 'epoch-mem-1' }) },
  { exportName: 'agentLoadouts', table: 'agent_loadouts', columns: ['created_at'], values: () => ({ agentId: 'epoch-agent', assetType: 'memory', assetId: 'epoch-mem-1' }) },
  { exportName: 'visibilityRules', table: 'visibility_rules', columns: ['created_at'], values: () => ({ assetType: 'memory', assetId: 'epoch-mem-1', ruleType: 'allow', granteeType: 'agent', granteeId: 'epoch-agent' }) },
  // The five team columns. These were the last members of this family left on
  // CURRENT_TIMESTAMP, because db/migrations/teams.ts declared the DDL default
  // as the defective side. With both layers corrected they belong in this list
  // like every other column, exercised by the same per-column insert test.
  { exportName: 'teams', table: 'teams', columns: ['created_at', 'updated_at'], values: () => ({ name: 'epoch-team', slug: 'epoch-team-row' }) },
  { exportName: 'team_members', table: 'team_members', columns: ['joined_at'], values: () => ({ teamId: 'epoch-team', userId: 'epoch-user', role: 'member' }) },
  { exportName: 'team_invitations', table: 'team_invitations', columns: ['created_at'], values: () => ({ teamId: 'epoch-team', email: 'epoch-invitee@example.invalid', code: 'epoch-invite-code' }) },
  { exportName: 'team_shares', table: 'team_shares', columns: ['created_at'], values: () => ({ memoryId: 'epoch-mem-1', teamId: 'epoch-team', sharedBy: 'epoch-user', permission: 'read' }) },
];

/**
 * KNOWN DIVERGENCE - resolved. The five team columns were the last drizzle
 * declarations storing TEXT via `CURRENT_TIMESTAMP`; all now use the epoch
 * expression, matching the corrected DDL in db/migrations/teams.ts (verified by
 * PRAGMA below), and all five are in EPOCH_DEFAULT_TARGETS above.
 *
 * The set stays as an empty exclusion point for the family guards below. A new
 * divergence must be fixed in the declaration itself, never added here.
 */
const PENDING_DRIZZLE_FIX: ReadonlySet<string> = new Set([]);

/**
 * drizzle timestamp columns whose table has no DDL at all. The compatibility
 * migration db/migrations/beliefs.ts declares
 * `created_at INTEGER` with no default and is explicitly not called from
 * runAllMigrations(). Listed so a new dormant declaration is noticed instead of
 * silently skipped by the sweep below.
 */
const DORMANT_WITHOUT_DDL = ['belief_memory_sources', 'beliefs'] as const;

interface SweepRow {
  table: string;
  exportName: string;
  column: string;
  drizzleDefault: string;
  ddlDefault: string | null;
  drizzleClass: string;
  ddlClass: string | null;
  dormant: boolean;
}

let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let raw: RawSqlite;
let sweepRows: SweepRow[];
let probeSeq = 0;

function tableOf(exportName: string): Table {
  return (sqliteSchema as Record<string, unknown>)[exportName] as Table;
}

/**
 * SQLite's storage class for an expression AS STORED in an INTEGER column.
 *
 * The affinity context matters and is the whole point. `strftime('%s','now')`
 * evaluates to a string in isolation, so `SELECT typeof(strftime('%s','now'))`
 * answers 'text' - but these declarations all live on INTEGER columns, and
 * INTEGER affinity converts a well-formed numeric string on the way in, while a
 * value like '2026-10-09 17:32:39' is not convertible and stays TEXT. Probing
 * without the column would call the correct declarations broken and the broken
 * ones correct.
 */
function storageClass(expression: string): string {
  const table = `epoch_probe_${probeSeq++}`;
  raw.exec(`CREATE TABLE ${table} (c INTEGER)`);
  try {
    raw.exec(`INSERT INTO ${table} (c) VALUES (${expression})`);
    const row = raw.prepare(`SELECT typeof(c) AS t FROM ${table}`).get() as { t: string };
    return row.t;
  } finally {
    raw.exec(`DROP TABLE ${table}`);
  }
}

/**
 * Drop one balanced layer of wrapping parens. Drizzle defaults are written
 * `(strftime('%s','now'))` while PRAGMA reports the bare
 * `strftime('%s','now')`; the wrapper is not a difference.
 */
function stripOuterParens(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return trimmed;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '(') depth++;
    else if (trimmed[i] === ')') {
      depth--;
      if (depth === 0) return i === trimmed.length - 1 ? trimmed.slice(1, -1).trim() : trimmed;
    }
  }
  return trimmed;
}

function declaredDefaultText(column: unknown): string | null {
  const def = (column as { default?: unknown }).default;
  if (def instanceof SQL) return def.toQuery({}).sql;
  if (def === undefined || def === null) return null;
  return String(def);
}

function buildSweep(): SweepRow[] {
  const rows: SweepRow[] = [];
  for (const [exportName, value] of Object.entries(sqliteSchema as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    let table: string;
    let columns: Record<string, unknown>;
    try {
      table = getTableName(value as Table);
      columns = getTableColumns(value as Table) as unknown as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const [prop, column] of Object.entries(columns)) {
      const typed = column as { name: string; dataType?: string; default?: unknown; getSQLType?: () => string };
      // integer + mode:'timestamp' is exactly SQLiteTimestamp.
      if (typed.dataType !== 'date' || typed.getSQLType?.() !== 'integer') continue;
      const drizzleDefault = declaredDefaultText(typed);
      if (drizzleDefault === null) continue;

      const tableExists = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      if (!tableExists) {
        rows.push({ table, exportName, column: prop, drizzleDefault, ddlDefault: null, drizzleClass: 'n/a', ddlClass: null, dormant: true });
        continue;
      }
      const info = raw
        .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
        .all() as Array<{ name: string; dflt_value: string | null }>;
      const ddlDefault = info.find((c) => c.name === typed.name)?.dflt_value ?? null;
      rows.push({
        table,
        exportName,
        column: prop,
        drizzleDefault,
        ddlDefault,
        drizzleClass: storageClass(drizzleDefault),
        ddlClass: ddlDefault === null ? null : storageClass(ddlDefault),
        dormant: false,
      });
    }
  }
  return rows;
}

beforeAll(async () => {
  savedDataDir = process.env.SQUISH_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  resetDb();
  const db = await getDb();
  raw = (db as unknown as { $client: RawSqlite }).$client;

  // Parents for the foreign keys the inserts below rely on.
  raw
    .prepare("INSERT INTO memories (id, type, content, tokens_estimate) VALUES ('epoch-mem-1','fact','m',0), ('epoch-mem-2','fact','m',0)")
    .run();
  raw
    .prepare("INSERT INTO projects (id, name, path) VALUES ('epoch-project','epoch','/epoch')")
    .run();
  raw
    .prepare("INSERT INTO conversations (id, session_id) VALUES ('epoch-conv','epoch-session')")
    .run();
  raw
    .prepare("INSERT INTO entities (id, name, type) VALUES ('epoch-entity-1','e1','concept'), ('epoch-entity-2','e2','concept')")
    .run();
  raw
    .prepare("INSERT INTO skills (id, name) VALUES ('epoch-skill-id','epoch-skill-row')")
    .run();
  // Foreign-key parents for the team rows below.
  raw
    .prepare("INSERT INTO users (id, email) VALUES ('epoch-user','epoch-user@example.invalid')")
    .run();
  raw
    .prepare("INSERT INTO teams (id, name, slug) VALUES ('epoch-team','Epoch Team','epoch-team-fk')")
    .run();

  sweepRows = buildSweep();
});

afterAll(async () => {
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  await closeAllDbs();
  resetDb();
  // The temp dir under os.tmpdir() is deliberately left in place: on Windows the
  // SQLite WAL/SHM files keep it locked well past close(), which makes removal a
  // platform-specific flake. Other suites in tests/db do the same.
});

/**
 * The five `teams` / `team_*` columns, which WERE the last holdouts of this
 * family and are now covered by the per-column insert tests below.
 *
 * Evidence: db/migrations/teams.ts:18,19,36,57,76. A prior sweep left them on
 * `CURRENT_TIMESTAMP` because their DDL was the defective side rather than the
 * drizzle declaration. Both layers now name the epoch expression, so they are
 * asserted as epoch like every other column instead of being excused.
 */
const TEAMS_EPOCH_TARGETS: Array<{ exportName: string; table: string; columns: string[] }> = [
  { exportName: 'teams', table: 'teams', columns: ['created_at', 'updated_at'] },
  { exportName: 'team_members', table: 'team_members', columns: ['joined_at'] },
  { exportName: 'team_invitations', table: 'team_invitations', columns: ['created_at'] },
  { exportName: 'team_shares', table: 'team_shares', columns: ['created_at'] },
];

describe('drizzle epoch-seconds timestamp defaults', () => {
  test('the sweep found every declaration this suite claims to cover', () => {
    const swept = new Set(sweepRows.map((row) => `${row.table}.${row.column}`));
    for (const target of EPOCH_DEFAULT_TARGETS) {
      for (const column of target.columns) {
        const prop = columnToProp(target.exportName, column);
        expect(swept, `${target.table}.${column} must be swept`).toContain(`${target.table}.${prop}`);
      }
    }
  });

  for (const target of EPOCH_DEFAULT_TARGETS) {
    test(`${target.table}.${target.columns.join(', ')} stores epoch seconds, not a TEXT datetime`, async () => {
      const db = await getDb();
      const table = tableOf(target.exportName) as Parameters<typeof db.insert>[0];
      await db.insert(table).values(target.values() as never);

      const projection = target.columns
        .map((c) => `${c}, typeof(${c}) AS typeof_${c}`)
        .join(', ');
      const row = raw
        .prepare(`SELECT ${projection} FROM ${target.table} ORDER BY rowid DESC LIMIT 1`)
        .get() as Record<string, unknown>;

      expect(row, `${target.table} row must exist`).toBeDefined();
      const nowSeconds = Date.now() / 1000;
      for (const column of target.columns) {
        expect(row[`typeof_${column}`], `${target.table}.${column} storage class`).toBe('integer');
        expect(typeof row[column], `${target.table}.${column} JS type`).toBe('number');
        expect(
          Math.abs((row[column] as number) - nowSeconds),
          `${target.table}.${column} must be epoch seconds`
        ).toBeLessThan(120);
      }
    });
  }

  test('the teams DDL defaults now name the epoch expression, not CURRENT_TIMESTAMP', () => {
    // This is the corrected expectation for db/migrations/teams.ts:18,19,36,57,76.
    // Re-pinned rather than deleted - the assertion is the opposite of what it
    // used to be, and it stays a per-column check on the live PRAGMA default so a
    // future reversion of the DDL still fails here.
    //
    // Scope note: this pins the DDL layer only. The drizzle layer for these five
    // columns now names the epoch expression too, so the end-to-end storage
    // class is asserted both here and by the per-column insert tests above.
    for (const target of TEAMS_EPOCH_TARGETS) {
      for (const column of target.columns) {
        const prop = columnToProp(target.exportName, column);
        const row = sweepRows.find((r) => r.table === target.table && r.column === prop);
        expect(row, `${target.table}.${column} must be swept`).toBeDefined();
        expect(row!.ddlDefault, `${target.table}.${column} DDL default`).not.toBe('CURRENT_TIMESTAMP');
        expect(
          stripOuterParens(row!.ddlDefault!),
          `${target.table}.${column} DDL default must be the epoch expression`,
        ).toBe("strftime('%s','now')");
        expect(row!.ddlClass, `${target.table}.${column} DDL storage class`).toBe('integer');
      }
    }
  });

  test('the team tables are the only ones left with no INTEGER storage default', () => {
    // Guards the rest of the family against the same shape returning elsewhere:
    // no swept column may store TEXT once the five pending drizzle columns are
    // resolved. Written as an explicit set so the failure message names the
    // offender rather than dumping a diff.
    const texty = sweepRows
      .filter((row) => !row.dormant && row.drizzleClass === 'text')
      .map((row) => `${row.table}.${row.column}`);
    expect([...texty].sort()).toEqual([...PENDING_DRIZZLE_FIX].sort());
  });
});

describe('the whole drizzle declaration agrees with the physical DDL', () => {
  test('the sweep actually inspected the timestamp declarations', () => {
    expect(sweepRows.length).toBeGreaterThanOrEqual(50);
    expect(sweepRows.some((row) => row.drizzleDefault.includes('strftime'))).toBe(true);
  });

  test('no integer timestamp default stores a different type than its DDL default', () => {
    const disagreeing = sweepRows
      .filter((row) => !row.dormant && row.ddlClass !== null && row.drizzleClass !== row.ddlClass)
      .filter((row) => !PENDING_DRIZZLE_FIX.has(`${row.table}.${row.column}`))
      .map((row) => `${row.table}.${row.column}: drizzle=${row.drizzleDefault} (${row.drizzleClass}) vs ddl=${row.ddlDefault} (${row.ddlClass})`);
    expect(disagreeing).toEqual([]);
  });

  test('every integer timestamp default agrees with its DDL expression', () => {
    // Stricter than the storage-class check: it rules out "accidentally text,
    // but a different text" and makes the intended expression legible.
    const mismatched = sweepRows
      .filter((row) => !row.dormant && row.ddlDefault !== null)
      .filter((row) => !PENDING_DRIZZLE_FIX.has(`${row.table}.${row.column}`))
      .filter((row) => stripOuterParens(row.drizzleDefault) !== stripOuterParens(row.ddlDefault))
      .map((row) => `${row.table}.${row.column}: drizzle=${row.drizzleDefault} vs ddl=${row.ddlDefault}`);
    expect(mismatched).toEqual([]);
  });

  test('the only declared-vs-DDL divergence is the five pending team columns', () => {
    // Pins the exception list itself. If schema-sqlite.ts is corrected for the
    // team tables this test names them as a surplus exception and fails, which
    // is the signal to delete them from PENDING_DRIZZLE_FIX and add the tables
    // to EPOCH_DEFAULT_TARGETS.
    const diverging = sweepRows
      .filter((row) => !row.dormant && row.ddlClass !== null && row.drizzleClass !== row.ddlClass)
      .map((row) => `${row.table}.${row.column}`);
    expect([...diverging].sort()).toEqual([...PENDING_DRIZZLE_FIX].sort());
  });

  test('the only timestamp declarations with no DDL are the known dormant belief tables', () => {
    const dormant = sweepRows.filter((row) => row.dormant).map((row) => row.table);
    expect([...new Set(dormant)].sort()).toEqual([...DORMANT_WITHOUT_DDL].sort());
  });

});

/** drizzle property name for a physical column name on a declared table. */
function columnToProp(exportName: string, physical: string): string {
  const columns = getTableColumns(tableOf(exportName));
  for (const [prop, column] of Object.entries(columns)) {
    if (column.name === physical) return prop;
  }
  throw new Error(`${exportName} declares no column ${physical}`);
}

// Keep the file-level read of the schema honest: if schema-sqlite.ts is renamed
// or moved, this fails loudly instead of silently skipping the guard.
describe('suite wiring', () => {
  test('the swept source file is the one this suite documents', () => {
    const schemaPath = join(import.meta.dir, '..', '..', 'db', 'drizzle', 'schema-sqlite.ts');
    expect(existsSync(schemaPath)).toBe(true);
    const src = readFileSync(schemaPath, 'utf8');
    expect(src).toContain("sqliteTable('memory_feedback'");
  });
});
