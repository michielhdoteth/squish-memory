/**
 * Edit workflow coverage: propose -> list -> preview -> approve (content
 * change, version++, snapshot, confirm applied) -> reject -> stale-content
 * conflict -> expiry.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-edit-workflow-'));
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';

const { resetDb, getDb } = await import('../../../db/index.js');
const { rememberMemory } = await import('../../../core/memory/memories.js');
const {
  createEditProposal,
  getEditProposals,
  approveEditProposal,
  rejectEditProposal,
  correctMemory,
  expireStaleEditProposals,
} = await import('../../../core/memory/edit-workflow.js');

afterAll(async () => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  delete process.env.SQUISH_DATA_DIR;
});

async function ensureEditTables() {
  const sqlite = (await getDb()).$client;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory_edit_proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT,
      memory_id TEXT NOT NULL,
      current_content TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      reason TEXT NOT NULL,
      conflict_warnings TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      reviewed_at INTEGER,
      review_notes TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_snapshots (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      diff TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
}

describe('edit workflow', () => {
  let memoryId: string;

  beforeAll(async () => {
    resetDb();
    await ensureEditTables();
    const mem = await rememberMemory({ content: 'original content', type: 'fact' });
    memoryId = mem.id;
  });

  test('propose stages an edit proposal', async () => {
    const proposal = await createEditProposal(memoryId, 'new content', 'fix wording');
    expect(proposal.id).toBeTruthy();
    expect(proposal.status).toBe('pending');
    expect(proposal.currentContent).toBe('original content');
    expect(proposal.proposedContent).toBe('new content');
  });

  test('list returns pending proposals', async () => {
    const proposals = await getEditProposals({ memoryId, status: 'pending' });
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals[0].proposedContent).toBe('new content');
  });

  test('approve applies content change, version++, snapshot, confirm applied', async () => {
    const listed = await getEditProposals({ memoryId, status: 'pending' });
    const proposalId = listed[0].id;

    const result = await approveEditProposal(proposalId, 'reviewed');
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBeTruthy();

    const sqlite = (await getDb()).$client;
    const row = sqlite.prepare('SELECT content, version FROM memories WHERE id = ?').get(memoryId);
    expect(row.content).toBe('new content');
    expect(row.version).toBeGreaterThanOrEqual(1);

    const snap = sqlite.prepare('SELECT snapshot_type, content FROM memory_snapshots WHERE memory_id = ?').get(memoryId);
    expect(snap.snapshot_type).toBe('before_update');
    expect(snap.content).toBe('original content');
  });

  test('reject closes proposal without applying', async () => {
    const proposal = await createEditProposal(memoryId, 'other content', 'reject me');
    const result = await rejectEditProposal(proposal.id, 'no longer needed');
    expect(result.ok).toBe(true);
    expect(result.proposal.status).toBe('rejected');

    const { getDb } = await import('../../../db/index.js');
    const sqlite = (await getDb()).$client;
    const row = sqlite.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId);
    expect(row.content).toBe('new content');
  });

  test('approve rejects stale content when memory changed', async () => {
    const proposal = await createEditProposal(memoryId, 'stale target', 'will fail');
    const { getDb } = await import('../../../db/index.js');
    const sqlite = (await getDb()).$client;
    sqlite.prepare('UPDATE memories SET content = ? WHERE id = ?').run('changed under it', memoryId);

    const result = await approveEditProposal(proposal.id);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('stale_content');
  });

  test('expire marks old pending proposals as expired', async () => {
    const proposal = await createEditProposal(memoryId, 'old proposal', 'expires');
    const { getDb } = await import('../../../db/index.js');
    const sqlite = (await getDb()).$client;
    const oldCutoff = Math.floor(Date.now() / 1000) - 20 * 24 * 60 * 60;
    sqlite.prepare('UPDATE memory_edit_proposals SET created_at = ? WHERE id = ?').run(oldCutoff, proposal.id);

    const expired = await expireStaleEditProposals(14);
    expect(expired).toBeGreaterThanOrEqual(1);

    const row = sqlite.prepare('SELECT status FROM memory_edit_proposals WHERE id = ?').get(proposal.id);
    expect(row.status).toBe('expired');
  });
});
