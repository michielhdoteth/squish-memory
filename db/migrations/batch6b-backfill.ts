/**
 * Batch 6b backfill: sector re-classification + legacy tier repair.
 *
 * Three idempotent one-time repairs over existing rows:
 *
 * 1. Sector backfill - heuristic re-classification of memories.sector using
 *    the same pure routeSector() rules v1 that the live write path uses
 *    (type + tags + content + provenance). Idempotent by construction: a row
 *    is updated only when its stored sector differs from the computed one,
 *    so re-running converges to zero writes. Set
 *    SQUISH_SECTOR_BACKFILL_DRY_RUN=true (or pass { dryRun: true }) to count
 *    would-be changes without touching rows.
 *
 * 2. Legacy tier repair - the schema default tier='hot' made every legacy
 *    row decay-exempt forever (decay engine skips 'hot'). Recalculate those
 *    rows to the proper 'working' tier on first pass; pinned rows become
 *    'sturdy' which matches what tier maintenance would classify them as.
 *    Rows with tier='hot' cease to exist afterwards, which IS the marker -
 *    second runs find nothing.
 *
 * 3. Knowledge-mirror sector backfill (Batch 6b fix) - the unified knowledge
 *    table mirrors every memory with a routed sector on the live write path,
 *    but Part 1 only repaired memories.sector, leaving pre-existing mirror
 *    rows stale (or on the 'general' default). Reclassify them with the same
 *    routeSector() rules using their own kind/type/tags/content/provenance.
 *    Runs under its OWN one-time marker so databases that already applied
 *    the memories pass still receive this repair.
 */

import type { Database } from 'better-sqlite3';
import { routeSector } from '../../core/memory/sector-router.js';
import { logger } from '../../core/logger.js';

const BATCH_SIZE = 500;
const MARKER_VERSION = '2.2.0-batch6b-sector-backfill';
const KNOWLEDGE_MARKER_VERSION = '2.2.1-batch6b-knowledge-sector-backfill';

export interface SectorBackfillResult {
  /** Rows whose sector changed (or would change under dry-run). */
  sectorsUpdated: number;
  /** Legacy 'hot'/'cold' tier rows recalculated. */
  tiersFixed: number;
  /** Knowledge-mirror rows whose sector changed (or would change). */
  knowledgeSectorsUpdated: number;
  pendingAfter: number;
  dryRun: boolean;
}

interface BackfillRow {
  id: string;
  type: string | null;
  tags: string | null;
  content: string | null;
  metadata: string | null;
  source: string | null;
  sector: string | null;
}

interface KnowledgeBackfillRow {
  id: string;
  knowledgeKind: string | null;
  knowledgeType: string | null;
  tags: string | null;
  content: string | null;
  metadata: string | null;
  sector: string | null;
}

function parseJsonArray(raw: unknown): string[] {
  if (raw == null) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function parseMetadataSource(raw: unknown): string | null {
  if (raw == null) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj && typeof obj === 'object' && typeof (obj as any).source === 'string') {
      return (obj as any).source;
    }
    return null;
  } catch {
    return null;
  }
}

export async function runBatch6bBackfill(
  sqlite: Database,
  options?: { dryRun?: boolean }
): Promise<SectorBackfillResult> {
  const result: SectorBackfillResult = {
    sectorsUpdated: 0,
    tiersFixed: 0,
    knowledgeSectorsUpdated: 0,
    pendingAfter: 0,
    dryRun: options?.dryRun
      ?? ['true', '1', 'yes'].includes(String(process.env.SQUISH_SECTOR_BACKFILL_DRY_RUN ?? '').toLowerCase()),
  };

  // One-time markers in _schema_versions (when the tracking table exists):
  // after the first successful pass, subsequent boots short-circuit at O(1)
  // instead of rescanning the corpus. The knowledge-mirror pass has its own
  // marker so DBs that already ran the memories pass still get Part 3.
  let hasMarkerTable = false;
  let memoriesPassApplied = false;
  let knowledgePassApplied = false;
  try {
    const markerRow = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_schema_versions'"
    ).get();
    hasMarkerTable = !!markerRow;
    if (hasMarkerTable && !result.dryRun) {
      memoriesPassApplied = !!sqlite.prepare('SELECT version FROM _schema_versions WHERE version = ?').get(MARKER_VERSION);
      knowledgePassApplied = !!sqlite.prepare('SELECT version FROM _schema_versions WHERE version = ?').get(KNOWLEDGE_MARKER_VERSION);
    }
  } catch {
    // No marker table: fall through and just run (still idempotent by content).
  }

  // ---- Part 2 first: legacy tier repair ('hot' rows block decay) ----
  // Pinned legacy-hot rows map to sturdy; everything else to working, which
  // is exactly what classifyMemoryTier's fallback would assign young rows.
  const dryRun = result.dryRun;
  result.tiersFixed = memoriesPassApplied
    ? 0
    : dryRun
    ? (sqlite.prepare(
        "SELECT COUNT(*) AS c FROM memories WHERE tier = 'hot' AND (is_pinned IS NULL OR is_pinned = 0)"
      ).get() as { c: number }).c
    : sqlite.prepare(
        "UPDATE memories SET tier = CASE WHEN is_pinned = 1 THEN 'sturdy' ELSE 'working' END " +
        "WHERE tier = 'hot'"
      ).run().changes;

  // ---- Part 1: sector re-classification via routeSector() ----
  if (!memoriesPassApplied) {
    const selectPageStmt = sqlite.prepare(
      `SELECT id, type, tags, content, metadata, source, sector
       FROM memories WHERE id > ? ORDER BY id LIMIT ${BATCH_SIZE}`
    );
    const updateStmt = sqlite.prepare('UPDATE memories SET sector = ? WHERE id = ?');

    let lastId = '';
    for (;;) {
      const rows = selectPageStmt.all(lastId) as BackfillRow[];
      if (rows.length === 0) break;
      const lastRow = rows[rows.length - 1];
      if (!lastRow) break;
      lastId = lastRow.id;

      let batchChanged = 0;
      if (!dryRun) {
        batchChanged = sqlite.transaction(() => {
          let n = 0;
          for (const row of rows) {
            const computed = routeSector({
              type: row.type,
              tags: parseJsonArray(row.tags),
              content: row.content ?? '',
              knowledgeKind: 'memory',
              source: parseMetadataSource(row.metadata) ?? row.source,
            });
            if (computed !== row.sector) {
              updateStmt.run(computed, row.id);
              n += 1;
            }
          }
          return n;
        })();
      } else {
        for (const row of rows) {
          const computed = routeSector({
            type: row.type,
            tags: parseJsonArray(row.tags),
            content: row.content ?? '',
            knowledgeKind: 'memory',
            source: parseMetadataSource(row.metadata) ?? row.source,
          });
          if (computed !== row.sector) batchChanged += 1;
        }
      }
      result.sectorsUpdated += batchChanged;

      if (rows.length < BATCH_SIZE) break;
    }
  }

  // ---- Part 3: knowledge-mirror sector re-classification ----
  // Same rules as the live write path's mirror stamping, applied over the
  // knowledge table with each row's own kind/type/tags/content/provenance.
  if (!knowledgePassApplied) {
    try {
      const kSelectPageStmt = sqlite.prepare(
        `SELECT id, knowledge_kind AS knowledgeKind, knowledge_type AS knowledgeType,
                tags, content, metadata, sector
         FROM knowledge WHERE id > ? ORDER BY id LIMIT ${BATCH_SIZE}`
      );
      const kUpdateStmt = sqlite.prepare('UPDATE knowledge SET sector = ? WHERE id = ?');

      let lastId = '';
      for (;;) {
        const rows = kSelectPageStmt.all(lastId) as KnowledgeBackfillRow[];
        if (rows.length === 0) break;
        const lastRow = rows[rows.length - 1];
        if (!lastRow) break;
        lastId = lastRow.id;

        let batchChanged = 0;
        if (!dryRun) {
          batchChanged = sqlite.transaction(() => {
            let n = 0;
            for (const row of rows) {
              const computed = routeSector({
                type: row.knowledgeType,
                tags: parseJsonArray(row.tags),
                content: row.content ?? '',
                knowledgeKind: row.knowledgeKind,
                source: parseMetadataSource(row.metadata),
              });
              if (computed !== row.sector) {
                kUpdateStmt.run(computed, row.id);
                n += 1;
              }
            }
            return n;
          })();
        } else {
          for (const row of rows) {
            const computed = routeSector({
              type: row.knowledgeType,
              tags: parseJsonArray(row.tags),
              content: row.content ?? '',
              knowledgeKind: row.knowledgeKind,
              source: parseMetadataSource(row.metadata),
            });
            if (computed !== row.sector) batchChanged += 1;
          }
        }
        result.knowledgeSectorsUpdated += batchChanged;

        if (rows.length < BATCH_SIZE) break;
      }
    } catch (error) {
      // Older DBs may predate the unified knowledge table; skip honestly.
      logger.warn(
        `[batch6b-backfill] knowledge-mirror pass skipped: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  // Pending-after probe: recompute mismatch count cheaply for observability.
  result.pendingAfter = dryRun
    ? result.sectorsUpdated + result.knowledgeSectorsUpdated
    : 0;

  // Record the one-time markers so future boots skip the scans entirely.
  if (hasMarkerTable && !dryRun) {
    try {
      if (!memoriesPassApplied) {
        sqlite.prepare('INSERT INTO _schema_versions (version, description) VALUES (?, ?)')
          .run(MARKER_VERSION, 'Batch 6b: sector routing backfill + legacy hot-tier repair applied');
      }
      if (!knowledgePassApplied) {
        sqlite.prepare('INSERT INTO _schema_versions (version, description) VALUES (?, ?)')
          .run(KNOWLEDGE_MARKER_VERSION, 'Batch 6b: knowledge-mirror sector backfill applied');
      }
    } catch {
      // Markers are best-effort; the passes themselves remain idempotent by content.
    }
  }

  if (
    result.sectorsUpdated > 0 ||
    result.tiersFixed > 0 ||
    result.knowledgeSectorsUpdated > 0
  ) {
    logger.info(
      `[batch6b-backfill] done: ${result.sectorsUpdated} memory sector(s) ` +
      `${dryRun ? 'would be ' : ''}updated, ${result.tiersFixed} legacy hot-tier row(s) ` +
      `${dryRun ? 'would be ' : ''}fixed, ${result.knowledgeSectorsUpdated} knowledge-mirror sector(s) ` +
      `${dryRun ? 'would be ' : ''}updated` +
      `${dryRun ? ' (dry run)' : ''}`
    );
  }

  return result;
}
