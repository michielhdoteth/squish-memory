import { describe, expect, test, mock } from 'bun:test';

let postgresQueries = 0;

mock.module('../../db/index.js', () => ({
  getDb: async () => ({}),
}));
mock.module('../../db/schema.js', () => ({
  getSchema: async () => ({}),
}));
mock.module('../../core/lib/db-client.js', () => ({
  getDbClient: async () => ({
    raw: {
      query: async () => {
        postgresQueries++;
        return { rows: [] };
      },
    },
  }),
}));

describe('non-SQLite stale cleanup guard', () => {
  test('single and batch destructive cleanup fail closed before issuing SQL', async () => {
    const { deleteMemoryPermanently, runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const message = 'requires a transaction-capable SQLite client';

    await expect(deleteMemoryPermanently('pg-memory')).rejects.toThrow(message);
    await expect(runAutoClean()).rejects.toThrow(message);
    expect(postgresQueries).toBe(0);
  });
});
