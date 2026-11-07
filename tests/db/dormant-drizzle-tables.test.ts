/**
 * Regression guard: the drizzle schema must not declare tables nothing reads.
 *
 * A drizzle-only declaration is not inert. drizzle-orm 0.45.x emits EVERY
 * declared column in INSERT column lists and in field-less `select()` calls, so
 * a declaration with no physical counterpart produces SQL that can never run:
 * `no such table`. Eleven declarations were classified dormant by a reference
 * sweep and removed; this test locks both directions so the same drift cannot
 * silently return, and so a table that live code really uses can never be
 * removed by the next sweep.
 *
 * `tests/db/drizzle-ddl-consistency.test.ts` guards the other direction - a
 * drizzle column that no DDL creates - by scoping itself to tables that exist
 * physically. This file guards declarations with no DDL at all.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName, type Table } from 'drizzle-orm';

import * as sqliteSchema from '../../db/drizzle/schema-sqlite.js';
import * as postgresSchema from '../../db/drizzle/schema-pg.js';

const PKG_ROOT = join(import.meta.dir, '..', '..');

/**
 * Declared, referenced by nothing outside db/drizzle/schema-sqlite.ts, and
 * physically absent from a bootstrapped database. Removed.
 *
 * `strategies`, `strategy_edges` and `strategy_belief_edges` were absorbed
 * into `knowledge` / `knowledge_edges` by db/migrations/knowledge.ts, which
 * still names them because it reads them as raw SQL during the one-time
 * migration. `belief_edges` is likewise an import-only legacy source; the
 * current belief adapter links through `knowledge_edges`. These are legacy
 * data paths, not live code references.
 */
const REMOVED_TABLE_NAMES = [
  'memory_layers',
  'search_traces',
  'audit_log_changes',
  'strategies',
  'strategy_edges',
  'strategy_belief_edges',
  'belief_edges',
  'memory_places',
  'lightweight_memory_indices',
  'context_paging_sessions',
] as const;

/** Drizzle export names deleted along with those declarations. */
const REMOVED_EXPORT_NAMES = [
  'memoryLayers',
  'searchTraces',
  'strategyEdges',
  'strategyBeliefEdges',
  'beliefEdges',
  'memoryPlaces',
  'lightweightMemoryIndices',
  'contextPagingSessions',
] as const;

/**
 * Declarations with no DDL that are nonetheless read by reachable code. These
 * must keep their declaration: removing one breaks the importing module.
 *
 * `memory_feedback` is imported at module scope by `core/memory/feedback-tracker.ts`,
 * which is reachable: `core/memory/reinforcement.ts` dynamically imports it and
 * is itself called from `squish-runtime.applyFeedback` (the `squish_feedback`
 * MCP path) and `mcp/tools/skill.ts`. `core/scheduler/job-runner.ts` also
 * imports it directly. It has no DDL, so every write against it currently fails
 * with `no such table` - that is a missing-DDL defect to fix in db/bootstrap.ts,
 * not a reason to delete a declaration live code compiles against.
 */
const LIVE_DECLARED_WITHOUT_DDL: Array<{ exportName: string; table: string }> = [
  { exportName: 'memoryFeedback', table: 'memory_feedback' },
];

/**
 * Files allowed to name a removed table, beyond the three legacy data paths
 * above. Each entry is documented so the next sweep can re-decide rather than
 * inherit an unexplained exemption.
 *  - core/memory/progressive-disclosure.ts : the sole reader of
 *    `lightweight_memory_indices` and `context_paging_sessions`, itself
 *    unreachable (zero importers, zero calls to its nine exports). The tables
 *    it names have never existed on any database, so every path through it
 *    already fails at `no such table`. Reviving progressive disclosure requires
 *    adding DDL in db/bootstrap.ts and re-adding both declarations together.
 */
const ALLOWED_NAMERS_EXTRA = new Set(['core/memory/progressive-disclosure.ts']);

/**
 * Files allowed to name a removed table. Each entry is a deliberate legacy
 * data path, not a live reader:
 *  - db/drizzle/schema-pg.ts  : separate Postgres schema, not the SQLite runtime.
 *  - db/migrations/knowledge.ts : one-time raw-SQL migration off old edge tables.
 *  - db/migrations/beliefs.ts : direct-invocation compatibility migration; not part of normal startup.
 */
const ALLOWED_NAMERS = new Set([
  'db/drizzle/schema-pg.ts',
  'db/migrations/knowledge.ts',
  'db/migrations/memory-places.ts',
  'db/migrations/beliefs.ts',
  // This migration fixture intentionally names historical strategy tables.
  'tests/knowledge/temporal-edges.test.ts',
  'tests/db/memory-places-bootstrap.test.ts',
  'tests/db/memory-places-migration.test.ts',
  'tests/v1.5-integration.test.ts',
  'tests/core/memory/global-memory.test.ts',
  // Project-erasure fixture includes historical edge tables for cleanup.
  'tests/core/project-deletion.test.ts',
  // This file names the removed tables on purpose.
  'tests/db/dormant-drizzle-tables.test.ts',
  ...ALLOWED_NAMERS_EXTRA,
]);

function listTypeScriptFiles(root: string): string[] {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  return tracked.split('\0').filter(Boolean).map((path) => join(root, path));
}

function drizzleTableNames(): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(sqliteSchema as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    try {
      names.add(getTableName(value as Table));
    } catch {
      // Not a drizzle table.
    }
  }
  return names;
}

describe('drizzle declaration hygiene', () => {
  test('the removed dormant tables are no longer declared', () => {
    const declared = drizzleTableNames();
    for (const table of REMOVED_TABLE_NAMES) {
      expect(declared).not.toContain(table);
    }
  });

  test('the removed drizzle exports no longer exist', () => {
    const exported = sqliteSchema as Record<string, unknown>;
    for (const name of REMOVED_EXPORT_NAMES) {
      expect(Object.keys(exported)).not.toContain(name);
    }
    expect(Object.keys(exported)).not.toContain('SearchTrace');
  });

  test('PostgreSQL exposes only the canonical knowledge edge table for runtime relations', () => {
    const declared = new Set<string>();
    for (const value of Object.values(postgresSchema as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue;
      try {
        declared.add(getTableName(value as Table));
      } catch {
        // Not a Drizzle table.
      }
    }

    expect(declared).toContain('knowledge_edges');
    for (const retired of ['belief_edges', 'strategy_edges', 'strategy_belief_edges', 'graph_edges']) {
      expect(declared).not.toContain(retired);
    }
  });

  // Scans every .ts file in the package synchronously. That takes ~4-6s on
  // Windows and can exceed the default 5s per-test timeout whenever other
  // test files contend for the filesystem, so give it explicit headroom.
  // The assertion itself is unchanged.
  test('no source file reads a removed table outside the allowed legacy paths', () => {
    const files = listTypeScriptFiles(PKG_ROOT).filter((file) => {
      const rel = file.slice(PKG_ROOT.length + 1).replaceAll('\\', '/');
      return rel !== 'db/drizzle/schema-sqlite.ts' && !ALLOWED_NAMERS.has(rel);
    });
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(PKG_ROOT.length + 1).replaceAll('\\', '/');
      const source = readFileSync(file, 'utf8');
      for (const table of REMOVED_TABLE_NAMES) {
        // Only match the table where it is used AS a table: a SQL keyword in
        // front of it, or a drizzle declaration. Prose such as "merge
        // strategies" is not a reference.
        const asSql = new RegExp(
          `(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\\s+["'\`\\[]?${table}\\b`,
          'i'
        );
        const asDeclaration = new RegExp(`sqliteTable\\(\\s*['"\`]${table}['"\`]`);
        if (asSql.test(source) || asDeclaration.test(source)) {
          offenders.push(`${rel} -> ${table}`);
        }
      }
      for (const name of REMOVED_EXPORT_NAMES) {
        if (new RegExp(`\\b${name}\\b`).test(source)) offenders.push(`${rel} -> ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  }, 30000);

  test('declarations read by live code survive', () => {
    for (const { exportName, table } of LIVE_DECLARED_WITHOUT_DDL) {
      const value = (sqliteSchema as Record<string, unknown>)[exportName];
      expect(value, `${exportName} must stay declared`).toBeDefined();
      expect(getTableName(value as Table)).toBe(table);
    }
  });
});
