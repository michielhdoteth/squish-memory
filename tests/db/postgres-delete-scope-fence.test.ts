import { expect, test } from 'bun:test';
import { memories } from '../../db/drizzle/schema-pg.js';
import { deleteMemoryPostgresLocalCompatibleInTransaction } from '../../core/memory/stale-cleaner.js';

test('PostgreSQL delete keeps a row when its locked project no longer matches the expected scope', async () => {
  const lockedSource = { id: 'scope-race-memory', projectId: 'project-now-foreign' };
  const lockRequests: string[] = [];
  const selectedTables: unknown[] = [];
  const deletedTables: unknown[] = [];
  const tx = {
    select: (selection: unknown) => {
      expect(selection).toEqual({ id: memories.id, projectId: memories.projectId });
      return {
        from: (table: unknown) => {
          selectedTables.push(table);
          return {
            where: (_condition: unknown) => ({
              for: (mode: string) => {
                lockRequests.push(mode);
                return {
                  limit: async (count: number) => {
                    expect(count).toBe(1);
                    return [lockedSource];
                  },
                };
              },
            }),
          };
        },
      };
    },
    delete: (table: unknown) => {
      deletedTables.push(table);
      throw new Error('A scope-mismatched source must not reach DELETE.');
    },
  };

  const removed = await deleteMemoryPostgresLocalCompatibleInTransaction(
    tx,
    { memories },
    lockedSource.id,
    'project-observed-before-delete',
  );

  expect(removed).toBe(false);
  expect(selectedTables).toEqual([memories]);
  expect(lockRequests).toEqual(['update']);
  expect(deletedTables).toEqual([]);
});
