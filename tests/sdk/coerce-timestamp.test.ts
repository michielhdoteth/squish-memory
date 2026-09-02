/**
 * SDK timestamp-coercion regression tests (Batch 9).
 *
 * The memory benchmark exposed a real crash: SDK result mappers called
 * .toISOString() on mixed-format temporal column values (epoch seconds from
 * drizzle writes, ISO text from harness rewrites, Date objects) and threw
 * RangeError on any format they did not expect. coerceTimestamp now tolerates
 * all three and returns null for unusable values.
 *
 * Extracted from the stale bench test so the regression coverage survives
 * the harness redesign.
 */

import { describe, test, expect } from 'bun:test';
import { coerceTimestamp } from '../../packages/core-sdk/src/index.js';

describe('coerceTimestamp (SDK mapper hardening)', () => {
  test('epoch seconds and milliseconds both coerce', () => {
    expect(coerceTimestamp(1770000000)?.toISOString()).toBe(new Date(1770000000 * 1000).toISOString());
    expect(coerceTimestamp(1770000000000)?.toISOString()).toBe(new Date(1770000000000).toISOString());
  });

  test('ISO text coerces', () => {
    expect(coerceTimestamp('2026-01-01T00:00:00.000Z')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('Date instances pass through', () => {
    const d = new Date('2026-03-04T05:06:07Z');
    expect(coerceTimestamp(d)?.getTime()).toBe(d.getTime());
  });

  test('numeric strings coerce via the number path', () => {
    expect(coerceTimestamp('1770000000')?.getTime()).toBe(new Date(1770000000 * 1000).getTime());
  });

  test('unusable values return null instead of throwing', () => {
    expect(coerceTimestamp(null)).toBeNull();
    expect(coerceTimestamp(undefined)).toBeNull();
    expect(coerceTimestamp('')).toBeNull();
    expect(coerceTimestamp('not-a-date')).toBeNull();
    expect(coerceTimestamp(Number.NaN)).toBeNull();
    expect(coerceTimestamp(new Date('garbage'))).toBeNull();
  });
});
