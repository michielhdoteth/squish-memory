/**
 * Epoch timestamp helpers - single source of truth for the seconds-vs-milliseconds
 * ambiguity that squish storage inherits.
 *
 * History: rows written before the millisecond migration store epoch SECONDS in
 * valid_from / valid_to / expires_at; newer rows store MILLISECONDS. Every
 * lifecycle comparison (retrieval, expiry, decay, staleness, resurrection)
 * therefore has to normalize both shapes. That judgment used to be copy-pasted
 * into dozens of query sites, and one site had already drifted to a different
 * threshold. It now lives here, once.
 */

/**
 * Magnitude threshold: raw epoch values at or above this are milliseconds.
 * Below it they are seconds. (1e11 seconds is year 5138; 1e11 ms is 1973-03.)
 */
export const EPOCH_MS_THRESHOLD = 100000000000;

/** True when a raw epoch value is stored in milliseconds rather than seconds. */
export function isEpochMillis(value: number): boolean {
  return Math.abs(value) >= EPOCH_MS_THRESHOLD;
}

/** Normalize a raw epoch value (seconds or milliseconds) to epoch seconds. */
export function toEpochSeconds(value: number): number {
  return isEpochMillis(value) ? Math.floor(value / 1000) : Math.floor(value);
}

/** Normalize a raw epoch value (seconds or milliseconds) to epoch milliseconds. */
export function toEpochMillis(value: number): number {
  return isEpochMillis(value) ? Math.floor(value) : value * 1000;
}

/** SQL fragment coercing a seconds-or-milliseconds epoch column to seconds. */
export function sqlEpochSeconds(column: string): string {
  return `CASE WHEN ABS(${column}) >= ${EPOCH_MS_THRESHOLD} THEN CAST(${column} / 1000 AS INTEGER) ELSE ${column} END`;
}

/**
 * SQL lifecycle bound: the column is NULL or its coerced seconds value
 * satisfies the operator against a bound parameter (`?` by default).
 */
export function sqlLifecycleBound(
  column: string,
  op: '<=' | '<' | '>' | '>=',
  bound: string = '?',
): string {
  return `(${column} IS NULL OR ${sqlEpochSeconds(column)} ${op} ${bound})`;
}

// ---------------------------------------------------------------------------
// JS value ladder (different thresholds from the SQL heuristic above)
// ---------------------------------------------------------------------------

/** Above this magnitude a numeric timestamp is microseconds. */
export const EPOCH_US_THRESHOLD = 100000000000000;

/** Above this magnitude (and below microseconds) a numeric timestamp is milliseconds. */
export const EPOCH_MS_LADDER_THRESHOLD = 1000000000000;

/** Units a numeric epoch value can carry, largest first. */
export type EpochUnit = 'micro' | 'milli' | 'second';

/** Classify a numeric epoch value, or null when it cannot be a timestamp. */
export function epochUnit(value: number): EpochUnit | null {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value > EPOCH_US_THRESHOLD) return 'micro';
  if (value > EPOCH_MS_LADDER_THRESHOLD) return 'milli';
  return 'second';
}

/**
 * The magnitude ladder shared by `core/lib/utils.ts` (normalizeTimestamp) and
 * `core/lib/validation.ts` (validateDate): microseconds, milliseconds, or
 * seconds, exactly as those two copies always applied it. Null for negative
 * or non-finite input.
 */
export function normalizeTimestampLadder(value: number): Date | null {
  const unit = epochUnit(value);
  if (unit === null) return null;
  if (unit === 'micro') return new Date(value / 1000);
  if (unit === 'milli') return new Date(value);
  return new Date(value * 1000);
}

/**
 * Normalize a stored temporal value to epoch milliseconds.
 *
 * Date objects pass through; numeric values and numeric strings below
 * `EPOCH_MS_THRESHOLD` are seconds; anything else parses as a date string.
 * This is the 1e11 variant shared by
 * `core/retrieval/temporal-validity.ts` (normalizeTimestampValue) and
 * `core/memory/contradiction-resolver.ts` (toMs). It intentionally differs
 * from `normalizeTimestampLadder` above: it has no microseconds rule.
 */
export function toEpochMillisFromMixed(value: Date | string | number | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
  const numeric = typeof value === 'number' ? value : Number(value);
  if (
    Number.isFinite(numeric) &&
    String(value).trim() !== '' &&
    /^\d+$/.test(String(value).trim())
  ) {
    return numeric < EPOCH_MS_THRESHOLD ? numeric * 1000 : numeric; // seconds -> ms
  }
  const parsed = new Date(value as any).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
