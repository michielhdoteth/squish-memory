import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { createHash } from 'node:crypto';

const testDataDir = join(tmpdir(), `squish-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

import { describe, it, expect, beforeEach } from 'bun:test';
import { getDb, resetDb } from '../../db/index.js';
import { ensureKnowledgeTables } from '../../core/knowledge/knowledge-crud.js';
import { createKnowledge, deleteKnowledge, getKnowledgeById, searchKnowledge, updateKnowledge } from '../../core/knowledge/knowledge-crud.js';
import { getBeliefsForMemory } from '../../core/knowledge/knowledge-beliefs.js';
import {
  ensureAuditTable,
  logAuditEntry,
  getAuditTrail,
  getProvenanceChain,
} from '../../core/knowledge/audit.js';
import type { AuditAction, AuditEntry, ProvenanceNode } from '../../core/knowledge/audit.js';

async function execSql(sql: string) {
  const db = await getDb();
  const sqlite = (db as any).$client;
  if (sqlite && typeof sqlite.exec === 'function') {
    sqlite.exec(sql);
  }
}

async function clearData() {
  await execSql('DELETE FROM audit_log;');
  await execSql('DELETE FROM knowledge_edges;');
}

beforeEach(async () => {
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  resetDb();
  await ensureKnowledgeTables();
  await ensureAuditTable();
  await clearData();
});

describe('audit_log table', () => {
  it('withholds unscoped audit and provenance reads under strict trust', async () => {
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
    };
    const caller = 'strict-knowledge-audit-reader';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    try {
      await expect(getAuditTrail('k-private')).rejects.toThrow('strict trust');
      await expect(getProvenanceChain('k-private')).rejects.toThrow('strict trust');
      const sqlite = (await getDb() as any).$client;
      const resourceHashes = [
        createHash('sha256').update('knowledge_audit_trail:k-private').digest('hex'),
        createHash('sha256').update('knowledge_provenance_chain:k-private').digest('hex'),
      ];
      const audits = sqlite.prepare(`SELECT actor_hash, resource_hash, asset_type, decision, reason
        FROM trust_audit_log WHERE resource_hash IN (?, ?)`).all(...resourceHashes);
      expect(audits).toHaveLength(2);
      expect(audits.every((row: Record<string, unknown>) => row.actor_hash.length === 64
        && resourceHashes.includes(String(row.resource_hash))
        && row.asset_type.startsWith('knowledge_') && row.decision === 'deny' && row.reason === 'strict_surface')).toBe(true);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
    }
  });

  it('rejects generated context echoes at the direct knowledge-write boundary', async () => {
    const echo = '# Session bootstrap\r\n\r\n## Verified memories\r\n- [fact] The service is active (memory:01234567-89ab-cdef-0123-456789abcdef)';
    await expect(createKnowledge({
      knowledgeKind: 'memory', knowledgeType: 'fact', content: echo,
    })).rejects.toThrow('Generated context cannot be stored as new knowledge');
    await expect(createKnowledge({
      knowledgeKind: 'belief', knowledgeType: 'decision', content: echo,
    })).rejects.toThrow('Generated context cannot be stored as new knowledge');

    const sqlite = (await getDb() as any).$client;
    const stored = sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge WHERE content = ?').get(echo) as { count: number };
    expect(stored.count).toBe(0);
  });

  it('rejects generated context echoes when directly revising knowledge', async () => {
    const fixture = await createKnowledge({
      knowledgeKind: 'belief', knowledgeType: 'decision', content: 'Original belief remains intact.',
    });
    const echo = '# Session bootstrap\n\n## Verified memories\n- [fact] The service is active (memory:01234567-89ab-cdef-0123-456789abcdef)';
    await expect(updateKnowledge(fixture.id, { content: echo }))
      .rejects.toThrow('Generated context cannot replace stored knowledge');
    const row = (await getKnowledgeById(fixture.id))!;
    expect(row.content).toBe('Original belief remains intact.');
  });

  it('ensureAuditTable creates the table', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const table = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'"
    ).get() as { name: string } | undefined;
    expect(table).toBeDefined();
    expect(table!.name).toBe('audit_log');
  });

  it('ensureAuditTable is idempotent', async () => {
    await ensureAuditTable();
    await ensureAuditTable();
    const db = await getDb();
    const sqlite = (db as any).$client;
    const count = sqlite.prepare(
      "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='audit_log'"
    ).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('withholds direct knowledge reads and updates under strict trust', async () => {
    const fixture = await createKnowledge({
      knowledgeKind: 'belief',
      knowledgeType: 'constraint',
      content: 'Private fixture knowledge remains unchanged.',
    });
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
    };
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-belief-reader';
    try {
      await expect(getKnowledgeById(fixture.id)).rejects.toThrow('strict trust');
      await expect(searchKnowledge({ projectId: 'strict-knowledge-read-project' })).rejects.toThrow('strict trust');
      await expect(getBeliefsForMemory(fixture.id)).rejects.toThrow('strict trust');
      await expect(updateKnowledge(fixture.id, { content: 'Unauthorized update.' })).rejects.toThrow('strict trust');
      await expect(deleteKnowledge(fixture.id)).rejects.toThrow('strict trust');
      await expect(createKnowledge({
        knowledgeKind: 'belief', knowledgeType: 'constraint', content: 'Unauthorized derived belief.',
      })).rejects.toThrow('signed source memory');
      const db = await getDb();
      const sqlite = (db as any).$client;
      const row = sqlite.prepare('SELECT content FROM knowledge WHERE id = ?').get(fixture.id) as { content: string };
      expect(row.content).toBe('Private fixture knowledge remains unchanged.');
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge WHERE id = ?').get(fixture.id).count).toBe(1);
      const rejectedInsert = sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge WHERE content = ?')
        .get('Unauthorized derived belief.') as { count: number };
      expect(rejectedInsert.count).toBe(0);
      const resourceHash = createHash('sha256').update(`beliefs_for_memory:${fixture.id}`).digest('hex');
      const denial = sqlite.prepare(`SELECT resource_hash, asset_type, decision, reason
        FROM trust_audit_log WHERE resource_hash = ?`).get(resourceHash);
      expect(denial).toEqual({ resource_hash: resourceHash, asset_type: 'belief', decision: 'deny', reason: 'strict_surface' });
      const directDenials = [
        [`knowledge_read:${fixture.id}`, 'knowledge'],
        ['knowledge_search:strict-knowledge-read-project', 'knowledge'],
        [`knowledge_update:${fixture.id}`, 'knowledge'],
        [`knowledge_delete:${fixture.id}`, 'knowledge'],
      ] as const;
      for (const [resourceId, assetType] of directDenials) {
        const hash = createHash('sha256').update(resourceId).digest('hex');
        const audit = sqlite.prepare(`SELECT resource_hash, asset_type, decision, reason
          FROM trust_audit_log WHERE resource_hash = ?`).get(hash);
        expect(audit).toEqual({ resource_hash: hash, asset_type: assetType, decision: 'deny', reason: 'strict_surface' });
      }
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
    }
  });
});

describe('logAuditEntry', () => {
  it('creates an audit entry and returns it with id', async () => {
    const entry = await logAuditEntry({
      knowledgeId: 'k-1',
      action: 'create' as AuditAction,
      agentId: 'agent-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      details: { content: 'test' },
    });

    expect(entry.id).toBeDefined();
    expect(entry.knowledgeId).toBe('k-1');
    expect(entry.action).toBe('create');
    expect(entry.agentId).toBe('agent-1');
    expect(entry.projectId).toBe('proj-1');
    expect(entry.sessionId).toBe('sess-1');
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it('persists the entry to the database', async () => {
    await logAuditEntry({
      knowledgeId: 'k-2',
      action: 'update' as AuditAction,
      agentId: 'agent-2',
      details: { field: 'status' },
    });

    const db = await getDb();
    const sqlite = (db as any).$client;
    const row = sqlite.prepare('SELECT * FROM audit_log WHERE knowledge_id = ?').get('k-2') as any;
    expect(row).toBeDefined();
    expect(row.action).toBe('update');
    expect(row.agent_id).toBe('agent-2');
  });

  it('stores details as JSON', async () => {
    await logAuditEntry({
      knowledgeId: 'k-3',
      action: 'update' as AuditAction,
      details: { field: 'status', oldValue: 'active', newValue: 'deprecated' },
    });

    const db = await getDb();
    const sqlite = (db as any).$client;
    const row = sqlite.prepare('SELECT * FROM audit_log WHERE knowledge_id = ?').get('k-3') as any;
    const details = JSON.parse(row.details);
    expect(details.field).toBe('status');
    expect(details.oldValue).toBe('active');
    expect(details.newValue).toBe('deprecated');
  });

  it('handles null optional fields', async () => {
    const entry = await logAuditEntry({
      knowledgeId: 'k-4',
      action: 'delete' as AuditAction,
    });
    expect(entry.agentId).toBeNull();
    expect(entry.projectId).toBeNull();
    expect(entry.sessionId).toBeNull();
    expect(entry.details).toBeNull();
  });
});

describe('getAuditTrail', () => {
  it('returns empty array for unknown knowledge', async () => {
    const trail = await getAuditTrail('non-existent');
    expect(trail).toEqual([]);
  });

  it('returns entries for a knowledge id ordered by created_at desc', async () => {
    await logAuditEntry({ knowledgeId: 'k-5', action: 'create' as AuditAction, agentId: 'a1' });
    await logAuditEntry({ knowledgeId: 'k-5', action: 'update' as AuditAction, agentId: 'a1' });
    await logAuditEntry({ knowledgeId: 'k-5', action: 'read' as AuditAction, agentId: 'a2' });

    const trail = await getAuditTrail('k-5');
    expect(trail.length).toBe(3);
    // Most recent first
    expect(trail[0].action).toBe('read');
    expect(trail[1].action).toBe('update');
    expect(trail[2].action).toBe('create');
  });

  it('filters by action', async () => {
    await logAuditEntry({ knowledgeId: 'k-6', action: 'create' as AuditAction });
    await logAuditEntry({ knowledgeId: 'k-6', action: 'update' as AuditAction });
    await logAuditEntry({ knowledgeId: 'k-6', action: 'update' as AuditAction });

    const trail = await getAuditTrail('k-6', { action: 'update' as AuditAction });
    expect(trail.length).toBe(2);
    expect(trail.every(e => e.action === 'update')).toBe(true);
  });

  it('respects limit option', async () => {
    for (let i = 0; i < 10; i++) {
      await logAuditEntry({ knowledgeId: 'k-7', action: 'read' as AuditAction });
    }
    const trail = await getAuditTrail('k-7', { limit: 3 });
    expect(trail.length).toBe(3);
  });

  it('filters by agent', async () => {
    await logAuditEntry({ knowledgeId: 'k-8', action: 'create' as AuditAction, agentId: 'agent-A' });
    await logAuditEntry({ knowledgeId: 'k-8', action: 'update' as AuditAction, agentId: 'agent-B' });

    const trail = await getAuditTrail('k-8', { agentId: 'agent-B' });
    expect(trail.length).toBe(1);
    expect(trail[0].agentId).toBe('agent-B');
  });
});

describe('getProvenanceChain', () => {
  it('returns empty array for non-existent knowledge', async () => {
    const chain = await getProvenanceChain('non-existent');
    expect(chain).toEqual([]);
  });

  it('returns single node when no provenance edges exist', async () => {
    // Create a knowledge record so it exists
    await execSql(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES ('k-9', 'memory', 'fact', 'test')`);
    const chain = await getProvenanceChain('k-9');
    expect(chain.length).toBe(1);
    expect(chain[0].knowledgeId).toBe('k-9');
    expect(chain[0].depth).toBe(0);
  });

  it('follows sourced_from edges', async () => {
    await execSql(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES ('k-10', 'memory', 'fact', 'test'), ('k-11', 'memory', 'fact', 'test')`);
    await execSql(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at) VALUES ('e-1', 'k-10', 'knowledge', 'k-11', 'knowledge', 'sourced_from', 1.0, strftime('%s','now'))`);

    const chain = await getProvenanceChain('k-10');
    expect(chain.length).toBe(2);
    expect(chain[0].knowledgeId).toBe('k-10');
    expect(chain[0].depth).toBe(0);
    expect(chain[1].knowledgeId).toBe('k-11');
    expect(chain[1].depth).toBe(1);
    expect(chain[1].edgeType).toBe('sourced_from');
  });

  it('follows informed_by edges', async () => {
    await execSql(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES ('k-12', 'memory', 'fact', 'test'), ('k-13', 'memory', 'fact', 'test')`);
    await execSql(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at) VALUES ('e-2', 'k-12', 'knowledge', 'k-13', 'knowledge', 'informed_by', 1.0, strftime('%s','now'))`);

    const chain = await getProvenanceChain('k-12');
    expect(chain.length).toBe(2);
    expect(chain[1].knowledgeId).toBe('k-13');
    expect(chain[1].edgeType).toBe('informed_by');
  });

  it('follows extends edges', async () => {
    await execSql(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES ('k-14', 'memory', 'fact', 'test'), ('k-15', 'memory', 'fact', 'test')`);
    await execSql(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at) VALUES ('e-3', 'k-14', 'knowledge', 'k-15', 'knowledge', 'extends', 1.0, strftime('%s','now'))`);

    const chain = await getProvenanceChain('k-14');
    expect(chain.length).toBe(2);
    expect(chain[1].knowledgeId).toBe('k-15');
    expect(chain[1].edgeType).toBe('extends');
  });

  it('follows multi-hop chains', async () => {
    await execSql(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES ('k-16', 'memory', 'fact', 'test'), ('k-17', 'memory', 'fact', 'test'), ('k-18', 'memory', 'fact', 'test')`);
    await execSql(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at) VALUES ('e-4', 'k-16', 'knowledge', 'k-17', 'knowledge', 'sourced_from', 1.0, strftime('%s','now'))`);
    await execSql(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at) VALUES ('e-5', 'k-17', 'knowledge', 'k-18', 'knowledge', 'sourced_from', 1.0, strftime('%s','now'))`);

    const chain = await getProvenanceChain('k-16');
    expect(chain.length).toBe(3);
    expect(chain[0].knowledgeId).toBe('k-16');
    expect(chain[1].knowledgeId).toBe('k-17');
    expect(chain[2].knowledgeId).toBe('k-18');
    expect(chain[2].depth).toBe(2);
  });

  it('respects maxDepth', async () => {
    await execSql(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES ('k-19', 'memory', 'fact', 'test'), ('k-20', 'memory', 'fact', 'test'), ('k-21', 'memory', 'fact', 'test')`);
    await execSql(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at) VALUES ('e-6', 'k-19', 'knowledge', 'k-20', 'knowledge', 'sourced_from', 1.0, strftime('%s','now'))`);
    await execSql(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at) VALUES ('e-7', 'k-20', 'knowledge', 'k-21', 'knowledge', 'sourced_from', 1.0, strftime('%s','now'))`);

    const chain = await getProvenanceChain('k-19', 1);
    expect(chain.length).toBe(2);
    const ids = chain.map(n => n.knowledgeId);
    expect(ids).toContain('k-19');
    expect(ids).toContain('k-20');
    expect(ids).not.toContain('k-21');
  });

  it('handles cycles without infinite loop', async () => {
    await execSql(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES ('k-22', 'memory', 'fact', 'test'), ('k-23', 'memory', 'fact', 'test')`);
    await execSql(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at) VALUES ('e-8', 'k-22', 'knowledge', 'k-23', 'knowledge', 'sourced_from', 1.0, strftime('%s','now'))`);
    await execSql(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at) VALUES ('e-9', 'k-23', 'knowledge', 'k-22', 'knowledge', 'sourced_from', 1.0, strftime('%s','now'))`);

    const chain = await getProvenanceChain('k-22');
    expect(chain.length).toBeLessThanOrEqual(2);
  });

  it('only follows provenance edge types', async () => {
    await execSql(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES ('k-24', 'memory', 'fact', 'test'), ('k-25', 'memory', 'fact', 'test')`);
    await execSql(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at) VALUES ('e-10', 'k-24', 'knowledge', 'k-25', 'knowledge', 'related_to', 1.0, strftime('%s','now'))`);

    const chain = await getProvenanceChain('k-24');
    expect(chain.length).toBe(1);
    expect(chain[0].knowledgeId).toBe('k-24');
  });
});
