/**
 * Task 2 guard: `knowledge_edges` has THREE separate CREATE TABLE definitions
 * in the tree and they must agree.
 *
 * Sites (all create the same table name, all `IF NOT EXISTS`, so whichever runs
 * first wins and the others silently do nothing):
 *   1. db/bootstrap.ts                     - full-schema replay, every connect
 *   2. db/schema-ddl.ts                    - createSingleTable, repair path
 *   3. core/knowledge/knowledge-crud.ts    - ensureKnowledgeTables, lazy fallback
 *
 * A fourth, db/migrations/knowledge.ts, declares the same table inline and is
 * compared here too so its drift is visible.
 *
 * The defect class this guards is the `maintenance_job_history` one: a column
 * the drizzle declaration names that a DDL does not create. drizzle inlines the
 * INSERT column list, so the missing column surfaces as "no such column" on
 * write and `squish_recall` fails outright - not as a soft default mismatch.
 *
 * Method: the DDL text is located in the source, then HANDED TO SQLITE and read
 * back with PRAGMA table_info / index_list. Defaults are never compared as
 * strings from the source. That matters twice over: a regex lookup silently
 * missed knowledge_edges.created_at before, and `strftime()` evaluated without a
 * column context returns TEXT, so any `typeof(strftime(...))` style check gives
 * the wrong answer and passes vacuously.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { getTableColumns } from 'drizzle-orm';

import * as sqliteSchema from '../../db/drizzle/schema-sqlite.js';

const REPO = join(import.meta.dir, '..', '..');

interface SiteSpec {
  name: string;
  file: string;
  /** Anchor that the CREATE TABLE statement follows in that file. */
  anchor: string;
  /** Lines to scan forward from the CREATE TABLE for index statements. */
  indexScanLines: number;
}

const SITES: SiteSpec[] = [
  { name: 'db/bootstrap.ts', file: 'db/bootstrap.ts', anchor: "CREATE TABLE IF NOT EXISTS knowledge_edges (", indexScanLines: 9 },
  { name: 'db/schema-ddl.ts', file: 'db/schema-ddl.ts', anchor: "CREATE TABLE IF NOT EXISTS knowledge_edges (", indexScanLines: 9 },
  { name: 'core/knowledge/knowledge-crud.ts', file: 'core/knowledge/knowledge-crud.ts', anchor: "CREATE TABLE IF NOT EXISTS knowledge_edges (", indexScanLines: 5 },
  { name: 'db/migrations/knowledge.ts', file: 'db/migrations/knowledge.ts', anchor: "CREATE TABLE IF NOT EXISTS knowledge_edges (", indexScanLines: 6 },
];

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SiteFacts {
  site: string;
  columns: ColumnInfo[];
  columnNames: string[];
  indexNames: string[];
}

const DRIZZLE_COLUMN_NAMES: string[] = Object.values(
  getTableColumns(sqliteSchema.knowledgeEdges)
)
  .map((c) => c.name)
  .sort();

/**
 * Every column the drizzle declaration carries a default for.
 *
 * drizzle-orm 0.45.2 inlines the declared default into every INSERT column list
 * (node_modules/drizzle-orm/sqlite-core/dialect.js:364-367), so the STORAGE
 * CLASS of the drizzle default is what a write actually produces - and it must
 * match the DDL default, not merely be spelled similarly.
 */
const DRIZZLE_DEFAULTS: Record<string, string> = Object.fromEntries(
  Object.values(getTableColumns(sqliteSchema.knowledgeEdges)).map((c) => {
    const d = (c as { default?: unknown }).default;
    const text =
      d && typeof d === 'object' && 'toQuery' in d
        ? (d as { toQuery: (i: unknown) => { sql: string } }).toQuery({}).sql
        : d === undefined || d === null
          ? null
          : String(d);
    return [c.name, text];
  }) as Array<[string, string | null]>
);

/**
 * SQLite's storage class for an expression AS STORED in a column of the given
 * declared affinity type. The affinity context is the point: without it
 * `strftime('%s','now')` answers 'text'.
 */
function storageClass(db: Database, expression: string, declaredType: string): string {
  const table = `ke_probe_${Math.random().toString(36).slice(2, 10)}`;
  db.exec(`CREATE TABLE ${table} (c ${declaredType})`);
  try {
    db.exec(`INSERT INTO ${table} (c) VALUES (${expression})`);
    const row = db.prepare(`SELECT typeof(c) AS t FROM ${table}`).get() as { t: string };
    return row.t;
  } finally {
    db.exec(`DROP TABLE ${table}`);
  }
}

let facts: Map<string, SiteFacts>;

/**
 * Collect the `CREATE [UNIQUE] INDEX ... knowledge_edges ...` statements that
 * follow the CREATE TABLE at `from` in `source`.
 *
 * Index statements in these files appear inside template literals and wrap
 * across lines, so this scans by balanced parens from the keyword rather than
 * by line prefix. The scan stops at the next CREATE TABLE so a neighbouring
 * table's indexes cannot be attributed to this one.
 */
function extractIndexStatements(source: string, from: number): string[] {
  const statements: string[] = [];
  const nextTable = source.indexOf('CREATE TABLE', from);
  const limit = nextTable === -1 ? source.length : nextTable;

  const pattern = /CREATE (UNIQUE )?INDEX(?:\s+IF NOT EXISTS)?\s+knowledge_edges/g;
  pattern.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null && match.index < limit) {
    let depth = 0;
    let close = -1;
    for (let i = source.indexOf('(', match.index); i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;
    statements.push(source.slice(match.index, close + 1));
    pattern.lastIndex = close + 1;
  }
  return statements;
}

/**
 * Slice out the CREATE TABLE statement and the index statements that follow it.
 *
 * The source is used only to LOCATE the SQL. Every fact asserted below is read
 * back out of SQLite.
 */
function statementsOf(site: SiteSpec): { create: string; indexes: string[] } {
  const source = readFileSync(join(REPO, site.file), 'utf8');
  const anchorAt = source.indexOf(site.anchor);
  expect(anchorAt, `${site.file} must contain ${site.anchor}`).toBeGreaterThan(-1);

  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('(', anchorAt); i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, `${site.file} CREATE TABLE must close`).toBeGreaterThan(-1);

  return {
    create: source.slice(anchorAt, end + 1),
    indexes: extractIndexStatements(source, end + 1),
  };
}

/**
 * Execute one site's full definition (table plus its indexes) against a fresh
 * in-memory database.
 */
function build(site: SiteSpec): Database {
  const { create, indexes } = statementsOf(site);
  const db = new Database(':memory:');
  db.exec(create);
  for (const stmt of indexes) db.exec(stmt);
  return db;
}

/**
 * Pull the CREATE TABLE for knowledge_edges out of a source file and any index
 * statements that immediately follow it, then execute both against a fresh
 * in-memory database.
 */
function materialize(site: SiteSpec): SiteFacts {
  const db = build(site);
  try {
    const columns = db
      .prepare(`PRAGMA table_info("knowledge_edges")`)
      .all() as ColumnInfo[];
    const indexNames = (
      db.prepare(`PRAGMA index_list("knowledge_edges")`).all() as Array<{ name: string }>
    )
      .map((r) => r.name)
      .sort();

    return {
      site: site.name,
      columns,
      columnNames: columns.map((c) => c.name).sort(),
      indexNames,
    };
  } finally {
    db.close();
  }
}

/**
 * Named non-unique indexes every site should provide.
 *
 * The two `_kind_` indexes are the ones that actually drifted: declared in
 * db/bootstrap.ts and db/drizzle/schema-sqlite.ts:987,989 but originally absent
 * from core/knowledge/knowledge-crud.ts.
 *
 * Uniqueness is deliberately NOT in this list - see the functional uniqueness
 * test below. db/migrations/knowledge.ts expresses it as an inline
 * `UNIQUE(from_id, from_kind, to_id, to_kind, edge_type)` table constraint,
 * which SQLite satisfies through a `sqlite_autoindex_*` entry instead of the
 * named `knowledge_edges_unique` index. Both spellings enforce the same rule, so
 * asserting the name would reject a correct definition.
 */
const REQUIRED_INDEXES = [
  'knowledge_edges_from_idx',
  'knowledge_edges_from_kind_idx',
  'knowledge_edges_to_idx',
  'knowledge_edges_to_kind_idx',
  'knowledge_edges_type_idx',
];

/** The uniqueness rule the drizzle declaration relies on (:990). */
const EDGE_UNIQUE_SQL =
  'INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, valid_from, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

beforeAll(() => {
  facts = new Map();
  for (const site of SITES) facts.set(site.name, materialize(site));
});

describe('every knowledge_edges definition creates the table', () => {
  test.each(SITES.map((s) => s.name))('%s defines knowledge_edges', (name) => {
    const f = facts.get(name)!;
    expect(f.columnNames.length, `${name} must create at least one column`).toBeGreaterThan(0);
    expect(f.columnNames, `${name} must create id`).toContain('id');
  });
});

describe('the three knowledge_edges definitions agree on their column set', () => {
  test('every site creates exactly the columns the drizzle declaration names', () => {
    for (const site of SITES) {
      const f = facts.get(site.name)!;
      const missing = DRIZZLE_COLUMN_NAMES.filter((c) => !f.columnNames.includes(c));
      const extra = f.columnNames.filter((c) => !DRIZZLE_COLUMN_NAMES.includes(c));
      expect(missing, `${site.name} is missing columns the drizzle declaration names`).toEqual([]);
      expect(extra, `${site.name} creates columns drizzle does not declare`).toEqual([]);
    }
  });

  test('all sites create an identical column set', () => {
    const [first, ...rest] = SITES.map((s) => facts.get(s.name)!);
    for (const f of rest) {
      expect(
        f.columnNames,
        `${f.site} column set must match ${first.site}`,
      ).toEqual(first.columnNames);
    }
  });

  test('all sites declare the same nullability and primary key per column', () => {
    const [first, ...rest] = SITES.map((s) => facts.get(s.name)!);
    const shape = (f: SiteFacts) =>
      f.columns.map((c) => `${c.name}:${c.type}:notnull=${c.notnull}:pk=${c.pk}`).join('|');
    for (const f of rest) {
      expect(shape(f), `${f.site} column shape must match ${first.site}`).toBe(shape(first));
    }
  });

  test('all sites create the non-unique indexes the drizzle declaration names', () => {
    for (const site of SITES) {
      const f = facts.get(site.name)!;
      const provided = new Set(f.indexNames.filter((i) => !i.startsWith('sqlite_autoindex_')));
      const missing = REQUIRED_INDEXES.filter((i) => !provided.has(i));
      expect(missing, `${site.name} must create these knowledge_edges indexes`).toEqual([]);
    }
  });

  test('all sites enforce uniqueness over the edge endpoints plus edge type', () => {
    // Checked by attempting a duplicate insert rather than by index name, so an
    // inline UNIQUE table constraint and a named unique index both pass. This is
    // the guarantee db/drizzle/schema-sqlite.ts:990 relies on when it calls a
    // duplicate identical edge "conflict-safe at the storage constraint level"
    // (docs/unified-memory-contract.md:40).
    for (const site of SITES) {
      const db = build(site);
      try {
        db.exec(EDGE_UNIQUE_SQL, ['a1', 'k1', 'knowledge', 'k2', 'knowledge', 'relates_to', 100, 100]);

        let duplicateRejected = false;
        try {
          db.exec(EDGE_UNIQUE_SQL, ['a2', 'k1', 'knowledge', 'k2', 'knowledge', 'relates_to', 100, 100]);
        } catch {
          duplicateRejected = true;
        }
        expect(
          duplicateRejected,
          `${site.name} must reject a duplicate (from_id, from_kind, to_id, to_kind, edge_type)`,
        ).toBe(true);

        // A later recorded version of the same edge is legal and can carry a corrected validity interval.
        db.exec(EDGE_UNIQUE_SQL, ['a3', 'k1', 'knowledge', 'k2', 'knowledge', 'relates_to', 100, 200]);
        // A different edge_type between the same endpoints is also a legal second relation.
        db.exec(EDGE_UNIQUE_SQL, ['a4', 'k1', 'knowledge', 'k2', 'knowledge', 'depends_on', 100, 100]);
        const count = db
          .prepare('SELECT COUNT(*) AS c FROM knowledge_edges')
          .get() as { c: number };
        expect(count.c, `${site.name} must preserve distinct temporal versions and relation types`).toBe(3);
      } finally {
        db.close();
      }
    }
  });
});

describe('knowledge_edges.created_at defaults to epoch seconds at every site', () => {
  test('every site stores an INTEGER, not a TEXT datetime', () => {
    for (const site of SITES) {
      const f = facts.get(site.name)!;
      const createdAt = f.columns.find((c) => c.name === 'created_at');
      expect(createdAt, `${site.name} must create created_at`).toBeDefined();
      expect(createdAt!.type, `${site.name} created_at must be INTEGER`).toBe('INTEGER');
      expect(createdAt!.notnull, `${site.name} created_at must be NOT NULL`).toBe(1);
      expect(createdAt!.dflt_value, `${site.name} created_at must have a default`).toBeTruthy();
      expect(
        createdAt!.dflt_value,
        `${site.name} created_at must not default to CURRENT_TIMESTAMP`,
      ).not.toBe('CURRENT_TIMESTAMP');
    }
  });

  test('every DDL default has the same storage class as the drizzle default', () => {
    const drizzleDefault = DRIZZLE_DEFAULTS['created_at'];
    expect(drizzleDefault, 'drizzle must declare a created_at default').toBeTruthy();

    const db = new Database(':memory:');
    try {
      const drizzleClass = storageClass(db, drizzleDefault!, 'INTEGER');
      expect(drizzleClass, 'drizzle created_at default must store an integer').toBe('integer');

      for (const site of SITES) {
        const f = facts.get(site.name)!;
        const ddlDefault = f.columns.find((c) => c.name === 'created_at')!.dflt_value!;
        expect(
          storageClass(db, ddlDefault, 'INTEGER'),
          `${site.name} created_at DDL default must store the same class as drizzle`,
        ).toBe(drizzleClass);
      }
    } finally {
      db.close();
    }
  });

  test('a row written into a table from each site stores epoch seconds', () => {
    // End-to-end: create the table from the site's own DDL, insert without
    // created_at, and read typeof() off the stored row.
    for (const site of SITES) {
      const db = build(site);
      try {
        // Insert omitting created_at so the DDL default fires. This is the
        // raw-SQL path; the drizzle path is covered by
        // tests/db/epoch-timestamp-defaults.test.ts.
        db.exec(
          `INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type) VALUES ('e1','k1','knowledge','k2','knowledge','relates_to')`,
        );
        const row = db
          .prepare("SELECT created_at, typeof(created_at) AS t FROM knowledge_edges WHERE id='e1'")
          .get() as { created_at: unknown; t: string };
        expect(row.t, `${site.name} stored created_at storage class`).toBe('integer');
        expect(typeof row.created_at, `${site.name} stored created_at JS type`).toBe('number');
        expect(
          Math.abs((row.created_at as number) - Date.now() / 1000),
          `${site.name} created_at must be epoch seconds`,
        ).toBeLessThan(120);
      } finally {
        db.close();
      }
    }
  });
});

describe('suite wiring', () => {
  test('drizzle still declares knowledge_edges with the expected shape', () => {
    // If drizzle drops or renames a column, the "no missing column" assertions
    // would silently weaken, so pin the declaration itself.
    expect(DRIZZLE_COLUMN_NAMES).toEqual([
      'created_at',
      'edge_type',
      'from_id',
      'from_kind',
      'id',
      'metadata',
      'recorded_at',
      'recorded_to',
      'to_id',
      'to_kind',
      'valid_from',
      'valid_to',
      'weight',
    ]);
  });

  test('the sweep covered every site the brief names', () => {
    expect([...facts.keys()]).toEqual(SITES.map((s) => s.name));
  });
});
