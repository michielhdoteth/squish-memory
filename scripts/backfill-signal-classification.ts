#!/usr/bin/env bun
/**
 * Backfill the `signal.classification` metadata block on memory rows written
 * before the remember path persisted signal metadata.
 *
 * Background (defect 3): core/memory/explain.ts classifies a memory as
 * signal-era only when `metadata.signal.classification` exists; every row
 * written by the older writer lacks it and falls back to 'legacy-durable'.
 * The writer fix only helps NEW rows; this script repairs rows already in the
 * database so inspection/classification stops reporting legacy for them.
 *
 * Behavior:
 *  - Opens the database from config (~/.squish/squish.db unless
 *    SQUISH_DATA_DIR/settings point elsewhere), overridable with --db.
 *  - Sets a busy_timeout (default 5000ms) so it coexists with live MCP usage.
 *  - For every row in `memories` whose metadata JSON lacks a usable
 *    signal.classification: parse metadata, add
 *    `signal: { classification: 'durable-distilled', backfilled: true,
 *    backfilledAt: <epoch ms> }`, re-serialize, update the row.
 *  - Existing metadata keys (memorySignals, memoryPolicy, ...) are untouched;
 *    an existing partial `signal` block is merged, not replaced.
 *  - Unparseable/invalid metadata JSON is reported and skipped, never
 *    rewritten.
 *
 * Usage:
 *   bun scripts/backfill-signal-classification.ts                    # dry-run against config DB
 *   bun scripts/backfill-signal-classification.ts --dry-run          # explicit dry-run (the default)
 *   bun scripts/backfill-signal-classification.ts --db <path> --apply
 *
 * Safety: --apply REQUIRES an explicit --db path. Applying against the
 * config-resolved live database (~/.squish/squish.db) is refused so a missing
 * --db can never silently mutate real memory rows; dry-run remains the safe
 * default everywhere.
 */

import { Database } from 'bun:sqlite';

interface BackfillSummary {
  database: string;
  dryRun: boolean;
  busyTimeoutMs: number;
  scanned: number;
  alreadyClassified: number;
  skippedInvalidMetadata: number;
  changed: number;
  wouldChange: number;
}

const CLASSIFICATION = 'durable-distilled';
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function parseArgs(argv: string[]): {
  dbPath?: string;
  dryRun: boolean;
  applyRequested: boolean;
  busyTimeoutMs: number;
} {
  const args = argv.slice(2);
  const dbIndex = args.indexOf('--db');
  const dbPath = dbIndex >= 0 ? args[dbIndex + 1] : undefined;
  // Dry-run is the default; only an explicit --apply writes.
  const applyRequested = args.includes('--apply');
  const dryRun = !applyRequested;
  const busyIndex = args.indexOf('--busy-timeout');
  const busyTimeoutMs =
    busyIndex >= 0 ? Math.max(0, parseInt(args[busyIndex + 1], 10) || DEFAULT_BUSY_TIMEOUT_MS) : DEFAULT_BUSY_TIMEOUT_MS;
  return { dbPath, dryRun, applyRequested, busyTimeoutMs };
}

async function resolveDefaultDbPath(): Promise<string> {
  const { join } = await import('node:path');
  // Imported lazily so an explicit --db (fixtures, tests) never pulls the
  // config stack. config.getDataDir() honors SQUISH_DATA_DIR/settings.json and
  // falls back to the global ~/.squish directory.
  const { getDataDir } = await import('../config.js');
  return join(getDataDir(), 'squish.db');
}

function hasUsableClassification(metadata: Record<string, unknown> | null): boolean {
  const signal = (metadata as Record<string, unknown> | null | undefined)?.signal;
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return false;
  const classification = (signal as Record<string, unknown>).classification;
  return typeof classification === 'string' && classification.trim().length > 0;
}

export function backfillSignalClassification(
  dbPath: string,
  options: { dryRun?: boolean; busyTimeoutMs?: number } = {}
): BackfillSummary {
  const dryRun = options.dryRun ?? true;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

  const summary: BackfillSummary = {
    database: dbPath,
    dryRun,
    busyTimeoutMs,
    scanned: 0,
    alreadyClassified: 0,
    skippedInvalidMetadata: 0,
    changed: 0,
    wouldChange: 0,
  };

  const db = new Database(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);

    const rows = db
      .prepare('SELECT id, metadata FROM memories')
      .all() as Array<{ id: string; metadata: string | null }>;

    const update = db.prepare('UPDATE memories SET metadata = ? WHERE id = ?');

    for (const row of rows) {
      summary.scanned += 1;

      let metadata: Record<string, unknown> | null = null;
      if (row.metadata !== null && row.metadata !== undefined && row.metadata.trim() !== '') {
        try {
          const parsed = JSON.parse(row.metadata);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            summary.skippedInvalidMetadata += 1;
            continue;
          }
          metadata = parsed as Record<string, unknown>;
        } catch {
          // Never rewrite a row whose metadata we cannot faithfully
          // re-serialize.
          summary.skippedInvalidMetadata += 1;
          continue;
        }
      }

      if (hasUsableClassification(metadata)) {
        summary.alreadyClassified += 1;
        continue;
      }

      summary.wouldChange += 1;
      if (dryRun) continue;

      const existingSignal =
        metadata && metadata.signal && typeof metadata.signal === 'object' && !Array.isArray(metadata.signal)
          ? (metadata.signal as Record<string, unknown>)
          : {};
      const updated: Record<string, unknown> = {
        ...(metadata ?? {}),
        signal: {
          ...existingSignal,
          classification: CLASSIFICATION,
          backfilled: true,
          backfilledAt: Date.now(),
        },
      };
      update.run(JSON.stringify(updated), row.id);
      summary.changed += 1;
    }
  } finally {
    db.close();
  }

  return summary;
}

function printSummary(summary: BackfillSummary): void {
  const mode = summary.dryRun ? 'dry-run' : 'apply';
  console.log(`[backfill-signal-classification] mode=${mode} db=${summary.database}`);
  console.log(`  busy_timeout=${summary.busyTimeoutMs}ms`);
  console.log(`  scanned=${summary.scanned}`);
  console.log(`  already-classified=${summary.alreadyClassified}`);
  console.log(`  skipped-invalid-metadata=${summary.skippedInvalidMetadata}`);
  if (summary.dryRun) {
    console.log(`  would-change=${summary.wouldChange} (no rows written; pass --apply to write)`);
  } else {
    console.log(`  changed=${summary.changed}`);
  }
}

if (import.meta.main) {
  const { dbPath, dryRun, applyRequested, busyTimeoutMs } = parseArgs(process.argv);

  // Footgun guard: --apply must name its target explicitly. Without --db the
  // path would silently resolve to the live config database (~/.squish), so
  // refuse before anything is opened.
  if (applyRequested && !dbPath) {
    console.error(
      '[backfill-signal-classification] refusing --apply without an explicit --db <path>: ' +
        'the default target is the live config database (~/.squish/squish.db). ' +
        'Run a dry-run first, then re-invoke with --db <path> --apply.'
    );
    process.exitCode = 1;
  } else {
    try {
      const resolvedPath = dbPath ?? (await resolveDefaultDbPath());
      const summary = backfillSignalClassification(resolvedPath, { dryRun, busyTimeoutMs });
      printSummary(summary);
    } catch (error) {
      console.error(
        `[backfill-signal-classification] failed: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
    }
  }
}
