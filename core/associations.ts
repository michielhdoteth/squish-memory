/**
 * Memory Association Graph (Waypoint Graph)
 * Tracks co-occurrence and relationships between memories
 */

import { eq, and, inArray, sql, lte, gt, isNull, or, asc, desc } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDbClient } from './lib/db-client.js';
import { logger } from './logger.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from './acl/trust-policy.js';
import { denyStrictSurface, writeTrustAudit } from './acl/trust-audit.js';
import { createKnowledgeEdge, getEdgesForNode, reviseKnowledgeEdge } from './knowledge/knowledge-edges.js';

export type AssociationType = 'co_occurred' | 'supersedes' | 'contradicts' | 'supports' | 'relates_to' | 'duplicate' | 'near_duplicate' | 'merged' | 'updates' | 'extends' | 'derives';

/**
 * Create or update an association between two memories
 */
/**
 * Confidence tags for associations (inspired by Graphify's tagging system)
 * - EXTRACTED: Found directly from data (co-occurrence, explicit user link)
 * - INFERRED: Reasonable inference (LLM-extracted, entity overlap)
 * - AMBIGUOUS: Uncertain relationship
 */
export type AssociationConfidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

export interface MemoryAssociationEdge {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  associationType: AssociationType;
  weight: number;
  coactivationCount: number;
  lastCoactivatedAt: Date | null;
  createdAt: Date;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryAssociationAsOf {
  validAt?: Date;
  recordedAt?: Date;
}

const sqliteAssociationWriteQueues = new WeakMap<object, Promise<void>>();

async function withSqliteAssociationWriteLock<T>(database: object, operation: () => Promise<T>): Promise<T> {
  const previous = sqliteAssociationWriteQueues.get(database) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  sqliteAssociationWriteQueues.set(database, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sqliteAssociationWriteQueues.get(database) === queued) sqliteAssociationWriteQueues.delete(database);
  }
}

async function denyStrictAssociationRead(resourceId: string): Promise<never> {
  return denyStrictSurface(
    resourceId,
    'memory_association',
    'Unscoped memory-association reads are disabled under strict trust',
  );
}

/** Return true when adding a newer-to-older temporal edge would close a cycle. */
export function wouldCreateSupersessionCycle(
  newerId: string,
  olderId: string,
  edges: Pick<MemoryAssociationEdge, 'fromMemoryId' | 'toMemoryId' | 'associationType'>[],
): boolean {
  if (newerId === olderId) return true;
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.associationType !== 'updates' && edge.associationType !== 'supersedes') continue;
    const targets = outgoing.get(edge.fromMemoryId) ?? [];
    targets.push(edge.toMemoryId);
    outgoing.set(edge.fromMemoryId, targets);
  }
  const seen = new Set<string>();
  const pending = [olderId];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === newerId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

function parseAssociationDate(value: unknown): Date | null {
  if (value == null) return null;
  if (typeof value === 'number') return new Date(value < 100_000_000_000 ? value * 1000 : value);
  const text = String(value);
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return new Date(numeric < 100_000_000_000 ? numeric * 1000 : numeric);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseAssociationMetadata(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function getKnowledgeIdForMemory(memoryId: string): Promise<string> {
  const client = await getDbClient();
  if ((client.db as { $clientType?: string }).$clientType === 'postgres') {
    const [row] = await client.db.select({ id: client.schema.knowledge.id })
      .from(client.schema.knowledge)
      .where(or(
        eq(client.schema.knowledge.id, memoryId),
        sql`${client.schema.knowledge.metadata}->>'sourceMemoryId' = ${memoryId}`,
      ))
      .orderBy(sql`CASE WHEN ${client.schema.knowledge.id} = ${memoryId} THEN 0 ELSE 1 END`)
      .limit(1);
    if (!row) throw new Error(`No canonical knowledge projection for memory ${memoryId}`);
    return row.id;
  }
  const { raw } = client;
  const sqlite = (raw as { $client?: { prepare?: (query: string) => { get: (...params: string[]) => { id: string } | undefined; run: (...params: string[]) => unknown } } }).$client;
  if (!sqlite?.prepare) throw new Error('SQLite knowledge store is unavailable');
  const lookup = sqlite.prepare(`
    SELECT id FROM knowledge
    WHERE id = ? OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1
  `);
  let row = lookup.get(memoryId, memoryId, memoryId);
  if (!row) {
    sqlite.prepare(`
      INSERT OR IGNORE INTO knowledge (
        id, project_id, user_id, knowledge_kind, knowledge_type, content,
        confidence, importance_score, status, is_active, sector, tier, tags,
        metadata, created_at, updated_at
      )
      SELECT m.id, m.project_id, m.user_id, 'memory', COALESCE(m.type, 'note'), m.content,
        CAST(COALESCE(m.confidence, 50) AS REAL) / 100.0,
        CAST(COALESCE(m.importance_score, 50) AS REAL) / 100.0,
        COALESCE(m.status, 'active'), COALESCE(m.is_active, 1), COALESCE(m.sector, 'general'),
        COALESCE(m.tier, 'episodic'), m.tags,
        json_set(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.sourceMemoryId', m.id),
        COALESCE(m.created_at, strftime('%s','now')), COALESCE(m.updated_at, strftime('%s','now'))
      FROM memories m WHERE m.id = ? AND m.content IS NOT NULL
    `).run(memoryId);
    row = lookup.get(memoryId, memoryId, memoryId);
  }
  if (!row) throw new Error(`No canonical knowledge projection for memory ${memoryId}`);
  return row.id;
}

async function upsertCanonicalAssociation(
  fromMemoryId: string,
  toMemoryId: string,
  type: AssociationType,
  weight: number,
  confidence?: { tag: AssociationConfidence; score: number },
  temporal?: { validFrom?: Date; validTo?: Date | null; recordedAt?: Date },
): Promise<void> {
  const [fromId, toId] = await Promise.all([
    getKnowledgeIdForMemory(fromMemoryId),
    getKnowledgeIdForMemory(toMemoryId),
  ]);
  const outgoing = await getMemoryAssociationRows([fromMemoryId]);
  const current = outgoing.find((edge) => edge.fromMemoryId === fromMemoryId
    && edge.toMemoryId === toMemoryId && edge.associationType === type);
  const now = new Date();
  const legacyMetadata = confidence ? { confidence: confidence.tag, confidence_score: confidence.score } : undefined;
  if (current) {
    const oldMetadata = current.metadata ?? {};
    const metadata = {
      ...oldMetadata,
      ...(legacyMetadata ? { association_confidence: legacyMetadata } : {}),
      coactivation_count: Number(oldMetadata.coactivation_count ?? 0) + 1,
      last_coactivated_at: now.toISOString(),
    };
    await reviseKnowledgeEdge(current.id, {
      weight: current.weight + weight,
      metadata,
      validFrom: temporal?.validFrom,
      validTo: temporal?.validTo,
      recordedAt: temporal?.recordedAt ?? now,
    });
    return;
  }
  await createKnowledgeEdge({
    fromId,
    fromKind: 'knowledge',
    toId,
    toKind: 'knowledge',
    edgeType: type,
    weight,
    ...temporal,
    metadata: {
      ...(legacyMetadata ? { association_confidence: legacyMetadata } : {}),
      coactivation_count: 1,
      last_coactivated_at: now.toISOString(),
      source_memory_ids: [fromMemoryId, toMemoryId],
    },
  });
}

const ASSOCIATION_TYPES = new Set<AssociationType>([
  'co_occurred', 'supersedes', 'contradicts', 'supports', 'relates_to',
  'duplicate', 'near_duplicate', 'merged', 'updates', 'extends', 'derives',
]);

async function adjustAssociationEdges(
  edges: Awaited<ReturnType<typeof getEdgesForNode>>,
  weightDelta: number,
  minimumWeight: number,
  incrementCoactivation: boolean,
  shouldApply?: () => boolean,
): Promise<number> {
  const uniqueEdges = new Map(edges.filter((edge) =>
    edge.fromKind === 'knowledge' && edge.toKind === 'knowledge' && ASSOCIATION_TYPES.has(edge.edgeType as AssociationType)
  ).map((edge) => [edge.id, edge]));
  let updated = 0;
  for (const edge of uniqueEdges.values()) {
    if (shouldApply && !shouldApply()) break;
    const metadata = edge.metadata ?? {};
    const legacyMetadata = metadata.legacy_metadata && typeof metadata.legacy_metadata === 'object'
      ? metadata.legacy_metadata as Record<string, unknown>
      : {};
    const coactivationCount = Number(metadata.coactivation_count ?? legacyMetadata.coactivation_count ?? 0) + (incrementCoactivation ? 1 : 0);
    const lastCoactivatedAt = incrementCoactivation ? new Date().toISOString() : metadata.last_coactivated_at;
    const nextMetadata = {
      ...metadata,
      ...(incrementCoactivation ? { coactivation_count: coactivationCount, last_coactivated_at: lastCoactivatedAt } : {}),
    };
    const revised = await reviseKnowledgeEdge(edge.id, {
      weight: Math.max(minimumWeight, edge.weight + weightDelta),
      metadata: nextMetadata,
      recordedAt: new Date(),
      shouldApply,
    });
    if (!revised) continue;

    updated++;
  }
  return updated;
}

/** Adjust all canonical relationships attached to a memory. */
export async function adjustAssociationsForMemory(
  memoryId: string,
  weightDelta: number,
  minimumWeight = 1,
  incrementCoactivation = false,
  shouldApply?: () => boolean,
): Promise<number> {
  const knowledgeId = await getKnowledgeIdForMemory(memoryId);
  if (shouldApply && !shouldApply()) return 0;
  return adjustAssociationEdges(await getEdgesForNode(knowledgeId, 'knowledge'), weightDelta, minimumWeight, incrementCoactivation, shouldApply);
}

/** Adjust any canonical relationship joining two memories in either direction. */
export async function adjustAssociationsBetweenMemories(
  firstMemoryId: string,
  secondMemoryId: string,
  weightDelta: number,
  minimumWeight = 1,
  incrementCoactivation = false,
): Promise<number> {
  const [firstId, secondId] = await Promise.all([
    getKnowledgeIdForMemory(firstMemoryId),
    getKnowledgeIdForMemory(secondMemoryId),
  ]);
  const [firstEdges, secondEdges] = await Promise.all([
    getEdgesForNode(firstId, 'knowledge'),
    getEdgesForNode(secondId, 'knowledge'),
  ]);
  const pairEdges = [...firstEdges, ...secondEdges].filter((edge) =>
    (edge.fromId === firstId && edge.toId === secondId) || (edge.fromId === secondId && edge.toId === firstId)
  );
  return adjustAssociationEdges(pairEdges, weightDelta, minimumWeight, incrementCoactivation);
}

/** Return active associations from the canonical temporal edge store at one bitemporal snapshot. */
export async function getMemoryAssociationRows(
  memoryIds?: string[],
  asOf: MemoryAssociationAsOf = {},
): Promise<MemoryAssociationEdge[]> {
  if (isStrictTrustPolicy()) await denyStrictAssociationRead('memory_association_collection');
  if (memoryIds && memoryIds.length === 0) return [];
  const validAt = asOf.validAt ?? new Date();
  const recordedAt = asOf.recordedAt ?? new Date();
  if (!Number.isFinite(validAt.getTime()) || !Number.isFinite(recordedAt.getTime())) {
    throw new RangeError('Association snapshot timestamps must be valid dates');
  }
  const client = await getDbClient();
  if ((client.db as { $clientType?: string }).$clientType === 'postgres') {
    const { db, schema } = client;
    const edge = schema.knowledgeEdges;
    const fromKnowledge = alias(schema.knowledge, 'association_from_knowledge');
    const toKnowledge = alias(schema.knowledge, 'association_to_knowledge');
    const fromMemoryId = sql<string>`COALESCE(${fromKnowledge.metadata}->>'sourceMemoryId', ${edge.fromId})`;
    const toMemoryId = sql<string>`COALESCE(${toKnowledge.metadata}->>'sourceMemoryId', ${edge.toId})`;
    const conditions = [
      eq(edge.fromKind, 'knowledge'),
      eq(edge.toKind, 'knowledge'),
      lte(edge.validFrom, validAt),
      or(isNull(edge.validTo), gt(edge.validTo, validAt)),
      lte(edge.recordedAt, recordedAt),
      or(isNull(edge.recordedTo), gt(edge.recordedTo, recordedAt)),
    ];
    if (memoryIds) {
      conditions.push(or(
        inArray(edge.fromId, memoryIds),
        inArray(edge.toId, memoryIds),
        inArray(fromMemoryId, memoryIds),
        inArray(toMemoryId, memoryIds),
      ));
    }
    const rows: Array<{
      id: string;
      fromMemoryId: string;
      toMemoryId: string;
      associationType: string;
      weight: number | null;
      createdAt: Date | null;
      metadata: unknown;
    }> = await db.select({
      id: edge.id,
      fromMemoryId,
      toMemoryId,
      associationType: edge.edgeType,
      weight: edge.weight,
      createdAt: edge.createdAt,
      metadata: edge.metadata,
    })
      .from(edge)
      .leftJoin(fromKnowledge, eq(fromKnowledge.id, edge.fromId))
      .leftJoin(toKnowledge, eq(toKnowledge.id, edge.toId))
      .where(and(...conditions))
      .orderBy(desc(edge.weight), asc(edge.id));
    return rows.filter((row) => ASSOCIATION_TYPES.has(String(row.associationType) as AssociationType)).map((row) => {
      const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};
      const legacyMetadata = metadata.legacy_metadata && typeof metadata.legacy_metadata === 'object'
        ? metadata.legacy_metadata as Record<string, unknown>
        : {};
      return {
        id: String(row.id),
        fromMemoryId: String(row.fromMemoryId),
        toMemoryId: String(row.toMemoryId),
        associationType: String(row.associationType) as AssociationType,
        weight: Number(row.weight ?? 1),
        coactivationCount: Number(metadata.coactivation_count ?? legacyMetadata.coactivation_count ?? 0),
        lastCoactivatedAt: parseAssociationDate(metadata.last_coactivated_at ?? legacyMetadata.last_coactivated_at),
        createdAt: parseAssociationDate(row.createdAt) ?? new Date(0),
        metadata,
      };
    });
  }
  const { raw } = client;
  const sqlite = (raw as { $client?: { prepare?: (query: string) => { all: (...params: Array<string | number>) => Array<Record<string, unknown>> } } }).$client;
  if (!sqlite?.prepare) return [];
  const validAtMillis = validAt.getTime();
  const recordedAtMillis = recordedAt.getTime();
  const filterSql = memoryIds ? ` AND (
    e.from_id IN (${memoryIds.map(() => '?').join(',')}) OR e.to_id IN (${memoryIds.map(() => '?').join(',')})
    OR json_extract(CASE WHEN json_valid(f.metadata) THEN f.metadata ELSE '{}' END, '$.sourceMemoryId') IN (${memoryIds.map(() => '?').join(',')})
    OR json_extract(CASE WHEN json_valid(t.metadata) THEN t.metadata ELSE '{}' END, '$.sourceMemoryId') IN (${memoryIds.map(() => '?').join(',')})
  )` : '';
  const rows = sqlite.prepare(`
    SELECT e.id,
      COALESCE(json_extract(CASE WHEN json_valid(f.metadata) THEN f.metadata ELSE '{}' END, '$.sourceMemoryId'), e.from_id) AS from_memory_id,
      COALESCE(json_extract(CASE WHEN json_valid(t.metadata) THEN t.metadata ELSE '{}' END, '$.sourceMemoryId'), e.to_id) AS to_memory_id,
      e.edge_type AS association_type, e.weight, e.created_at,
      e.metadata AS metadata,
      COALESCE(
        json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.coactivation_count'),
        json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.legacy_metadata.coactivation_count'), 0
      ) AS coactivation_count,
      COALESCE(
        json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.last_coactivated_at'),
        json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.legacy_metadata.last_coactivated_at')
      ) AS last_coactivated_at
    FROM knowledge_edges e
    LEFT JOIN knowledge f ON f.id = e.from_id
    LEFT JOIN knowledge t ON t.id = e.to_id
    WHERE e.from_kind = 'knowledge' AND e.to_kind = 'knowledge'
      AND e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?)
      AND e.recorded_at <= ? AND (e.recorded_to IS NULL OR e.recorded_to > ?)
      ${filterSql}
  `).all(...[validAtMillis, validAtMillis, recordedAtMillis, recordedAtMillis, ...(memoryIds ?? []), ...(memoryIds ?? []), ...(memoryIds ?? []), ...(memoryIds ?? [])]);
  return rows.filter((row) => ASSOCIATION_TYPES.has(String(row.association_type) as AssociationType)).map((row) => ({
    id: String(row.id),
    fromMemoryId: String(row.from_memory_id),
    toMemoryId: String(row.to_memory_id),
    associationType: String(row.association_type) as AssociationType,
    weight: Number(row.weight ?? 1),
    coactivationCount: Number(row.coactivation_count ?? 0),
    lastCoactivatedAt: parseAssociationDate(row.last_coactivated_at),
    createdAt: parseAssociationDate(row.created_at) ?? new Date(0),
    metadata: parseAssociationMetadata(row.metadata),
  }));
}

/** End matching canonical edges in valid time, retaining past relationship history. */
export async function pruneMemoryAssociations(
  shouldPrune: (association: MemoryAssociationEdge) => boolean,
): Promise<number> {
  const associations = await getMemoryAssociationRows();
  const { raw, db } = await getDbClient();
  const sqlite = (raw as { $client?: { prepare?: (query: string) => { get: (...params: string[]) => unknown; run: (...params: Array<string | number>) => { changes: number } } } }).$client;
  const postgres = (db as { $clientType?: string }).$clientType === 'postgres';
  if (!postgres && !sqlite?.prepare) return 0;
  const hasLegacyTable = !postgres && Boolean(sqlite!.prepare!("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_associations'").get());
  let pruned = 0;
  for (const association of associations) {
    if (!shouldPrune(association)) continue;
    const closed = await reviseKnowledgeEdge(association.id, { validTo: new Date(), recordedAt: new Date() });
    const deleted = hasLegacyTable
      ? sqlite!.prepare!(`
          DELETE FROM memory_associations
          WHERE from_memory_id = ? AND to_memory_id = ? AND association_type = ?
        `).run(association.fromMemoryId, association.toMemoryId, association.associationType)
      : { changes: 0 };
    if (closed || deleted.changes > 0) pruned++;
  }
  return pruned;
}

/** Close current associations for memory deletion while preserving as-of history. */
export async function closeAssociationsForMemories(memoryIds: string[]): Promise<number> {
  const edges = await getMemoryAssociationRows(memoryIds);
  let closed = 0;
  for (const edge of edges) {
    if (await reviseKnowledgeEdge(edge.id, { validTo: new Date(), recordedAt: new Date() })) closed++;
  }
  return closed;
}

export async function createAssociation(
  fromMemoryId: string,
  toMemoryId: string,
  type: AssociationType,
  weight: number = 1,
  confidence?: { tag: AssociationConfidence; score: number },
  temporal?: { validFrom?: Date; validTo?: Date | null; recordedAt?: Date },
): Promise<void> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(
      `association_write:${fromMemoryId}:${toMemoryId}:${type}`,
      'memory_association',
      'Association writes are disabled under strict trust until caller, ACL, and edge provenance checks are available',
    );
  }

  // Safety: reject self-links
  if (fromMemoryId === toMemoryId) {
    logger.debug(`[Associations] Rejected self-link for memory ${fromMemoryId}`);
    return;
  }

  try {
    const client = await getDbClient();
    const sqlite = client ? (client.raw as { $client?: { exec?: (sql: string) => void; inTransaction?: boolean } }).$client : undefined;
    const writeAssociation = async () => {
      // The canonical edge writer owns temporal cycle validation on both
      // backends. A second current-only association read can reject a valid
      // supersession whose requested valid-time interval does not overlap the
      // currently active path.
      const outgoing = await getMemoryAssociationRows([fromMemoryId]);
      const existingCount = outgoing.filter((edge) => edge.fromMemoryId === fromMemoryId).length;
      if (existingCount >= 50) {
        logger.debug(`[Associations] Fan-out cap reached for memory ${fromMemoryId}, skipping`);
        return false;
      }
      await upsertCanonicalAssociation(fromMemoryId, toMemoryId, type, weight, confidence, temporal);
      return true;
    };

    // SQLite writers are serialized regardless of edge type. Keep the
    // read-current / revise-or-create sequence under the same write lock so
    // concurrent coactivation updates cannot silently lose weight or counts.
    if (sqlite?.exec) {
      await withSqliteAssociationWriteLock(sqlite, async () => {
        const ownsTransaction = !sqlite.inTransaction;
        if (ownsTransaction) sqlite.exec!('BEGIN IMMEDIATE');
        try {
          await writeAssociation();
          if (ownsTransaction) sqlite.exec!('COMMIT');
        } catch (error) {
          if (ownsTransaction && sqlite.inTransaction) sqlite.exec!('ROLLBACK');
          throw error;
        }
      });
    } else {
      await writeAssociation();
    }
  } catch (error) {
    logger.error('Error creating association', error);
  }
}

/**
 * Auto-link memories that share entities
 * Called after storing a memory to link it to related memories
 */
export async function autoLinkByEntities(
  newMemoryId: string,
  entityNames: string[],
  projectId: string
): Promise<number> {
  if (entityNames.length === 0) return 0;

  try {
    const { db, schema } = await getDbClient();

    // Find existing memories that contain any of these entity names
    // Use simple LIKE query for matching
    const conditions = entityNames.slice(0, 5).map(name =>
      sql<boolean>`LOWER(m.content) LIKE ${'%' + name + '%'}`
    );

    const existing = await (db as any)
      .select({
        id: schema.memories.id,
        content: schema.memories.content
      })
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.projectId, projectId),
          sql`(${conditions.join(' OR ')})`,
          sql`id != ${newMemoryId}`
        )
      )
      .limit(10);

    // Create associations for matching memories
    let linked = 0;
    for (const mem of existing) {
      try {
        await createAssociation(newMemoryId, mem.id, 'relates_to', 0.5, { tag: 'EXTRACTED', score: 1.0 });
        linked++;
      } catch (e) {
        // Skip duplicates
      }
    }

    return linked;
  } catch (error) {
    logger.error('Error auto-linking by entities', error);
    return 0;
  }
}
export async function trackCoactivation(memoryIds: string[]): Promise<void> {
  if (memoryIds.length < 2) return;

  try {
    const pairs: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < memoryIds.length; i++) {
      for (let j = i + 1; j < memoryIds.length; j++) {
        pairs.push({ from: memoryIds[i], to: memoryIds[j] });
        pairs.push({ from: memoryIds[j], to: memoryIds[i] }); // Bidirectional
      }
    }
    for (const pair of pairs) await createAssociation(pair.from, pair.to, 'co_occurred', 1);
    logger.debug('Coactivation tracked through canonical relationship adapter', { totalPairs: pairs.length });
  } catch (error) {
    logger.error('Error tracking coactivation', error);
  }
}

/**
 * Get related memories via the association graph
 */
export async function getRelatedMemories(
  memoryId: string,
  limit: number = 10
): Promise<any[]> {
  if (isStrictTrustPolicy()) await denyStrictAssociationRead('memory_related_read');
  try {
    if (limit <= 0) return [];
    const { db, schema } = await getDbClient();
    const associations = (await getMemoryAssociationRows([memoryId]))
      .filter((edge) => edge.fromMemoryId === memoryId || edge.toMemoryId === memoryId)
      .sort((left, right) => right.weight - left.weight);
    const seenNeighbors = new Set<string>();
    const relatedMemoryIds: string[] = [];
    for (const association of associations) {
      const relatedId = association.fromMemoryId === memoryId ? association.toMemoryId : association.fromMemoryId;
      if (relatedId !== memoryId && !seenNeighbors.has(relatedId)) {
        seenNeighbors.add(relatedId);
        relatedMemoryIds.push(relatedId);
      }
      if (relatedMemoryIds.length >= Math.max(0, limit)) break;
    }

    if (relatedMemoryIds.length === 0) return [];
    return await (db as any)
      .select()
      .from(schema.memories)
      .where(inArray(schema.memories.id, relatedMemoryIds));
  } catch (error) {
    logger.error('Error getting related memories', error);
    return [];
  }
}



/**
 * Prune weak associations (weight < threshold)
 */
export async function pruneWeakAssociations(weightThreshold: number = 5): Promise<number> {
  try {
    return await pruneMemoryAssociations((association) => association.weight <= weightThreshold);
  } catch (error) {
    logger.error('Error pruning weak associations', error);
    return 0;
  }
}

/**
 * Prune associations that are BOTH weak AND old (dual criteria).
 * More aggressive than weight-only pruning — removes stale low-value links.
 */
export async function pruneStaleAssociations(
  maxWeight: number = 2,
  maxAgeDays: number = 90
): Promise<number> {
  try {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    return await pruneMemoryAssociations((association) =>
      association.weight <= maxWeight && association.createdAt.getTime() < cutoff
    );
  } catch (error) {
    logger.error('Error pruning stale associations', error);
    return 0;
  }
}

/**
 * Get association statistics
 */
export async function getAssociationStats(): Promise<{
  totalAssociations: number;
  byType: Record<string, number>;
  avgWeight: number;
  maxWeight: number;
}> {
  if (isStrictTrustPolicy()) await denyStrictAssociationRead('memory_association_statistics');
  try {
    const associations = await getMemoryAssociationRows();

    const stats = {
      totalAssociations: associations.length,
      byType: {} as Record<string, number>,
      avgWeight: 0,
      maxWeight: 0,
    };

    let totalWeight = 0;

    for (const assoc of associations) {
      stats.byType[assoc.associationType] = (stats.byType[assoc.associationType] || 0) + 1;
      totalWeight += assoc.weight;
      if (assoc.weight > stats.maxWeight) stats.maxWeight = assoc.weight;
    }

    stats.avgWeight = associations.length > 0 ? totalWeight / associations.length : 0;

    return stats;
  } catch (error) {
    logger.error('Error getting association stats', error);
    return {
      totalAssociations: 0,
      byType: {},
      avgWeight: 0,
      maxWeight: 0,
    };
  }
}


