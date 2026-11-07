import { afterAll, describe, expect, it, mock } from 'bun:test';

let sqlCalls = 0;
const postgresClient = {
  query: async () => {
    sqlCalls++;
    return { rows: [] };
  },
};
const postgresDb = { $clientType: 'postgres', $client: postgresClient };

mock.module('../../../core/lib/db-client.js', () => ({
  getDbClient: async () => ({ db: postgresDb, raw: postgresDb, schema: {} }),
}));

const envKeys = [
  'SQUISH_TRUST_POLICY', 'SQUISH_ENCRYPTION_ENABLED', 'SQUISH_ENCRYPTION_PASSPHRASE',
] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.SQUISH_TRUST_POLICY = 'local-compatible';
process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'synthetic-postgres-index-passphrase';

const { forgetCapturedSession, recoverCapturedSession } = await import('../../../core/sessions/store.js');

describe('encrypted private session index PostgreSQL boundary', () => {
  afterAll(() => {
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects encrypted-session forgetting before reads or SQL mutations when the SQLite index is unavailable', async () => {
    let sourceReadCalls = 0;
    sqlCalls = 0;

    await expect(forgetCapturedSession({
      sessionId: 'synthetic-postgres-session',
      readTaggedMemories: async (ids) => {
        sourceReadCalls++;
        return ids.map((id) => ({ id }));
      },
    })).rejects.toThrow('Encrypted session recovery requires the SQLite private index');

    expect(sourceReadCalls).toBe(0);
    expect(sqlCalls).toBe(0);
  });

  it('rejects encrypted-session recovery before source reads or SQL when the SQLite index is unavailable', async () => {
    let sourceReadCalls = 0;
    sqlCalls = 0;

    await expect(recoverCapturedSession({
      sessionId: 'synthetic-postgres-session',
      readTaggedMemories: async (ids) => {
        sourceReadCalls++;
        return ids.map((id) => ({ id, type: 'observation', content: 'must not be read', tags: [] }));
      },
    })).rejects.toThrow('Encrypted session recovery requires the SQLite private index');

    expect(sourceReadCalls).toBe(0);
    expect(sqlCalls).toBe(0);
  });
});
