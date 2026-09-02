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
export declare function runBatch6bBackfill(sqlite: Database, options?: {
    dryRun?: boolean;
}): Promise<SectorBackfillResult>;
//# sourceMappingURL=batch6b-backfill.d.ts.map