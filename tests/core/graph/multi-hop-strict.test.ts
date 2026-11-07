import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrustBoundaryError } from '../../../core/acl/trust-policy.js';
import { multiHopSearch } from '../../../core/graph/multi-hop-retrieval.js';

const dataDir = join(tmpdir(), `squish-strict-multihop-${randomUUID()}`);
const previous = {
  trust: process.env.SQUISH_TRUST_POLICY,
  caller: process.env.SQUISH_TRUSTED_CALLER_ID,
  data: process.env.SQUISH_DATA_DIR,
  llm: process.env.SQUISH_LLM_ENABLED,
};

describe('strict multi-hop retrieval boundary', () => {
  afterAll(() => {
    if (previous.trust === undefined) delete process.env.SQUISH_TRUST_POLICY;
    else process.env.SQUISH_TRUST_POLICY = previous.trust;
    if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
    else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
    if (previous.data === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = previous.data;
    if (previous.llm === undefined) delete process.env.SQUISH_LLM_ENABLED;
    else process.env.SQUISH_LLM_ENABLED = previous.llm;
  });

  test('audits denial before retrieval and project setup', async () => {
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.SQUISH_LLM_ENABLED = 'true';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-multihop-audit-test';
    let denied = false;
    try {
      await multiHopSearch({ query: 'Which service depends on PostgreSQL?', project: join(dataDir, 'project') });
    } catch (error) {
      denied = error instanceof TrustBoundaryError
        && error.message === "Unscoped graph operation 'multi_hop_retrieval' is disabled under strict trust";
    }
    expect(denied).toBe(true);
    expect(existsSync(dataDir)).toBe(true);
    const { getDb } = await import('../../../db/index.js');
    const db = await getDb();
    const sqlite = db.$client as { prepare: (query: string) => { all: () => Array<Record<string, unknown>>; get: () => { count: number } } };
    const audits = sqlite.prepare(`SELECT actor_hash, resource_hash, asset_type, decision, reason
      FROM trust_audit_log WHERE asset_type = 'graph_operation' AND decision = 'deny'`).all();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_hash).not.toBe('strict-multihop-audit-test');
    expect(audits[0]?.resource_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(audits[0]).toMatchObject({ asset_type: 'graph_operation', decision: 'deny', reason: 'strict_surface' });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(0);
  });
});
