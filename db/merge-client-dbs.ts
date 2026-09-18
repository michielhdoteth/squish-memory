/**
 * One-time migration: unify legacy per-client data dirs into the shared DB.
 *
 * History: bin/install-config.mjs used to give every MCP client its own data
 * dir (~/.squish/claude, ~/.squish/opencode, ...) via SQUISH_DATA_DIR. That
 * split memories across silos. Installers no longer emit those overrides;
 * all clients share ~/.squish/squish.db.
 *
 * This module performs a conservative, copy-NOT-move merge of any legacy
 * per-client squish.db files into the shared database:
 *
 *   - Runs once, guarded by a marker file (client-merge-manifest.json).
 *   - Only triggers when legacy client DBs actually exist.
 *   - Sources are opened READ-ONLY and are never modified.
 *   - Rows are deduped: by primary key (pre-insert existence checks) and, for
 *     memories,
 *     additionally by content hash so identical text is never duplicated.
 *   - FTS virtual tables and their shadow tables are skipped; the FTS index
 *     is rebuilt instead.
 *   - The whole merge runs in a single transaction with foreign_keys=OFF,
 *     followed by PRAGMA foreign_key_check. Any count mismatch or integrity
 *     violation rolls back everything and instructs manual review -- the
 *     app still starts normally against whatever shared DB state exists.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../core/logger.js';
import { ensureSqliteSchema } from './bootstrap.js';

export const MERGE_MANIFEST_FILENAME = 'client-merge-manifest.json';

/** Legacy per-client subdirectories created by older installers. */
const LEGACY_CLIENT_DIRS = ['claude', 'opencode', 'openclaw', 'codex'] as const;

export interface MergeTableReport {
  sourceRows: number;
  skippedDuplicates: number;
  inserted: number;
  /** Same-id rows whose content differed from the target row (not silent dupes). */
  conflicts: number;
  /** Ids of conflicting rows (memories table only). */
  conflictIds?: string[];
}

export interface MergeSourceReport {
  source: string;
  tables: Record<string, MergeTableReport>;
}

export interface MergeManifest {
  migratedAt: string;
  targetDb: string;
  sources: MergeSourceReport[];
  totalSourceRowsScanned: number;
  totalInserted: number;
  totalSkippedDuplicates: number;
  totalConflicts: number;
}

interface SqliteRow { [column: string]: unknown }

interface NativeSqliteHandle {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  pragma?(statement: string): unknown;
  close(exception?: unknown): void;
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open a SQLite file with whichever native driver is available.
 * Preference mirrors db/adapter.ts: bun:sqlite under Bun, else better-sqlite3.
 */
export async function openNativeSqlite(
  dbPath: string,
  options: { readonly?: boolean } = {}
): Promise<NativeSqliteHandle> {
  const readonlyMode = options.readonly ?? false;

  // Native drivers do not create missing parent directories.
  if (!readonlyMode) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  if (isBunRuntime()) {
    try {
      const BunDatabase = (await import('bun:sqlite')).default as any;
      const handle = readonlyMode
        ? new BunDatabase(dbPath, { readonly: true })
        : new BunDatabase(dbPath);
      return handle as NativeSqliteHandle;
    } catch (error) {
      logger.debug(`[merge-client-dbs] bun:sqlite unavailable for ${dbPath}: ${errorMessage(error)}`);
    }
  }

  try {
    const DatabaseModule = await import('better-sqlite3');
    const Database = DatabaseModule.default;
    const handle = new Database(dbPath, readonlyMode ? { readonly: true } : undefined);
    return handle as unknown as NativeSqliteHandle;
  } catch (error) {
    logger.debug(`[merge-client-dbs] better-sqlite3 unavailable for ${dbPath}: ${errorMessage(error)}`);
  }

  throw new Error(`No native SQLite driver available to ${readonlyMode ? 'read' : 'open'} ${dbPath}`);
}

function listLegacyClientDbs(dataDir: string): string[] {
  return LEGACY_CLIENT_DIRS
    .map((client) => path.join(dataDir, client, 'squish.db'))
    .filter((candidate) => fs.existsSync(candidate));
}

interface SourceTableInfo {
  name: string;
  columns: string[];
  hasPrimaryKey: boolean;
  isMemories: boolean;
}

function loadTableInfo(handle: NativeSqliteHandle): SourceTableInfo[] {
  const entries = handle.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all() as Array<{ name: string; sql: string | null }>;

  const tables: SourceTableInfo[] = [];
  for (const entry of entries) {
    const name = String(entry.name);
    const sql = entry.sql ?? '';
    // Skip FTS virtual tables and their shadow tables entirely.
    if (/virtual\s+table/i.test(sql)) continue;
    if (name.includes('fts')) continue;

    const info = handle.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as Array<{
      name: string;
      pk: number;
    }>;
    if (!Array.isArray(info) || info.length === 0) continue;

    const columns = info.map((column) => String(column.name));
    const hasPrimaryKey = info.some((column) => Number(column.pk) > 0);

    tables.push({
      name,
      columns,
      hasPrimaryKey,
      isMemories: name === 'memories',
    });
  }
  return tables;
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function loadTargetMemoryContentHashes(target: NativeSqliteHandle): Set<string> | null {
  try {
    const check = target.prepare(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='memories'"
    ).get() as { count?: number | bigint };
    if (Number(check?.count ?? 0) === 0) return new Set();

    const rows = target.prepare('SELECT content FROM memories').all() as Array<{ content: unknown }>;
    const hashes = new Set<string>();
    for (const row of rows) {
      if (typeof row.content === 'string' && row.content.length > 0) {
        hashes.add(sha256(row.content));
      }
    }
    return hashes;
  } catch (error) {
    logger.warn(`[merge-client-dbs] Could not precompute content hashes: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Merge every legacy per-client squish.db under dataDir into targetDbPath.
 * Idempotent, copy-not-move, all-or-nothing per run. Returns the manifest
 * that was written, or null when there was nothing to do.
 */
export async function maybeMergeLegacyClientDbs(
  targetDbPath: string,
  options: { force?: boolean } = {}
): Promise<MergeManifest | null> {
  const dataDir = path.dirname(targetDbPath);
  const manifestPath = path.join(dataDir, MERGE_MANIFEST_FILENAME);

  if (!options.force && fs.existsSync(manifestPath)) {
    return null;
  }

  const sources = listLegacyClientDbs(dataDir);
  if (sources.length === 0) {
    return null;
  }

  logger.info(
    `[merge-client-dbs] Found ${sources.length} legacy per-client DB(s): ${sources.join(', ')}. Merging into ${targetDbPath} (sources are left untouched).`
  );

  // Ensure the shared DB exists AND is migrated to the current schema before
  // merging into it (legacy sources may carry newer columns than an old,
  // unmigrated shared DB).
  const bootstrapHandle = await openNativeSqlite(targetDbPath, { readonly: false });
  try {
    await ensureSqliteSchema(bootstrapHandle as never);
  } finally {
    bootstrapHandle.close();
  }

  const target = await openNativeSqlite(targetDbPath, { readonly: false });
  const sourceHandles: Array<{ file: string; handle: NativeSqliteHandle }> = [];

  const readFkViolations = (): Set<string> => {
    let rows: unknown[] = [];
    try {
      // Driver-agnostic pragma read: better-sqlite3 exposes .pragma();
      // bun:sqlite needs prepare().all().
      const anyTarget = target as unknown as { pragma?: (s: string) => unknown };
      if (typeof anyTarget.pragma === 'function') {
        rows = (anyTarget.pragma('foreign_key_check') as unknown[]) ?? [];
      } else {
        rows = target.prepare('PRAGMA foreign_key_check').all();
      }
    } catch (error) {
      logger.warn(`[merge-client-dbs] Could not run foreign_key_check: ${errorMessage(error)}`);
    }
    return new Set((Array.isArray(rows) ? rows : []).map((row) => JSON.stringify(row)));
  };

  try {
    // Baseline integrity snapshot: the shared DB may carry pre-existing
    // violations from earlier eras. Only violations ADDED by this merge are
    // treated as failures.
    const fkBaseline = readFkViolations();

    target.exec('PRAGMA foreign_keys = OFF');
    target.exec('BEGIN IMMEDIATE');

    const manifestSources: MergeSourceReport[] = [];
    let totalSourceRowsScanned = 0;
    let totalInserted = 0;
    let totalSkippedDuplicates = 0;
    let totalConflicts = 0;
    let ftsRebuildNeeded = false;

    for (const sourceFile of sources) {
      let handle: NativeSqliteHandle;
      try {
        handle = await openNativeSqlite(sourceFile, { readonly: true });
      } catch (error) {
        throw new Error(`Cannot open legacy client DB ${sourceFile}: ${errorMessage(error)}`);
      }
      sourceHandles.push({ file: sourceFile, handle });

      const report: MergeSourceReport = { source: sourceFile, tables: {} };
      const sourceTables = loadTableInfo(handle);

      for (const table of sourceTables) {
        const quotedName = quoteIdent(table.name);
        let sourceRows: Array<SqliteRow>;
        try {
          sourceRows = handle.prepare(`SELECT * FROM ${quotedName}`).all() as Array<SqliteRow>;
        } catch (error) {
          logger.warn(`[merge-client-dbs] Skipping unreadable table ${table.name} in ${sourceFile}: ${errorMessage(error)}`);
          continue;
        }

        // Conservative: only merge tables whose schema gives us a safe key.
        if (!table.hasPrimaryKey && !table.isMemories) {
          logger.debug(`[merge-client-dbs] Table ${table.name} has no primary key; skipped`);
          continue;
        }

        let targetCountBefore = 0;
        try {
          const beforeRow = target.prepare(`SELECT COUNT(*) as count FROM ${quotedName}`).get() as {
            count?: number | bigint;
          };
          targetCountBefore = Number(beforeRow?.count ?? 0);
        } catch {
          // Target lacks this table entirely; treat as zero.
          targetCountBefore = 0;
        }

        const columnList = table.columns.map(quoteIdent).join(', ');
        const placeholders = table.columns.map(() => '?').join(', ');
        const insertStmt = target.prepare(
          `INSERT INTO ${quotedName} (${columnList}) VALUES (${placeholders})`
        );

        // NOTE: drivers report .changes() inconsistently under triggers
        // (e.g. bun:sqlite counts FTS-sync trigger writes), so duplicates are
        // detected explicitly via pre-insert existence checks rather than
        // inferred from driver change counters.
        let pkColumns: string[] = [];
        if (!table.isMemories) {
          const info = target.prepare(`PRAGMA table_info(${quotedName})`).all() as Array<{
            name: string;
            pk: number;
          }>;
          pkColumns = (Array.isArray(info) ? info : [])
            .filter((column) => Number(column.pk) > 0)
            .sort((a, b) => Number(a.pk) - Number(b.pk))
            .map((column) => String(column.name));
          if (pkColumns.length === 0) {
            logger.debug(`[merge-client-dbs] Table ${table.name} has no primary key in target; skipped`);
            continue;
          }
          // Source must carry every target PK column, otherwise we cannot
          // dedupe safely.
          if (!pkColumns.every((column) => table.columns.includes(column))) {
            logger.debug(`[merge-client-dbs] Table ${table.name} missing PK columns in source; skipped`);
            continue;
          }
        }

        const pkSelectSql =
          table.isMemories
            ? null
            : `SELECT COUNT(*) as count FROM ${quotedName} WHERE ${pkColumns
                .map((column) => `${quoteIdent(column)} = ?`)
                .join(' AND ')}`;
        const pkCheckStmt = pkSelectSql ? target.prepare(pkSelectSql) : null;

        let memoryHashes: Set<string> | null = null;
        if (table.isMemories) {
          memoryHashes = loadTargetMemoryContentHashes(target);
        }

        const tableReport: MergeTableReport = {
          sourceRows: sourceRows.length,
          skippedDuplicates: 0,
          inserted: 0,
          conflicts: 0,
          ...(table.isMemories ? { conflictIds: [] as string[] } : {}),
        };

        // Track keys already contributed during this run so later sources (and
        // later rows in the same source) are deduped against them too.
        const seenKeysThisRun = new Set<string>();
        // Content of memory ids already contributed this run, so same-id
        // different-content collisions can be detected without re-querying.
        const seenMemoryContentById = new Map<string, string>();

        for (const row of sourceRows) {
          const values = table.columns.map((column) => row[column] ?? null);

          let duplicate = false;
          let seenKey: string | null = null;
          let wasConflict = false;

          if (table.isMemories) {
            // Content-level dedupe for memories: same id OR identical content.
            const idValue = values[table.columns.indexOf('id')];
            const contentValue = values[table.columns.indexOf('content')];
            const idKey = idValue !== null && idValue !== undefined ? String(idValue) : null;
            seenKey = idKey !== null ? `id:${idKey}` : null;

            let existingContent: string | null = null;
            let idAlreadyPresent = false;
            if (seenKey !== null && seenKeysThisRun.has(seenKey)) {
              idAlreadyPresent = true;
              existingContent = seenMemoryContentById.get(idKey!) ?? null;
            } else if (seenKey !== null) {
              const existingRow = target
                .prepare(`SELECT content FROM ${quotedName} WHERE id = ?`)
                .get(idValue) as { content?: unknown } | undefined;
              if (existingRow) {
                idAlreadyPresent = true;
                existingContent = typeof existingRow.content === 'string' ? existingRow.content : null;
              }
            }
            duplicate = idAlreadyPresent;

            if (
              !duplicate &&
              typeof contentValue === 'string' &&
              contentValue.length > 0 &&
              memoryHashes &&
              memoryHashes.has(sha256(contentValue))
            ) {
              duplicate = true;
            }

            // Same id but different content is a CONFLICT, not a silent
            // duplicate: count it explicitly and log the pair so manual
            // review can reconcile the two versions.
            if (
              idAlreadyPresent &&
              typeof contentValue === 'string' &&
              contentValue.length > 0 &&
              existingContent !== null &&
              sha256(existingContent) !== sha256(contentValue)
            ) {
              tableReport.conflicts++;
              tableReport.conflictIds?.push(String(idKey));
              wasConflict = true;
              logger.warn(
                `[merge-client-dbs] CONFLICT memories id=${String(idKey)} (${sourceFile}): ` +
                  `same id, different content. Target: "${existingContent.slice(0, 80)}" | ` +
                  `Source: "${contentValue.slice(0, 80)}". Keeping target version.`
              );
            }

            if (
              !duplicate &&
              typeof contentValue === 'string' &&
              contentValue.length > 0 &&
              memoryHashes
            ) {
              memoryHashes.add(sha256(contentValue));
            }
          } else if (pkCheckStmt) {
            const pkValues = pkColumns.map((column) => row[column] ?? null);
            seenKey = `${table.name}:${pkValues.map((value) => String(value)).join('|')}`;
            if (seenKeysThisRun.has(seenKey)) {
              duplicate = true;
            } else {
              const check = pkCheckStmt.get(...pkValues) as { count?: number | bigint };
              duplicate = Number(check?.count ?? 0) > 0;
            }
          }

          if (duplicate) {
            // Conflicts are counted separately (not silently lumped with
            // duplicates); everything else that matched an existing row is a
            // plain duplicate.
            if (!wasConflict) {
              tableReport.skippedDuplicates++;
            }
            continue;
          }
          if (seenKey !== null) seenKeysThisRun.add(seenKey);
          if (table.isMemories) {
            const idValue = values[table.columns.indexOf('id')];
            const contentValue = values[table.columns.indexOf('content')];
            if (idValue !== null && idValue !== undefined && typeof contentValue === 'string') {
              seenMemoryContentById.set(String(idValue), contentValue);
            }
          }

          try {
            insertStmt.run(...values);
          } catch (error) {
            // A UNIQUE/PK rejection here means the row is a semantic
            // duplicate under a different surrogate key (e.g.
            // maintenance_jobs.job_name UNIQUE). Count and move on; any
            // other constraint failure aborts the merge below.
            if (/UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(errorMessage(error))) {
              tableReport.skippedDuplicates++;
              continue;
            }
            throw error;
          }
          tableReport.inserted++;

          if (table.isMemories) ftsRebuildNeeded = true;
        }

        // Verify: target growth must equal what we believe we inserted.
        const afterRow = target.prepare(`SELECT COUNT(*) as count FROM ${quotedName}`).get() as {
          count?: number | bigint;
        };
        const targetCountAfter = Number(afterRow?.count ?? 0);
        if (targetCountAfter - targetCountBefore !== tableReport.inserted) {
          throw new Error(
            `Count verification failed for table ${table.name} (source ${sourceFile}): ` +
              `expected +${tableReport.inserted}, actual +${targetCountAfter - targetCountBefore}`
          );
        }

        report.tables[table.name] = tableReport;
        totalSourceRowsScanned += tableReport.sourceRows;
        totalInserted += tableReport.inserted;
        totalSkippedDuplicates += tableReport.skippedDuplicates;
        totalConflicts += tableReport.conflicts;
      }

      manifestSources.push(report);
    }

    // Integrity gate before committing anything: only NEW violations
    // (introduced by this merge) are failures; pre-existing ones are not
    // this migration's problem to fix.
    const fkAfter = readFkViolations();
    const newViolations = [...fkAfter].filter((violation) => !fkBaseline.has(violation));
    if (newViolations.length > 0) {
      throw new Error(
        `foreign_key_check reported ${newViolations.length} NEW violation(s) introduced by the merge ` +
          `(baseline had ${fkBaseline.size})`
      );
    }

    target.exec('COMMIT');

    // Refresh the FTS index so newly merged memories stay searchable.
    if (ftsRebuildNeeded) {
      try {
        target.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
      } catch (error) {
        logger.debug(`[merge-client-dbs] FTS rebuild skipped: ${errorMessage(error)}`);
      }
    }

    target.exec('PRAGMA foreign_keys = ON');

    const manifest: MergeManifest = {
      migratedAt: new Date().toISOString(),
      targetDb: targetDbPath,
      sources: manifestSources,
      totalSourceRowsScanned,
      totalInserted,
      totalSkippedDuplicates,
      totalConflicts,
    };

    // Atomic marker write: tmp file + rename so a crash mid-write cannot
    // leave a half-written manifest marking the migration as done.
    const tmpPath = `${manifestPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(tmpPath, manifestPath);

    logger.info(
      `[merge-client-dbs] Merge complete: +${totalInserted} rows inserted, ${totalSkippedDuplicates} duplicates skipped, ` +
        `${totalConflicts} same-id/different-content conflict(s) across ${manifestSources.length} source(s). Manifest: ${manifestPath}`
    );
    return manifest;
  } catch (error) {
    // All-or-nothing: roll back and DO NOT write the marker, so the merge can
    // be retried (it is idempotent) after manual review if needed.
    try {
      target.exec('ROLLBACK');
    } catch {
      // No active transaction; ignore.
    }
    logger.error(
      '================================================================\n' +
        '[merge-client-dbs] LEGACY DATA MERGE ABORTED - MANUAL REVIEW NEEDED\n' +
        `Error: ${errorMessage(error)}\n` +
        `Target: ${targetDbPath}\n` +
        'Nothing was committed; legacy source databases are untouched.\n' +
        `Inspect the files above, resolve manually, then delete/retry.\n` +
        '================================================================'
    );
    return null;
  } finally {
    for (const { handle } of sourceHandles) {
      try {
        handle.close();
      } catch {
        // Ignore close errors on read-only handles.
      }
    }
    try {
      target.close();
    } catch {
      // Ignore.
    }
  }
}
