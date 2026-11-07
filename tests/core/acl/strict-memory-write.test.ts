import { describe, expect, test } from 'bun:test';
import { assertStrictMemoryWriteAtomicity } from '../../../core/acl/strict-memory-write.js';

describe('strict memory write backend gate', () => {
  test('rejects a raw pool that cannot hold a transaction open', () => {
    expect(() => assertStrictMemoryWriteAtomicity({ query() {} }, true))
      .toThrow('Strict memory capture requires atomic source and projection writes');
  });

  test('accepts a transaction-capable Drizzle database in strict mode', () => {
    expect(() => assertStrictMemoryWriteAtomicity({ transaction() {} }, true)).not.toThrow();
  });

  test('accepts SQLite transaction primitives in strict mode', () => {
    expect(() => assertStrictMemoryWriteAtomicity({ exec() {}, prepare() {} }, true)).not.toThrow();
  });

  test('preserves local-compatible writes for other backends', () => {
    expect(() => assertStrictMemoryWriteAtomicity({ query() {} }, false)).not.toThrow();
  });
});
