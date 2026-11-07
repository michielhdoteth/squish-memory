import { expect, test } from 'bun:test';
import { createDatabaseClient, runInTransaction } from '../../../core/storage/database.js';

test('PostgreSQL wrappers preserve their dialect and reject the SQLite transaction helper', async () => {
  let queryCalls = 0;
  let callbackCalls = 0;
  const pool = {
    query: async () => { queryCalls += 1; },
    connect: async () => ({ release: () => undefined }),
  };
  const drizzle = {
    $client: pool,
    select: () => undefined,
    insert: () => undefined,
    update: () => undefined,
    delete: () => undefined,
  };
  const client = createDatabaseClient(drizzle);

  expect(client.$clientType).toBe('postgres');
  await expect(runInTransaction(client, async () => {
    callbackCalls += 1;
  })).rejects.toThrow('runInTransaction is SQLite-only. Use db.transaction() for PostgreSQL.');
  expect(queryCalls).toBe(0);
  expect(callbackCalls).toBe(0);
});

test('SQLite wrappers retain the SQLite transaction path', async () => {
  const statements: string[] = [];
  const sqlite = {
    exec: (sql: string) => { statements.push(sql); },
    prepare: () => ({ run: () => undefined }),
  };
  const drizzle = {
    $client: sqlite,
    select: () => undefined,
    insert: () => undefined,
    update: () => undefined,
    delete: () => undefined,
  };
  const client = createDatabaseClient(drizzle);
  let callbackCalls = 0;

  expect(client.$clientType).toBe('sqlite');
  await expect(runInTransaction(client, async () => {
    callbackCalls += 1;
    return 'committed';
  })).resolves.toBe('committed');
  expect(statements).toEqual(['BEGIN', 'COMMIT']);
  expect(callbackCalls).toBe(1);
});
