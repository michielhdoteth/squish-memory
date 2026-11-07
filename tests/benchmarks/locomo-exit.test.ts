import { describe, expect, test } from 'bun:test';
import { getLoCoMoBenchmarkExitCode } from '../../benchmark/runners/locomo.js';

describe('LoCoMo benchmark process status', () => {
  test('returns failure when any question exhausted its retries', () => {
    expect(getLoCoMoBenchmarkExitCode({ results: { failed: 1 } })).toBe(1);
    expect(getLoCoMoBenchmarkExitCode({ results: { failed: 8 } })).toBe(1);
  });

  test('succeeds when there are no failed questions, including intentional partial runs', () => {
    expect(getLoCoMoBenchmarkExitCode({ results: { failed: 0 } })).toBe(0);
  });
});
