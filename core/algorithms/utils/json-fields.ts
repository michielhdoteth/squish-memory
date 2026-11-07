/**
 * Tolerant readers for JSON-encoded text columns in SQLite
 * (values may be stored as JSON strings or already-parsed arrays/objects
 * depending on the write path / backend).
 */

import { toEpochMillisFromMixed } from '../../lib/timestamps.js';

export function asArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Convert a timestamp cell (Date | epoch seconds | epoch millis | ISO string)
 * to ISO 8601, returning '' for null/invalid values instead of throwing.
 * Numbers go through the shared mixed-value ladder so a millisecond cell is
 * not silently read as seconds (which would anchor it in the far future).
 */
export function toIsoString(value: unknown): string {
  if (!value) return '';
  const ms = toEpochMillisFromMixed(value as string | number | Date | null | undefined);
  return ms === null ? '' : new Date(ms).toISOString();
}
