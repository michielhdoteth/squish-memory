/**
 * Temporal Validity Module
 *
 * TWO concerns live here:
 *
 * 1. Validity-at-T (current, ranking-relevant). A memory is valid at time T
 *    when it was created at or before T and has not been invalidated
 *    (superseded) strictly after T. This replaces the retired flat age
 *    penalty ("old = bad"), which caused a golden-eval breach because a
 *    2022 memory can be perfectly correct for a 2022 query - validity is a
 *    property of (memory, query-time), never of age alone.
 *
 * 2. Legacy staleness heuristics (`detectTemporalReferences`,
 *    `isLikelyStale`). NO LONGER used for ranking anywhere: hybrid-search's
 *    ranking path now uses validity-at-T only. They remain exported because
 *    search-evidence consumes them as additive, evidence-only metadata and
 *    existing tests pin their behavior.
 */

import type { TimeReference } from './temporal-query.js';

export interface TemporalConfig {
  enabled: boolean;
}

/**
 * Small boost applied to memories that are valid exactly at an anchored past
 * reference point. Kept tiny (+0.08) so it can break near-ties toward the
 * historically-correct answer without dominating honest semantic similarity.
 */
export const TEMPORAL_VALID_AT_T_BOOST = 0.08;

/**
 * Normalize a stored temporal value to epoch ms.
 *
 * Handles every shape the codebase produces or persists:
 *   - Date objects (drizzle timestamp-mode reads)
 *   - epoch seconds (raw SQL defaults via strftime('%s','now'), < 1e11)
 *   - epoch milliseconds (numeric strings >= 1e11)
 *   - ISO-8601 strings (benchmark/eval harnesses rewrite created_at as TEXT)
 *
 * Same heuristic as normalizeTimestamp in core/lib/utils.ts and toMs in
 * core/memory/contradiction-resolver.ts. Returns null when unparseable.
 */
export function normalizeTimestampValue(value: Date | string | number | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
  const numeric = typeof value === 'number' ? value : Number(value);
  if (
    Number.isFinite(numeric) &&
    String(value).trim() !== '' &&
    /^\d+$/.test(String(value).trim())
  ) {
    return numeric < 1e11 ? numeric * 1000 : numeric; // seconds -> ms
  }
  const parsed = new Date(value as any).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** Structural surface applyTemporalEligibility / isValidAt need from a memory. */
export interface TemporalValidityInput {
  createdAt?: Date | string | number | null;
  supersededAt?: Date | string | number | null;
}

/**
 * Is this memory valid at instant t?
 *
 *   createdAt <= t AND (supersededAt == null OR supersededAt > t)
 *
 * Boundary semantics (deliberate):
 *   - createdAt === t -> VALID (a fact recorded exactly at T already holds).
 *   - supersededAt === t -> INVALID (the successor replaced it by time T;
 *     the interval [createdAt, supersededAt) is half-open).
 *   - Missing/unparseable createdAt -> NOT valid (cannot establish that the
 *     memory existed at T; strict per the formula above).
 *   - Missing supersededAt -> valid forever after creation (never invalidated).
 */
export function isValidAt(mem: TemporalValidityInput, t: Date): boolean {
  const createdMs = normalizeTimestampValue(mem.createdAt);
  if (createdMs === null) return false;
  const tMs = t.getTime();
  if (createdMs > tMs) return false;

  const supersededMs = normalizeTimestampValue(mem.supersededAt);
  if (supersededMs !== null && supersededMs <= tMs) return false;

  return true;
}

/** Per-candidate eligibility verdict returned by applyTemporalEligibility. */
export interface TemporalEligibility {
  eligible: boolean;
  boost: number;
}

/**
 * Compute per-candidate eligibility + boost for a parsed time reference.
 *
 *   past-anchored   eligible = isValidAt(mem, t); eligible candidates earn
 *                   TEMPORAL_VALID_AT_T_BOOST, ineligible ones boost 0 and
 *                   are expected to be EXCLUDED by the caller (exclusion was
 *                   chosen over heavy penalty: simpler semantics, no way for
 *                   a boosted distractor to outrank a hard-excluded answer).
 *   past-unanchored ALL eligible, boost 0. With no anchor there is nothing to
 *                   judge validity against - downstream integration instead
 *                   relaxes the supersession filter so historically-correct
 *                   answers can surface. No invented boosts here; the
 *                   existing recency-inverse scoring stays the tiebreak.
 *   current / none  All eligible, boost 0 - byte-for-byte today's behavior.
 *
 * The returned array is index-aligned with the candidates input.
 */
export function applyTemporalEligibility(
  candidates: TemporalValidityInput[],
  timeRef: TimeReference
): TemporalEligibility[] {
  if (timeRef.kind === 'past-anchored' && timeRef.t !== null) {
    return candidates.map((mem) => {
      const eligible = isValidAt(mem, timeRef.t as Date);
      return { eligible, boost: eligible ? TEMPORAL_VALID_AT_T_BOOST : 0 };
    });
  }
  // past-unanchored / current / none: neutral pass-through.
  return candidates.map(() => ({ eligible: true, boost: 0 }));
}

/**
 * Temporal reference patterns
 */
const TEMPORAL_PATTERNS = {
  // "as of 2024", "as of January 2024"
  asOf: /\bas\s+of\s+(\w+\s+)?\d{4}\b/gi,

  // "since version 2.0", "since v3.1"
  sinceVersion: /\bsince\s+(?:version\s+|v\s*)?\d+\.\d+/gi,

  // "currently using", "currently on"
  currentlyUsing: /\bcurrently\s+(?:using|on|running|working\s+with)\b/gi,

  // "as of now", "as of today"
  asOfNow: /\bas\s+of\s+(?:now|today|this\s+writing)\b/gi,

  // Year references: "in 2023", "during 2022", "since 2021"
  yearReference: /\b(?:in|during|since|before|after|until)\s+\d{4}\b/gi,

  // Version references: "version 2.0", "v1.5", "v2.3.1"
  versionReference: /\b(?:version\s+|v\s*)\d+\.\d+(?:\.\d+)?\b/gi,

  // Date references: "January 2024", "Jan 2023", "March 15, 2022"
  dateReference: /\b(?:\w+\s+\d{4}|\w+\s+\d{1,2},?\s+\d{4})\b/gi,

  // Relative time: "last week", "next month", "two years ago"
  relativeTime: /\b(?:last|next|past|previous|upcoming)\s+(?:week|month|year|quarter|day)\b/gi,

  // "used to be", "was previously"
  pastTense: /\b(?:used\s+to\s+be|was\s+previously|previously\s+used|formerly)\b/gi,
};

/**
 * Detect temporal references in content
 *
 * @param content - The text content to analyze
 * @returns Object with hasTemporal flag and list of references found
 */
export function detectTemporalReferences(content: string): {
  hasTemporal: boolean;
  references: string[];
} {
  const references: string[] = [];

  // Check each pattern
  for (const [, pattern] of Object.entries(TEMPORAL_PATTERNS)) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      references.push(match[0]);
    }
  }

  // Deduplicate
  const uniqueReferences = [...new Set(references)];

  return {
    hasTemporal: uniqueReferences.length > 0,
    references: uniqueReferences,
  };
}

/**
 * Check if a memory is likely stale based on temporal references
 *
 * LEGACY: flat age heuristic retained ONLY for evidence-only consumers
 * (search-evidence) and their tests. Never use for ranking - see module
 * header for why it was retired from the retrieval path.
 *
 * @param memory - The memory object to check
 * @param memory.content - The memory content
 * @param memory.createdAt - When the memory was created
 * @param memory.lastAccessedAt - When the memory was last accessed (optional)
 * @returns True if the memory is likely stale
 */
export function isLikelyStale(memory: {
  content: string;
  createdAt: string;
  lastAccessedAt?: string;
}): boolean {
  const { content, createdAt, lastAccessedAt } = memory;

  const { hasTemporal, references } = detectTemporalReferences(content);

  if (!hasTemporal) {
    return false;
  }

  const currentYear = new Date().getFullYear();
  const createdDate = new Date(createdAt);
  const ageInDays = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24);

  // Check for old year references
  for (const ref of references) {
    const yearMatch = ref.match(/\b(20\d{2})\b/);
    if (yearMatch) {
      const referencedYear = parseInt(yearMatch[1]);
      const yearAge = currentYear - referencedYear;

      // Reference older than 2 years = stale
      if (yearAge > 2) {
        return true;
      }
    }

    // Check for old version references
    const versionMatch = ref.match(/(?:version\s+|v\s*)(\d+)\.(\d+)/i);
    if (versionMatch) {
      const majorVersion = parseInt(versionMatch[1]);
      const minorVersion = parseInt(versionMatch[2]);

      // Heuristic: very old major versions are likely stale
      // This is a simple heuristic - in production, you'd want domain-specific logic
      if (majorVersion <= 1 && minorVersion <= 2) {
        return true;
      }
    }
  }

  // If memory is very old (more than 180 days) and has temporal references
  if (ageInDays > 180 && hasTemporal) {
    // Check if it was recently accessed
    if (lastAccessedAt) {
      const lastAccessed = new Date(lastAccessedAt);
      const daysSinceAccess = (Date.now() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24);

      // If accessed in last 30 days, not stale
      if (daysSinceAccess < 30) {
        return false;
      }
    }

    // Old memory with temporal references, not recently accessed
    return true;
  }

  return false;
}
