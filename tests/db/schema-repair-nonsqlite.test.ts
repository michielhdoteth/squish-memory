import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as actualDbUtils from '../../db/utils.js';

const previousDatabaseUrl = process.env.SQUISH_DATABASE_URL;
process.env.SQUISH_DATABASE_URL = 'postgres://fixture.invalid/squish';

let sqliteCatalogQueries = 0;
let knowledgeMigrationCalls = 0;
const nonSqliteRaw = {
  prepare(sql: string) {
    if (sql.includes('sqlite_master')) sqliteCatalogQueries += 1;
    throw new Error(`unexpected SQL repair query: ${sql}`);
  },
};

mock.module('../../db/index.js', () => ({ getDb: async () => ({ $client: nonSqliteRaw }) }));
// The stub only replaces the driver-sniffing helper; every other export stays real.
mock.module('../../db/utils.js', () => ({
  ...actualDbUtils,
  getRawClient: (database: { $client: typeof nonSqliteRaw }) => database.$client,
}));
mock.module('../../db/schema-probe.js', () => ({
  REQUIRED_INDEXES: [],
  probeSchemaHealth: async () => ({ status: 'ok', missingTables: [], missingColumns: [], indexIssues: [] }),
}));
mock.module('../../db/bootstrap.js', () => ({ ensureSqliteSchema: async () => { throw new Error('SQLite bootstrap must not run'); } }));
mock.module('../../db/schema-ddl.js', () => ({ createSingleTable: () => { throw new Error('SQLite DDL must not run'); } }));
mock.module('../../db/migrations/knowledge.js', () => ({
  runKnowledgeMigrations: async () => { knowledgeMigrationCalls += 1; },
}));

afterAll(() => {
  if (previousDatabaseUrl === undefined) delete process.env.SQUISH_DATABASE_URL;
  else process.env.SQUISH_DATABASE_URL = previousDatabaseUrl;
});

describe('non-SQLite schema repair', () => {
  test('does not inspect the SQLite catalog or invoke projection migrations', async () => {
    const { fixSchemaIssues } = await import('../../db/schema-repair.js');

    await expect(fixSchemaIssues({ fixAll: true, verbose: false })).resolves.toEqual([]);

    expect(sqliteCatalogQueries).toBe(0);
    expect(knowledgeMigrationCalls).toBe(0);
  });
});
