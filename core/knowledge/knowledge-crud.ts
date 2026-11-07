/**
 * Knowledge CRUD — Table creation, insert, read, update, delete, and search.
 *
 * Single responsibility: managing the `knowledge` table lifecycle and records.
 * Edge operations live in knowledge-edges.ts; belief adapters in knowledge-beliefs.ts.
 */

import { randomUUID } from 'crypto';
import { config } from '../../config.js';
import { getDbClient } from '../lib/db-client.js';
import { logger } from '../logger.js';
import { serializeJson, toKnowledge } from './helpers.js';
import { logAuditEntry } from './audit.js';
import { isStrictTrustPolicy, TrustBoundaryError } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';
import { signMemoryProvenance, verifyMemoryProvenance, verifySignedBeliefProjection } from '../acl/provenance.js';
import { decrypt } from '../security/encrypt.js';
import type { DrizzleExecutor } from '../storage/database.js';
import { deserializeMetadata } from '../memory/serialization.js';
import { isGeneratedContextEcho } from '../memory/context-echo.js';
import type {
  Knowledge,
  KnowledgeKind,
  KnowledgeType,
  KnowledgeStatus,
  CreateKnowledgeInput,
} from './types.js';

// ─── Table Creation ──────────────────────────────────────────────────────────

/**
 * Ensure the knowledge and knowledge_edges tables exist.
 * Called lazily on first operation.
 */
export async function ensureKnowledgeTables(): Promise<void> {
  if (config.mode === 'team') return;
  const { raw } = await getDbClient();
  const sqlite = (raw as any).$client;
  if (!sqlite || typeof sqlite.prepare !== 'function') return;

  const tableCheck = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge'"
  ).get() as { name: string } | undefined;

  if (!tableCheck) {
    logger.info('Migration: Creating knowledge tables');
    try {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS knowledge (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT,
          agent_id TEXT,
          session_id TEXT,
          knowledge_kind TEXT NOT NULL,
          knowledge_type TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT,
          embedding_json TEXT,
          embedding BLOB,
          confidence REAL DEFAULT 0.5,
          confidence_level TEXT DEFAULT 'certain',
          importance_score REAL DEFAULT 0.5,
          importance_decay_rate REAL DEFAULT 30,
          last_importance_recalc INTEGER,
          normalized_key TEXT,
          reason TEXT,
          evidence_summary TEXT,
          last_confirmed_at INTEGER,
          source_count INTEGER DEFAULT 1,
          title TEXT,
          description TEXT,
          steps TEXT,
          success_criteria TEXT,
          failure_indicators TEXT,
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          failure_count INTEGER DEFAULT 0,
          last_used_at INTEGER,
          last_success_at INTEGER,
          last_failure_at INTEGER,
          status TEXT DEFAULT 'active',
          superseded_by TEXT,
          contradicts_id TEXT,
          informed_by_id TEXT,
          tags TEXT,
          metadata TEXT,
          place_id TEXT,
          primary_place TEXT,
          sector TEXT DEFAULT 'general',
          tier TEXT DEFAULT 'episodic',
          is_active INTEGER DEFAULT 1,
          created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
          updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
        )
      `);

      // Create indexes
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_project_idx ON knowledge(project_id)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_kind_idx ON knowledge(knowledge_kind)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_type_idx ON knowledge(knowledge_type)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_status_idx ON knowledge(status)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_session_idx ON knowledge(session_id)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_project_kind_idx ON knowledge(project_id, knowledge_kind)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_created_idx ON knowledge(created_at)`);
    } catch (error) {
      logger.warn(`Migration: Could not create knowledge table: ${error}`);
    }
  }

  // Ensure knowledge_edges table
  const edgesCheck = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_edges'"
  ).get() as { name: string } | undefined;

  if (!edgesCheck) {
    try {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_edges (
          id TEXT PRIMARY KEY,
          from_id TEXT NOT NULL,
          from_kind TEXT NOT NULL,
          to_id TEXT NOT NULL,
          to_kind TEXT NOT NULL,
          edge_type TEXT NOT NULL,
          weight REAL DEFAULT 1.0,
          metadata TEXT,
          created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
          valid_from INTEGER,
          valid_to INTEGER,
          recorded_at INTEGER,
          recorded_to INTEGER
        )
      `);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_from_idx ON knowledge_edges(from_id, from_kind)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_to_idx ON knowledge_edges(to_id, to_kind)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_type_idx ON knowledge_edges(edge_type)`);
      // Declared in db/bootstrap.ts and db/drizzle/schema-sqlite.ts:987,989 but
      // previously missing here, so this copy of the DDL created the table with
      // four indexes where the other definitions create six. Bootstrap's replay
      // masked it on every normal connect; the gap only showed when this
      // fallback was the sole creator. Keep all knowledge_edges definitions in
      // agreement - tests/db/knowledge-edges-ddl-parity.test.ts enforces it.
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_from_kind_idx ON knowledge_edges(from_kind)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_to_kind_idx ON knowledge_edges(to_kind)`);
      sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS knowledge_edges_unique ON knowledge_edges(from_id, from_kind, to_id, to_kind, edge_type, valid_from, recorded_at)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_valid_time_idx ON knowledge_edges(valid_from, valid_to, recorded_at, recorded_to)`);
    } catch (error) {
      logger.warn(`Migration: Could not create knowledge_edges table: ${error}`);
    }
  }
}

async function authorizeStrictSourceRead(sourceId: string, executor?: DrizzleExecutor): Promise<void> {
  if (!isStrictTrustPolicy()) return;
  const { resolveTrustedCallerId } = await import('../acl/trust-policy.js');
  const callerId = resolveTrustedCallerId();
  if (!callerId) throw new TrustBoundaryError('Source memory access requires a bound caller');
  const { preauthorizeStrictMemoryReadBeforeDecrypt } = await import('../acl/read-gate.js');
  if (!await preauthorizeStrictMemoryReadBeforeDecrypt(sourceId, callerId, executor)) {
    throw new TrustBoundaryError('Source memory is not readable by the authenticated principal');
  }
}

// ─── Knowledge CRUD ──────────────────────────────────────────────────────────

/**
 * Insert a new knowledge record.
 */
export async function createKnowledge(input: CreateKnowledgeInput, executor?: DrizzleExecutor): Promise<Knowledge> {
  if (isStrictTrustPolicy() && input.knowledgeKind !== 'memory' && input.knowledgeKind !== 'belief') {
    throw new TrustBoundaryError('Strict trust requires source-verified knowledge derivation');
  }
  if (input.knowledgeKind === 'memory' && !input.sourceMemoryId) {
    if (isStrictTrustPolicy()) throw new TrustBoundaryError('Strict trust requires source-linked memory projections');
  }
  if (isGeneratedContextEcho(input.content)) {
    throw new Error('Generated context cannot be stored as new knowledge');
  }
  let metadata = input.metadata ?? null;
  let encryptedProjection: { ciphertext: string; nonce: string } | null = null;
  if (input.knowledgeKind === 'memory') {
    if (!input.sourceMemoryId) {
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Strict trust requires source-linked memory projections');
    } else {
      if (metadata?.sourceMemoryId !== input.sourceMemoryId) {
        throw new TrustBoundaryError('Memory projection source lineage does not match its metadata');
      }
      const encryptedSourceMetadata = metadata?.encrypted === true;
      const provenance = encryptedSourceMetadata ? null : signMemoryProvenance({
        content: input.content,
        projectId: input.projectId ?? null,
        type: input.knowledgeType,
        ownerId: input.ownerId ?? null,
        teamId: input.teamId ?? null,
        sourceMemoryId: input.sourceMemoryId,
        metadata,
      });
      if (!encryptedSourceMetadata && !provenance && isStrictTrustPolicy()) {
        throw new TrustBoundaryError('Strict trust requires provenance signing keys for memory projections');
      }
      if (provenance) metadata = { ...metadata, __squishProvenance: provenance };
    }
  }
  await ensureKnowledgeTables();
  const { getDb } = await import('../../db/index.js');
  const { getSchema } = await import('../../db/schema.js');
  const db = executor ?? await getDb();
  const schema = await getSchema();
  if (isStrictTrustPolicy() && input.knowledgeKind === 'belief') {
    const sourceMemoryId = typeof metadata?.sourceMemoryId === 'string' ? metadata.sourceMemoryId : null;
    if (!sourceMemoryId) {
      throw new TrustBoundaryError('Strict belief creation requires a signed source memory');
    }
    const { eq } = await import('drizzle-orm');
    const [source] = await (db as any).select().from(schema.memories)
      .where(eq(schema.memories.id, sourceMemoryId)).limit(1);
    if (!source || (input.projectId && source.projectId !== input.projectId)) {
      throw new TrustBoundaryError('Strict belief source is unavailable in the requested project');
    }
    if (Boolean(source.isEncrypted ?? source.is_encrypted)) {
      if (!source.encryptedContent || !source.encryptionNonce) {
        throw new TrustBoundaryError('Encrypted belief source is missing ciphertext metadata');
      }
      await authorizeStrictSourceRead(source.id);
    }
    const sourceContent = source.isEncrypted
      ? decrypt(source.encryptedContent, source.encryptionNonce)
      : source.content;
    const sourceMetadata = deserializeMetadata(source.metadata) ?? null;
    if (!verifyMemoryProvenance({
      content: sourceContent, projectId: source.projectId ?? null, type: source.type,
      ownerId: source.userId ?? null, teamId: source.teamId ?? null,
      sourceMemoryId: source.id, metadata: sourceMetadata,
    })) {
      throw new TrustBoundaryError('Strict belief source provenance is invalid');
    }
    const { resolveTrustedCallerId } = await import('../acl/trust-policy.js');
    const callerId = resolveTrustedCallerId();
    if (!callerId) throw new TrustBoundaryError('Strict belief creation requires a bound caller');
    const { applyAclReadGate } = await import('../acl/read-gate.js');
    const readable = await applyAclReadGate([{
      id: source.id, projectId: source.projectId ?? null, content: sourceContent,
      type: source.type, userId: source.userId ?? null, teamId: source.teamId ?? null,
      status: source.status, isActive: source.isActive, expiresAt: source.expiresAt ?? null,
      metadata: sourceMetadata,
    }], { userId: callerId }, () => 'memory');
    if (readable.length !== 1) throw new TrustBoundaryError('Strict belief source is not readable by the authenticated principal');
    if (!verifySignedBeliefProjection({
      content: input.content, projectId: source.projectId ?? null, type: input.knowledgeType,
      ownerId: source.userId ?? null, teamId: source.teamId ?? null, sourceMemoryId: source.id,
      metadata: metadata ?? {}, confidence: input.confidence ?? 0.5,
      status: input.status ?? 'active', reason: input.reason ?? null,
      evidenceSummary: input.evidenceSummary ?? null,
    })) {
      throw new TrustBoundaryError('Strict belief creation requires a valid signed single-source projection');
    }
  }
  if (input.knowledgeKind === 'memory' && input.sourceMemoryId) {
    const { eq } = await import('drizzle-orm');
    const [source] = await (db as any).select().from(schema.memories)
      .where(eq(schema.memories.id, input.sourceMemoryId)).limit(1);
    const encryptedSource = Boolean(source?.isEncrypted ?? source?.is_encrypted);
    const sourceCiphertext = source?.encryptedContent ?? source?.encrypted_content;
    const sourceNonce = source?.encryptionNonce ?? source?.encryption_nonce;
    if (source && encryptedSource) {
      if (!sourceCiphertext || !sourceNonce) {
        throw new TrustBoundaryError('Encrypted memory projection source is missing ciphertext metadata');
      }
    }
    // Strict projection creation is caller-bound even for plaintext
    // sources. A valid signature proves origin and integrity, not permission
    // for this caller to derive and receive a projection from that source.
    if (source && isStrictTrustPolicy()) await authorizeStrictSourceRead(source.id, executor);
    const sourceContent = encryptedSource
      ? decrypt(sourceCiphertext, sourceNonce)
      : source?.content;
    if (encryptedSource) {
      encryptedProjection = { ciphertext: sourceCiphertext, nonce: sourceNonce };
    }
    if (!source || sourceContent !== input.content || (source.projectId ?? null) !== (input.projectId ?? null)
      || source.type !== input.knowledgeType || (source.userId ?? null) !== (input.ownerId ?? null)
      || (source.teamId ?? null) !== (input.teamId ?? null)) {
      throw new TrustBoundaryError(`Memory projection source mismatch: ${JSON.stringify({
        exists: Boolean(source), content: sourceContent === input.content,
        project: (source?.projectId ?? null) === (input.projectId ?? null),
        type: source?.type === input.knowledgeType,
        owner: (source?.userId ?? null) === (input.ownerId ?? null),
        team: (source?.teamId ?? null) === (input.teamId ?? null),
      })}`);
    }
    const sourceMetadata = deserializeMetadata(source.metadata) ?? null;
    if (isStrictTrustPolicy() && !verifyMemoryProvenance({
      content: sourceContent,
      projectId: source.projectId ?? null,
      type: source.type,
      ownerId: source.userId ?? null,
      teamId: source.teamId ?? null,
      sourceMemoryId: input.sourceMemoryId,
      metadata: sourceMetadata,
    })) {
      throw new TrustBoundaryError('Strict trust requires a provenance-verified memory projection source');
    }
  }
  const id = randomUUID();
  const now = new Date();
  const [row] = await (db as any).insert(schema.knowledge).values({
    id,
    projectId: input.projectId ?? null,
    userId: input.userId ?? null,
    agentId: input.agentId ?? null,
    sessionId: input.sessionId ?? null,
    knowledgeKind: input.knowledgeKind,
    knowledgeType: input.knowledgeType,
    content: encryptedProjection ? '' : input.content,
    encryptedContent: encryptedProjection?.ciphertext ?? null,
    encryptionNonce: encryptedProjection?.nonce ?? null,
    isEncrypted: Boolean(encryptedProjection),
    summary: encryptedProjection ? null : input.summary ?? null,
    confidence: input.confidence ?? 0.5,
    confidenceLevel: input.confidenceLevel ?? 'certain',
    importanceScore: input.importanceScore ?? 0.5,
    importanceDecayRate: input.importanceDecayRate ?? 30,
    normalizedKey: input.normalizedKey ?? null,
    reason: input.reason ?? null,
    evidenceSummary: input.evidenceSummary ?? null,
    title: input.title ?? null,
    description: input.description ?? null,
    steps: input.steps ? JSON.stringify(input.steps) : null,
    successCriteria: input.successCriteria ?? null,
    failureIndicators: input.failureIndicators ?? null,
    status: input.status ?? 'active',
    tags: encryptedProjection ? null : input.tags ? JSON.stringify(input.tags) : null,
    metadata: (await import('../../config.js')).config.mode === 'team'
      ? metadata
      : serializeJson(metadata),
    placeId: input.placeId ?? null,
    primaryPlace: input.primaryPlace ?? null,
    sector: input.sector ?? 'general',
    tier: input.tier ?? 'episodic',
    isActive: input.isActive ?? true,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    recordedAt: input.recordedAt ?? now,
    createdAt: now,
    updatedAt: now,
  }).returning();
  if (!row) throw new Error(`Failed to create knowledge record with id ${id}`);
  const knowledge = toKnowledge(row);
  await logAuditEntry({
    knowledgeId: knowledge.id,
    action: 'create',
    agentId: input.agentId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    details: { kind: input.knowledgeKind, type: input.knowledgeType },
  }, executor);
  return knowledge;
}

/**
 * Get a knowledge record by ID.
 */
export async function getKnowledgeById(id: string): Promise<Knowledge | null> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(`knowledge_read:${id}`, 'knowledge', 'Unscoped knowledge reads are disabled under strict trust');
  }
  await ensureKnowledgeTables();
  const { getDb } = await import('../../db/index.js');
  const { getSchema } = await import('../../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const db = await getDb();
  const schema = await getSchema();
  const [row] = await (db as any).select().from(schema.knowledge).where(eq(schema.knowledge.id, id)).limit(1);
  return row ? toKnowledge(row) : null;
}

/**
 * Update a knowledge record.
 */
export async function updateKnowledge(
  id: string,
  updates: Partial<CreateKnowledgeInput>
): Promise<Knowledge | null> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(`knowledge_update:${id}`, 'knowledge', 'Unscoped knowledge updates are disabled under strict trust');
  }
  if (typeof updates.content === 'string' && isGeneratedContextEcho(updates.content)) {
    throw new Error('Generated context cannot replace stored knowledge');
  }
  await ensureKnowledgeTables();
  const { raw } = await getDbClient();
  const sqlite = (raw as any).$client;
  if (!sqlite) return null;

  const setClauses: string[] = [];
  const values: any[] = [];

  const fieldMap: Record<string, [string, (v: any) => any]> = {
    knowledgeKind: ['knowledge_kind', (v: string) => v],
    knowledgeType: ['knowledge_type', (v: string) => v],
    content: ['content', (v: string) => v],
    summary: ['summary', (v: string) => v],
    confidence: ['confidence', (v: number) => v],
    confidenceLevel: ['confidence_level', (v: string) => v],
    importanceScore: ['importance_score', (v: number) => v],
    importanceDecayRate: ['importance_decay_rate', (v: number) => v],
    normalizedKey: ['normalized_key', (v: string) => v],
    reason: ['reason', (v: string) => v],
    evidenceSummary: ['evidence_summary', (v: string) => v],
    lastConfirmedAt: ['last_confirmed_at', (v: number | Date) => v instanceof Date ? v.getTime() : v],
    sourceCount: ['source_count', (v: number) => v],
    title: ['title', (v: string) => v],
    description: ['description', (v: string) => v],
    steps: ['steps', (v: string[]) => JSON.stringify(v)],
    successCriteria: ['success_criteria', (v: string) => v],
    failureIndicators: ['failure_indicators', (v: string) => v],
    usageCount: ['usage_count', (v: number) => v],
    successCount: ['success_count', (v: number) => v],
    failureCount: ['failure_count', (v: number) => v],
    lastUsedAt: ['last_used_at', (v: number | Date) => v instanceof Date ? v.getTime() : v],
    lastSuccessAt: ['last_success_at', (v: number | Date) => v instanceof Date ? v.getTime() : v],
    lastFailureAt: ['last_failure_at', (v: number | Date) => v instanceof Date ? v.getTime() : v],
    status: ['status', (v: string) => v],
    supersededBy: ['superseded_by', (v: string) => v],
    contradictsId: ['contradicts_id', (v: string) => v],
    informedById: ['informed_by_id', (v: string) => v],
    tags: ['tags', (v: string[]) => JSON.stringify(v)],
    metadata: ['metadata', (v: Record<string, unknown>) => serializeJson(v)],
    sector: ['sector', (v: string) => v],
    tier: ['tier', (v: string) => v],
    isActive: ['is_active', (v: number) => v],
  };

  for (const [key, value] of Object.entries(updates)) {
    if (key === 'projectId' || key === 'userId' || key === 'agentId' || key === 'sessionId') continue;
    const mapping = fieldMap[key];
    if (mapping && value !== undefined) {
      setClauses.push(`${mapping[0]} = ?`);
      values.push(mapping[1](value));
    }
  }

  if (setClauses.length === 0) return getKnowledgeById(id);

  setClauses.push('updated_at = ?');
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  sqlite.prepare(`UPDATE knowledge SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  const updated = await getKnowledgeById(id);
  if (updated) {
    await logAuditEntry({
      knowledgeId: id,
      action: 'update',
      details: { updatedFields: Object.keys(updates) },
    });
  }
  return updated;
}

/**
 * Delete a knowledge record by ID.
 */
export async function deleteKnowledge(id: string): Promise<boolean> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(`knowledge_delete:${id}`, 'knowledge', 'Unscoped knowledge deletion is disabled under strict trust');
  }
  await ensureKnowledgeTables();
  const { raw } = await getDbClient();
  const sqlite = (raw as any).$client;
  if (!sqlite) return false;

  const result = sqlite.prepare('DELETE FROM knowledge WHERE id = ?').run(id);
  const deleted = result.changes > 0;
  if (deleted) {
    await logAuditEntry({
      knowledgeId: id,
      action: 'delete',
    });
  }
  return deleted;
}

// ─── Search & List ───────────────────────────────────────────────────────────

/**
 * Search knowledge by kind, status, and/or content.
 * Supports both vector and text search.
 */
export async function searchKnowledge(options: {
  projectId?: string;
  kinds?: KnowledgeKind[];
  types?: KnowledgeType[];
  status?: KnowledgeStatus;
  minConfidence?: number;
  contentQuery?: string;
  limit?: number;
  offset?: number;
}): Promise<Knowledge[]> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(`knowledge_search:${options.projectId ?? 'all_projects'}`, 'knowledge', 'Unscoped knowledge search is disabled under strict trust');
  }
  await ensureKnowledgeTables();
  const { raw } = await getDbClient();
  const sqlite = (raw as any).$client;
  if (!sqlite) return [];

  const where: string[] = ['is_active = 1'];
  const params: any[] = [];

  if (options.projectId) {
    where.push('project_id = ?');
    params.push(options.projectId);
  }
  if (options.kinds && options.kinds.length > 0) {
    where.push(`knowledge_kind IN (${options.kinds.map(() => '?').join(',')})`);
    params.push(...options.kinds);
  }
  if (options.types && options.types.length > 0) {
    where.push(`knowledge_type IN (${options.types.map(() => '?').join(',')})`);
    params.push(...options.types);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.minConfidence !== undefined) {
    where.push('confidence >= ?');
    params.push(options.minConfidence);
  }
  if (options.contentQuery) {
    where.push('content LIKE ?');
    params.push(`%${options.contentQuery}%`);
  }

  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const rows = sqlite.prepare(`
    SELECT * FROM knowledge
    WHERE ${where.join(' AND ')}
    ORDER BY confidence DESC, created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return rows.map(toKnowledge);
}

/**
 * Get all active knowledge for a project, grouped by kind.
 */
export async function listKnowledgeByKind(
  projectId: string,
  kind: KnowledgeKind,
  options?: { status?: KnowledgeStatus; types?: KnowledgeType[]; limit?: number }
): Promise<Knowledge[]> {
  return searchKnowledge({
    projectId,
    kinds: [kind],
    types: options?.types,
    status: options?.status ?? 'active',
    limit: options?.limit ?? 100,
  });
}
