/**
 * WS2a: write-time near-duplicate detection + linking.
 *
 * Runs on the remember path AFTER the memory is stored (and after the
 * fire-and-forget contradiction-resolution dispatch), gated by
 * SQUISH_WRITE_DEDUP / features.writeDedup:
 *
 * - 'off'   (SHIPPED DEFAULT): short-circuits before any read beyond one
 *           config getter. Zero behavior/latency change.
 * - 'link':  bounded top-K similarity search WITHIN the new memory's scope
 *           (project path + team), strict same-scope verification against the
 *           stored rows, then bidirectional 'near_duplicate' associations and
 *           lightweight metadata.dedup = { mode, detectedAt, similarIds,
 *           maxSimilarity }. NON-DESTRUCTIVE: both memories stay active;
 *           nothing is merged, dropped, or rewritten beyond the dedup key.
 * - 'merge': explicit opt-in. Detected near-duplicates (plus the new memory)
 *           go through the EXISTING merge workflow: a merge proposal is
 *           created (same shape the nightly detect-duplicates handler
 *           writes) and executed via handleApproveMerge - the exact machinery
 *           squish_dedup approve uses - so the result is a single canonical
 *           memory with merged-from provenance that handleReverseMerge can
 *           undo atomically. Any safety blocker falls back to 'link', never
 *           to a destructive partial merge.
 *
 * Threshold: the near-duplicate bar REUSES THE EXISTING DETECTOR BAR -
 * config.writeDedupThreshold defaults to 0.85, the same semantic threshold
 * `findSimilarMemories` and the two-stage detector (`threshold ?? 0.85`)
 * gate on. No new bar is invented; operators may raise it via env. (The
 * SimHash/MinHash prefilter of the two-stage detector needs a full-corpus
 * scan and therefore stays in the nightly batch; the write path keeps the
 * cheap bounded vector/keyword top-K instead - see docs/ENV-CONFIG.md.)
 * WS2a carryover guard: sanitizeWriteDedupThreshold() treats an
 * empty/invalid env value (Number('') === 0 - which would link EVERYTHING)
 * or any value outside (0, 1] as "fall back to the 0.85 default", scoped to
 * this read only - the shared getNumber stays unchanged.
 */

import { randomUUID } from 'crypto';
import { eq, inArray } from 'drizzle-orm';
import { config } from '../../config.js';
import { logger } from '../logger.js';
import { getDbClient } from '../lib/db-client.js';
import { findSimilarMemories } from './memory-search.js';
import { deserializeTags, deserializeMetadata, serializeMetadata, toSqliteJson } from './serialization.js';
import { createAssociation } from '../associations.js';
import { SAFETY_CHECKS } from '../algorithms/safety/safety-checks.js';
import { mergeMemories } from '../algorithms/strategies/merge-strategies.js';
import { handleApproveMerge } from '../algorithms/handlers/approve-merge.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import type { Memory } from '../../db/drizzle/schema.js';

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

export interface WriteDedupStageInput {
  /** ID of the memory that was just stored. */
  memoryId: string;
  /** Plaintext content of the new memory (query text for the scan). */
  content: string;
  /** Resolved project ID of the new memory (null = global scope). */
  projectId: string | null;
  /** Raw project path input (null = global scope); used for scoped search. */
  projectPath?: string | null;
  /** Team ID for team-scoped memories. */
  teamId?: string | null;
}

export interface WriteDedupOutcome {
  /** What actually happened: 'merge' only when the merge really executed. */
  mode: 'link' | 'merge';
  /** The configured mode at write time ('merge' that fell back records why). */
  requestedMode: 'link' | 'merge';
  /** ISO timestamp of the detection. */
  detectedAt: string;
  /** Near-duplicate memory IDs linked/merged, best score first. */
  similarIds: string[];
  /** Highest similarity among the accepted candidates. */
  maxSimilarity: number;
  /** Why a 'merge' request degraded to 'link' (safety blockers, no project). */
  fallbackReason?: string;
  /** Merge-mode artifacts (present only when mode === 'merge'). */
  proposalId?: string;
  canonicalMemoryId?: string;
  mergeHistoryId?: string;
}

export interface NearDuplicateSearchParams {
  content: string;
  excludeId: string;
  projectId: string | null;
  projectPath: string | null;
  teamId: string | null;
  threshold: number;
  topK: number;
}

export interface NearDuplicateCandidate {
  id: string;
  similarity: number;
}

export type NearDuplicateSearcher = (
  params: NearDuplicateSearchParams
) => Promise<NearDuplicateCandidate[]>;

export interface WriteDedupStats {
  /** Number of write-time similarity scans executed (0 while mode is off). */
  scans: number;
  /** near_duplicate association rows created (both directions counted). */
  linksCreated: number;
  /** Merges executed through the approve-merge machinery. */
  mergesExecuted: number;
  /** Merge-mode writes that fell back to link (safety / no project). */
  mergeFallbacksToLink: number;
  /** topK requested on the most recent scan (bounded-scan evidence). */
  lastScanTopK: number;
}

// ---------------------------------------------------------------------------
// Instrumentation (cheap counters; exported for observability + tests)
// ---------------------------------------------------------------------------

let stats: WriteDedupStats = {
  scans: 0,
  linksCreated: 0,
  mergesExecuted: 0,
  mergeFallbacksToLink: 0,
  lastScanTopK: 0,
};

export function getWriteDedupStats(): WriteDedupStats {
  return { ...stats };
}

export function resetWriteDedupStats(): void {
  stats = {
    scans: 0,
    linksCreated: 0,
    mergesExecuted: 0,
    mergeFallbacksToLink: 0,
    lastScanTopK: 0,
  };
}

// ---------------------------------------------------------------------------
// Searcher seam: production = findSimilarMemories (bounded top-K, scoped).
// ---------------------------------------------------------------------------

const productionSearcher: NearDuplicateSearcher = async (params) => {
  const results = await findSimilarMemories(
    params.content,
    params.threshold,
    params.topK,
    { project: params.projectPath ?? null, teamId: params.teamId ?? null }
  );
  return results
    .filter((r) => r.id !== params.excludeId && r.corpus !== 'belief')
    .map((r) => ({
      id: r.id,
      similarity: r.semanticScore ?? r.similarity ?? 0,
    }));
};

let searcherOverride: NearDuplicateSearcher | null = null;

/**
 * Test seam: replace the near-duplicate search used by the write-dedup stage
 * (deterministic scores, spy calls, injected cross-scope candidates). Pass
 * null to restore the production searcher. Never ship non-null.
 */
export function setWriteDedupSearcherForTesting(searcher: NearDuplicateSearcher | null): void {
  searcherOverride = searcher;
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

/** Rows must be alive and in the EXACT same scope as the new memory. */
function isSameScope(
  row: { projectId?: string | null; teamId?: string | null; isMerged?: boolean | null; isActive?: boolean | null; status?: string | null },
  input: WriteDedupStageInput
): boolean {
  if ((row.projectId ?? null) !== (input.projectId ?? null)) return false;
  if ((row.teamId ?? null) !== (input.teamId ?? null)) return false;
  if (row.isMerged) return false;
  if (row.isActive === false) return false;
  const status = (row.status ?? '').toLowerCase();
  if (['expired', 'archived', 'superseded', 'merged'].includes(status)) return false;
  return true;
}

function normalizeMemoryRow(row: any): Memory {
  return {
    ...row,
    tags: deserializeTags(row.tags),
    metadata: deserializeMetadata(row.metadata),
  } as Memory;
}

/**
 * Blocker names for a candidate source set, computed with the SAME safety
 * registry the nightly proposal path uses (runSafetyChecks -> SAFETY_CHECKS).
 * Names (not prose) are recorded in the fallback reason.
 */
function collectSafetyBlockers(sources: Memory[], similarityScore: number): string[] {
  const blockers: string[] = [];
  for (const check of SAFETY_CHECKS) {
    if (check.type !== 'blocker') continue;
    try {
      const result = check.check(sources, { similarityScore });
      if (!result.passed) blockers.push(check.name);
    } catch {
      blockers.push(check.name);
    }
  }
  return blockers;
}

async function linkCandidates(
  memoryId: string,
  candidates: Array<{ id: string; similarity: number }>
): Promise<void> {
  for (const candidate of candidates) {
    await createAssociation(memoryId, candidate.id, 'near_duplicate', 1, {
      tag: 'EXTRACTED',
      score: candidate.similarity,
    });
    await createAssociation(candidate.id, memoryId, 'near_duplicate', 1, {
      tag: 'EXTRACTED',
      score: candidate.similarity,
    });
    stats.linksCreated += 2;
  }
}

/** Read-modify-write the stored metadata so concurrent writers keep their keys. */
async function recordDedupMetadata(memoryId: string, outcome: WriteDedupOutcome): Promise<void> {
  try {
    const { db, schema } = await getDbClient();
    const [current] = await db
      .select({ metadata: (schema.memories as any).metadata })
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .limit(1);
    if (!current) return;
    const meta = (deserializeMetadata(current.metadata as any) ?? {}) as Record<string, unknown>;
    meta.dedup = outcome;
    await db
      .update(schema.memories)
      .set({ metadata: serializeMetadata(meta) as any })
      .where(eq(schema.memories.id, memoryId));
  } catch (err) {
    // Metadata is best-effort bookkeeping; linking already happened.
    logger.debug(`[WriteDedup] metadata record failed for ${memoryId}: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Merge mode: proposal -> handleApproveMerge (reversible via reverse-merge)
// ---------------------------------------------------------------------------

interface MergeAttempt {
  ok: boolean;
  reason?: string;
  proposalId?: string;
  canonicalMemoryId?: string;
  mergeHistoryId?: string;
}

async function attemptMerge(
  newMemoryId: string,
  projectId: string | null,
  candidates: Array<{ id: string; similarity: number }>
): Promise<MergeAttempt> {
  // memory_merge_proposals.projectId is NOT NULL + FK: a projectless memory
  // cannot carry a proposal. Stay safe: fall back to link.
  if (!projectId) {
    return { ok: false, reason: 'no-project: merge proposals require a project scope' };
  }

  const { db, schema } = await getDbClient();
  const wantedIds = [newMemoryId, ...candidates.map((c) => c.id)];
  const rows = await db
    .select()
    .from(schema.memories)
    .where(inArray(schema.memories.id, wantedIds));
  const byId = new Map(rows.map((r: any) => [r.id as string, r]));
  const newRow = byId.get(newMemoryId);
  if (!newRow) return { ok: false, reason: 'source-row-missing' };

  const sources: Memory[] = [
    normalizeMemoryRow(newRow),
    ...candidates
      .map((c) => byId.get(c.id))
      .filter(Boolean)
      .map((r) => normalizeMemoryRow(r)),
  ];

  const maxSimilarity = Math.max(...candidates.map((c) => c.similarity));
  const blockers = collectSafetyBlockers(sources, maxSimilarity);
  if (blockers.length > 0) {
    return { ok: false, reason: blockers.join(',') };
  }

  let merged;
  try {
    merged = mergeMemories(sources);
  } catch (err) {
    return {
      ok: false,
      reason: `merge-strategy-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const sourceIds = sources.map((s) => s.id);
  const proposalId = randomUUID();
  try {
    await db.insert(schema.memoryMergeProposals).values({
      id: proposalId,
      projectId,
      userId: (newRow as any).userId ?? undefined,
      sourceMemoryIds: toSqliteJson(sourceIds),
      proposedContent: merged.content,
      proposedSummary: merged.summary,
      proposedTags: toSqliteJson(merged.tags),
      proposedMetadata: toSqliteJson(merged.metadata),
      detectionMethod: 'embedding',
      similarityScore: String(maxSimilarity),
      confidenceLevel: 'high',
      mergeReason: 'Write-time near-duplicate (SQUISH_WRITE_DEDUP=merge)',
      conflictWarnings: toSqliteJson(merged.conflictWarnings),
      status: 'pending',
      createdAt: new Date(),
    } as any);
  } catch (err) {
    return {
      ok: false,
      reason: `proposal-insert-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // THE SAME MACHINERY squish_dedup approve uses: transactional canonical
  // creation + soft-archive of sources + snapshot history (reverse-merge).
  const approved = await handleApproveMerge({
    proposalId,
    reviewNotes: 'squish-write-dedup:merge (SQUISH_WRITE_DEDUP=merge)',
  });

  if (!approved.ok || !approved.data) {
    // Proposal stays pending for manual review/rejection; nothing mutated.
    return {
      ok: false,
      proposalId,
      reason: `approve-merge-rejected: ${approved.error ?? approved.message}`,
    };
  }

  stats.mergesExecuted += 1;
  return {
    ok: true,
    proposalId,
    canonicalMemoryId: approved.data.canonicalMemoryId,
    mergeHistoryId: approved.data.mergeHistoryId,
  };
}

// ---------------------------------------------------------------------------
// Threshold guard (WS2a carryover)
// ---------------------------------------------------------------------------

/** The shared detector bar this stage reuses (config default; docs/ENV-CONFIG.md). */
export const DEFAULT_WRITE_DEDUP_THRESHOLD = 0.85;

/**
 * Guard the write-dedup threshold AT THIS READ (the shared config.getNumber
 * is left untouched): SQUISH_WRITE_DEDUP_THRESHOLD="" parses through
 * Number('') to 0, which would link EVERYTHING. Empty/invalid/out-of-range
 * values fall back to the 0.85 detector bar. A similarity threshold is only
 * meaningful inside (0, 1]; 0 (and negatives) are never a sane operator
 * choice for a near-duplicate bar, so treating them as invalid is safe.
 */
export function sanitizeWriteDedupThreshold(value: number): number {
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : DEFAULT_WRITE_DEDUP_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Stage entry point
// ---------------------------------------------------------------------------

export async function runWriteDedupStage(
  input: WriteDedupStageInput
): Promise<WriteDedupOutcome | null> {
  const mode = config.writeDedupMode;
  // Default path: one lazy config getter, then nothing. Byte-identical writes.
  if (mode === 'off') return null;
  // The manual merge handlers fail closed under strict trust because proposals
  // do not yet have caller-bound ACLs or encrypted payload storage. Do not let
  // the automatic write path create a plaintext proposal before that guard is
  // reached. Strict mode therefore disables write-time dedup altogether.
  if (mode === 'merge' && isStrictTrustPolicy()) return null;

  const threshold = sanitizeWriteDedupThreshold(config.writeDedupThreshold);
  const topK = Math.max(1, Math.floor(config.writeDedupTopK));

  stats.scans += 1;
  stats.lastScanTopK = topK;

  const searcher = searcherOverride ?? productionSearcher;
  let raw: NearDuplicateCandidate[];
  try {
    raw = await searcher({
      content: input.content,
      excludeId: input.memoryId,
      projectId: input.projectId,
      projectPath: input.projectPath ?? null,
      teamId: input.teamId ?? null,
      threshold,
      topK,
    });
  } catch (err) {
    // Detection is best-effort; never fail (or alter) the memory write.
    logger.debug(`[WriteDedup] similarity scan failed for ${input.memoryId}: ${err}`);
    return null;
  }

  // Re-assert the bar + self-exclusion (defence in depth for injected searchers),
  // then bound to topK.
  const aboveBar = (raw ?? [])
    .filter(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        c.id !== input.memoryId &&
        typeof c.similarity === 'number' &&
        c.similarity >= threshold
    )
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
  if (aboveBar.length === 0) return null;

  // Strict same-scope verification against the stored rows (search mixes in
  // shared global rows on purpose; the dedup stage must not link across
  // project or team scopes, and must skip merged/inactive/dead rows).
  const { db, schema } = await getDbClient();
  const verifyRows = await db
    .select({
      id: schema.memories.id,
      projectId: schema.memories.projectId,
      teamId: (schema.memories as any).teamId,
      isMerged: schema.memories.isMerged,
      isActive: schema.memories.isActive,
      status: (schema.memories as any).status,
    })
    .from(schema.memories)
    .where(inArray(schema.memories.id, aboveBar.map((c) => c.id)));
  const usable = new Set(
    verifyRows.filter((r: any) => isSameScope(r as any, input)).map((r: any) => r.id as string)
  );
  const candidates = aboveBar.filter((c) => usable.has(c.id));
  if (candidates.length === 0) return null;

  const detectedAt = new Date().toISOString();
  const maxSimilarity = candidates[0].similarity;
  const similarIds = candidates.map((c) => c.id);

  if (mode === 'merge') {
    const attempt = await attemptMerge(input.memoryId, input.projectId, candidates);
    if (attempt.ok) {
      const outcome: WriteDedupOutcome = {
        mode: 'merge',
        requestedMode: 'merge',
        detectedAt,
        similarIds,
        maxSimilarity,
        proposalId: attempt.proposalId,
        canonicalMemoryId: attempt.canonicalMemoryId,
        mergeHistoryId: attempt.mergeHistoryId,
      };
      await recordDedupMetadata(input.memoryId, outcome);
      return outcome;
    }
    // Safety first: a blocked merge NEVER mutates. Degrade to linking and
    // count the fallback so operators see it in stats.
    stats.mergeFallbacksToLink += 1;
    await linkCandidates(input.memoryId, candidates);
    const outcome: WriteDedupOutcome = {
      mode: 'link',
      requestedMode: 'merge',
      detectedAt,
      similarIds,
      maxSimilarity,
      fallbackReason: attempt.reason,
      ...(attempt.proposalId ? { proposalId: attempt.proposalId } : {}),
    };
    await recordDedupMetadata(input.memoryId, outcome);
    return outcome;
  }

  // link mode: pure addition of associations + metadata, nothing else.
  await linkCandidates(input.memoryId, candidates);
  const outcome: WriteDedupOutcome = {
    mode: 'link',
    requestedMode: 'link',
    detectedAt,
    similarIds,
    maxSimilarity,
  };
  await recordDedupMetadata(input.memoryId, outcome);
  return outcome;
}
