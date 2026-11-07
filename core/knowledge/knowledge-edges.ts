/**
 * Knowledge Edges — CRUD and graph traversal for knowledge_edges.
 *
 * Single responsibility: managing relationships between knowledge, entities,
 * and places. Includes cross-entity queries like getConnectedEntities and
 * getConnectedPlaces that traverse the knowledge graph.
 */

import { randomUUID } from 'crypto';
import { sqlLifecycleBound } from '../lib/timestamps.js';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql, type SQLWrapper } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getDbClient } from '../lib/db-client.js';
import { serializeJson, toKnowledge, toKnowledgeEdge } from './helpers.js';
import { ensureKnowledgeTables } from './knowledge-crud.js';
import { signGraphRelationProvenance } from '../acl/provenance.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';
import { denyStrictSurface, writeTrustAudit } from '../acl/trust-audit.js';
import { isSourceBackedKnowledgeEdgeType } from './types.js';
import type {
  Knowledge,
  KnowledgeEdge,
  CreateKnowledgeEdgeInput,
  EdgeNodeKind,
  KnowledgeEdgeAsOf,
} from './types.js';

function epochMillis(value: Date): number {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) throw new Error('Knowledge edge timestamps must be valid dates');
  return timestamp;
}

function lastStatementChanges(sqlite: { prepare: (sql: string) => { get: () => { count?: number } } }): number {
  return Number(sqlite.prepare('SELECT changes() AS count').get().count ?? 0);
}

const sqliteSupersessionWriteQueues = new WeakMap<object, Promise<void>>();
type SqliteCycleClient = {
  inTransaction?: boolean;
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    all: (...parameters: unknown[]) => Array<{ id: string; project_id: string | null }>;
    get: (...parameters: unknown[]) => { cycle?: number; project_id?: string | null } | undefined;
    run: (...parameters: unknown[]) => unknown;
  };
};
const SQLITE_PROJECT_TABLE_BY_NODE_KIND: Record<EdgeNodeKind, string> = {
  entity: 'entities',
  knowledge: 'knowledge',
  place: 'places',
};

type PostgresCycleExecutor = {
  execute: (query: SQLWrapper | string) => PromiseLike<{ rows: unknown[] }>;
};

function supersessionTypes(nodeKind: EdgeNodeKind): string[] | null {
  if (nodeKind === 'entity') return ['supersedes_version'];
  if (nodeKind === 'knowledge') return ['supersedes', 'updates'];
  return null;
}

async function lockPostgresSupersessionScope(tx: PostgresCycleExecutor, projectId: string | null, nodeKind: EdgeNodeKind): Promise<void> {
  const types = supersessionTypes(nodeKind);
  if (!types) return;
  const scope = `${projectId ?? 'null'}:${nodeKind}:${types.join(',')}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`);
}

async function createsPostgresTemporalCycle(
  tx: PostgresCycleExecutor,
  input: CreateKnowledgeEdgeInput,
  projectId: string | null,
): Promise<boolean> {
  if (input.fromKind !== input.toKind) return false;
  const relationTypes = supersessionTypes(input.fromKind);
  if (!relationTypes) return false;
  if (input.fromId === input.toId) return true;

  const nodeTable = input.fromKind === 'entity' ? sql.identifier('entities') : sql.identifier('knowledge');
  const validFrom = input.validFrom ?? new Date();
  const validTo = input.validTo ?? null;
  const recordedAt = input.recordedAt ?? new Date();
  epochMillis(validFrom);
  if (validTo !== null && epochMillis(validTo) <= epochMillis(validFrom)) {
    throw new Error('Knowledge edge validTo must be later than validFrom');
  }
  epochMillis(recordedAt);

  const result = await tx.execute(sql`
    WITH RECURSIVE reachable(id, overlap_from, overlap_to, path) AS (
      SELECT ${input.toId}::text, ${validFrom}::timestamp, ${validTo}::timestamp,
        ARRAY[${input.toId}::text]
      UNION ALL
      SELECT edge.to_id,
        GREATEST(reachable.overlap_from, edge.valid_from),
        CASE
          WHEN reachable.overlap_to IS NULL THEN edge.valid_to
          WHEN edge.valid_to IS NULL THEN reachable.overlap_to
          ELSE LEAST(reachable.overlap_to, edge.valid_to)
        END,
        reachable.path || edge.to_id
      FROM knowledge_edges AS edge
      JOIN reachable ON edge.from_id = reachable.id
      JOIN ${nodeTable} AS source ON source.id = edge.from_id
        AND source.project_id IS NOT DISTINCT FROM ${projectId}
      JOIN ${nodeTable} AS destination ON destination.id = edge.to_id
        AND destination.project_id IS NOT DISTINCT FROM ${projectId}
      WHERE edge.from_kind = ${input.fromKind} AND edge.to_kind = ${input.toKind}
        AND edge.edge_type IN (${sql.join(relationTypes.map((type) => sql`${type}`), sql`, `)})
        AND (reachable.overlap_to IS NULL OR edge.valid_from < reachable.overlap_to)
        AND (edge.valid_to IS NULL OR edge.valid_to > reachable.overlap_from)
        AND edge.recorded_at <= ${recordedAt}
        AND (edge.recorded_to IS NULL OR edge.recorded_to > ${recordedAt})
        AND NOT edge.to_id = ANY(reachable.path)
    )
    SELECT EXISTS(SELECT 1 FROM reachable WHERE id = ${input.fromId}::text) AS cycle
  `);
  const firstRow = result.rows[0];
  return typeof firstRow === 'object' && firstRow !== null && 'cycle' in firstRow && firstRow.cycle === true;
}

async function withSqliteSupersessionWriteLock<T>(sqlite: object, operation: () => Promise<T>): Promise<T> {
  const previous = sqliteSupersessionWriteQueues.get(sqlite) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  sqliteSupersessionWriteQueues.set(sqlite, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sqliteSupersessionWriteQueues.get(sqlite) === current) sqliteSupersessionWriteQueues.delete(sqlite);
  }
}

function createsSqliteTemporalCycle(sqlite: SqliteCycleClient, input: CreateKnowledgeEdgeInput): boolean {
  if (input.fromId === input.toId) return true;
  if (input.fromKind !== input.toKind) return false;
  const nodeTable = SQLITE_PROJECT_TABLE_BY_NODE_KIND[input.fromKind];
  const relationTypes = input.fromKind === 'entity' ? ['supersedes_version'] : ['supersedes', 'updates'];
  const endpoints = sqlite.prepare(`SELECT id, project_id FROM ${nodeTable} WHERE id IN (?, ?)`).all(input.fromId, input.toId);
  if (!endpoints.some((endpoint) => endpoint.id === input.fromId)
    || !endpoints.some((endpoint) => endpoint.id === input.toId)) return true;
  const projectById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.project_id]));
  const projectId = projectById.get(input.fromId);
  if (projectById.get(input.toId) !== projectId) return true;

  const validFrom = epochMillis(input.validFrom ?? new Date());
  const validTo = input.validTo == null ? null : epochMillis(input.validTo);
  if (validTo !== null && validTo <= validFrom) throw new Error('Knowledge edge validTo must be later than validFrom');
  const recordedAt = epochMillis(input.recordedAt ?? new Date());
  const existingPath = sqlite.prepare(`
    WITH RECURSIVE reachable(id, overlap_from, overlap_to) AS (
      SELECT ?, ?, ?
      UNION
      SELECT edge.to_id,
        MAX(reachable.overlap_from, edge.valid_from),
        CASE
          WHEN reachable.overlap_to IS NULL THEN edge.valid_to
          WHEN edge.valid_to IS NULL THEN reachable.overlap_to
          ELSE MIN(reachable.overlap_to, edge.valid_to)
        END
      FROM knowledge_edges AS edge
      JOIN reachable ON edge.from_id = reachable.id
      JOIN ${nodeTable} AS destination ON destination.id = edge.to_id AND destination.project_id IS ?
      WHERE edge.from_kind = ? AND edge.to_kind = ?
        AND edge.edge_type IN (${relationTypes.map(() => '?').join(', ')})
        AND (reachable.overlap_to IS NULL OR edge.valid_from < reachable.overlap_to)
        AND (edge.valid_to IS NULL OR edge.valid_to > reachable.overlap_from)
        AND edge.recorded_at <= ? AND (edge.recorded_to IS NULL OR edge.recorded_to > ?)
    )
    SELECT 1 AS cycle FROM reachable WHERE id = ? LIMIT 1
  `).get(input.toId, validFrom, validTo, projectId, input.fromKind, input.toKind,
    ...relationTypes, recordedAt, recordedAt, input.fromId);
  return existingPath?.cycle === 1;
}

function assertSqliteEdgeProject(
  sqlite: SqliteCycleClient,
  fromId: string,
  fromKind: EdgeNodeKind,
  toId: string,
  toKind: EdgeNodeKind,
  options: { allowExistingScopeClosure?: boolean; requireEndpoints?: boolean } = {},
): void {
  let from = sqlite.prepare(`SELECT project_id FROM ${SQLITE_PROJECT_TABLE_BY_NODE_KIND[fromKind]} WHERE id = ?`).get(fromId);
  // Place assignments historically use the source-memory ID as the knowledge
  // endpoint. The memory projection may have a separate ID (or may not yet be
  // materialized for older/local data), while lifecycle cleanup and place
  // reads intentionally join the edge back to memories.id. Treat that source
  // row as the endpoint only for knowledge-to-place edges; arbitrary missing
  // knowledge graph nodes must still fail the endpoint check below.
  if (!from && fromKind === 'knowledge' && toKind === 'place') {
    from = sqlite.prepare('SELECT project_id FROM memories WHERE id = ?').get(fromId);
  }
  let to = sqlite.prepare(`SELECT project_id FROM ${SQLITE_PROJECT_TABLE_BY_NODE_KIND[toKind]} WHERE id = ?`).get(toId);
  // Place edges store the stable place_type in to_id, not the places table UUID.
  // Resolve that endpoint inside the source's project so same-typed places in
  // other projects cannot satisfy this edge's project-scope check.
  if (!to && toKind === 'place' && from) {
    to = sqlite.prepare('SELECT project_id FROM places WHERE place_type = ? AND project_id IS ? LIMIT 1')
      .get(toId, from.project_id);
  }
  if (options.requireEndpoints && (!from || !to)) {
    throw new Error('Graph edge endpoints must exist');
  }
  if (from && to && from.project_id !== to.project_id && !options.allowExistingScopeClosure) {
    if (fromKind === 'entity' && toKind === 'entity') {
      throw new Error('Entity graph edges must stay within one project');
    }
    throw new Error('Graph edges must stay within one project');
  }
}

function withGraphRelationSignature(input: {
  fromId: string;
  fromKind: EdgeNodeKind;
  toId: string;
  toKind: EdgeNodeKind;
  edgeType: string;
  weight: number;
  metadata: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  const metadata = { ...(input.metadata ?? {}) };
  delete metadata.__squishGraphProvenance;
  const signedEntityEdge = input.fromKind === 'entity' && input.toKind === 'entity';
  const signedKnowledgeRelation = input.fromKind === 'knowledge' && input.toKind === 'knowledge'
    && isSourceBackedKnowledgeEdgeType(input.edgeType);
  if (!signedEntityEdge && !signedKnowledgeRelation) return input.metadata;
  const signature = signGraphRelationProvenance({ ...input, metadata });
  return signature ? { ...metadata, __squishGraphProvenance: signature } : metadata;
}

async function denyStrictEdgeMutation(operation: string, resourceId: string): Promise<never> {
  const actorId = resolveTrustedCallerId();
  if (actorId) {
    await writeTrustAudit({
      actorId,
      resourceId,
      assetType: 'knowledge_edge',
      decision: 'deny',
      reason: 'private_default',
    });
  }
  throw new TrustBoundaryError(`Low-level knowledge-edge ${operation} is disabled under strict trust`);
}

function asOfPredicate(options: KnowledgeEdgeAsOf = {}): { sql: string; params: number[] } {
  const validAt = epochMillis(options.validAt ?? new Date());
  const recordedAt = epochMillis(options.recordedAt ?? new Date());
  return {
    sql: ' AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)',
    params: [validAt, validAt, recordedAt, recordedAt],
  };
}

function edgeAsOfDates(options: KnowledgeEdgeAsOf = {}): { validAt: Date; recordedAt: Date } {
  const validAt = options.validAt ?? new Date();
  const recordedAt = options.recordedAt ?? new Date();
  epochMillis(validAt);
  epochMillis(recordedAt);
  return { validAt, recordedAt };
}

function postgresEdgeAsOfConditions(schema: Awaited<ReturnType<typeof getDbClient>>['schema'], options: KnowledgeEdgeAsOf = {}) {
  const { validAt, recordedAt } = edgeAsOfDates(options);
  const edges = schema.knowledgeEdges;
  return [
    lte(edges.validFrom, validAt),
    or(isNull(edges.validTo), gt(edges.validTo, validAt)),
    lte(edges.recordedAt, recordedAt),
    or(isNull(edges.recordedTo), gt(edges.recordedTo, recordedAt)),
  ];
}

function postgresProjectCondition(projectColumn: SQLWrapper, projectId: string | null): SQLWrapper {
  return projectId === null ? isNull(projectColumn) : eq(projectColumn, projectId);
}

// ─── Edge CRUD ───────────────────────────────────────────────────────────────

/**
 * Create an edge between two nodes (knowledge, entity, or place).
 * Deduplicates by the unique constraint.
 */
export async function createKnowledgeEdge(input: CreateKnowledgeEdgeInput): Promise<KnowledgeEdge> {
  const needsCycleCheck = input.fromKind === input.toKind && (
    (input.fromKind === 'entity' && input.edgeType === 'supersedes_version')
    || (input.fromKind === 'knowledge' && (input.edgeType === 'supersedes' || input.edgeType === 'updates'))
  );
  if (!needsCycleCheck) return createKnowledgeEdgeUnchecked(input);

  await ensureKnowledgeTables();
  const client = await getDbClient();
  if ((client.db as { $clientType?: string }).$clientType === 'postgres') {
    return createKnowledgeEdgeUnchecked(input);
  }
  const sqlite = (client.raw as { $client?: SqliteCycleClient }).$client;
  if (!sqlite) {
    throw new Error('SQLite supersession writes require a cycle-checkable database client');
  }

  return withSqliteSupersessionWriteLock(sqlite, async () => {
    const ownsTransaction = !sqlite.inTransaction;
    if (ownsTransaction) sqlite.exec('BEGIN IMMEDIATE');
    try {
      // A caller may own a deferred transaction. Force its first write here so
      // the temporal cycle check cannot race another SQLite connection's writer.
      if (!ownsTransaction) sqlite.prepare('UPDATE knowledge_edges SET id = id WHERE 0').run();
      if (createsSqliteTemporalCycle(sqlite, input)) {
        throw new Error('Knowledge edge supersession would create a cycle');
      }
      const edge = await createKnowledgeEdgeUnchecked(input);
      if (ownsTransaction) sqlite.exec('COMMIT');
      return edge;
    } catch (error) {
      if (ownsTransaction && sqlite.inTransaction) sqlite.exec('ROLLBACK');
      throw error;
    }
  });
}

async function createKnowledgeEdgeUnchecked(input: CreateKnowledgeEdgeInput): Promise<KnowledgeEdge> {
  const strict = isStrictTrustPolicy();
  const needsCycleCheck = input.fromKind === input.toKind
    && supersessionTypes(input.fromKind)?.includes(input.edgeType) === true;
  const signedKnowledgeRelation = input.fromKind === 'knowledge' && input.toKind === 'knowledge'
    && isSourceBackedKnowledgeEdgeType(input.edgeType);
  if (strict && (input.fromKind !== 'entity' || input.toKind !== 'entity') && !signedKnowledgeRelation) {
    await denyStrictEdgeMutation('creation', input.fromId);
  }
  await ensureKnowledgeTables();
  const client = await getDbClient();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const validFrom = epochMillis(input.validFrom ?? new Date());
  const validTo = input.validTo == null ? null : epochMillis(input.validTo);
  const recordedAt = epochMillis(input.recordedAt ?? new Date());
  if (validTo !== null && validTo <= validFrom) throw new Error('Knowledge edge validTo must be later than validFrom');
  const weight = input.weight ?? 1.0;
  const metadata = withGraphRelationSignature({
    fromId: input.fromId, fromKind: input.fromKind, toId: input.toId, toKind: input.toKind,
    edgeType: input.edgeType, weight, metadata: input.metadata ?? null,
  });
  const candidate: KnowledgeEdge = {
    id, ...input, weight, metadata,
    createdAt: new Date(now * 1000),
    validFrom: new Date(validFrom),
    validTo: validTo === null ? null : new Date(validTo),
    recordedAt: new Date(recordedAt),
    recordedTo: null,
  };
  if ((client.db as { $clientType?: string }).$clientType === 'postgres') {
    if (strict) await denyStrictEdgeMutation('creation', input.fromId);
    const native = await getDb();
    if (typeof (native as { transaction?: unknown }).transaction !== 'function') {
      throw new Error('PostgreSQL knowledge-edge creation requires a transaction-capable database');
    }
    return (native as any).transaction(async (tx: any) => {
      const projectTableByNodeKind = {
        entity: client.schema.entities,
        knowledge: client.schema.knowledge,
        place: client.schema.places,
      };
      const fromTable = projectTableByNodeKind[input.fromKind];
      const toTable = projectTableByNodeKind[input.toKind];
      const [fromRows, toRows] = await Promise.all([
        tx.select({ projectId: fromTable.projectId }).from(fromTable).where(eq(fromTable.id, input.fromId)).for('key share').limit(1),
        tx.select({ projectId: toTable.projectId }).from(toTable).where(eq(toTable.id, input.toId)).for('key share').limit(1),
      ]);
      const from = fromRows[0] as { projectId: string | null } | undefined;
      const to = toRows[0] as { projectId: string | null } | undefined;
      if (needsCycleCheck && (!from || !to)) throw new Error('Graph edge endpoints must exist');
      if (from && to && from.projectId !== to.projectId) {
        if (input.fromKind === 'entity' && input.toKind === 'entity') {
          throw new Error('Entity graph edges must stay within one project');
        }
        throw new Error('Graph edges must stay within one project');
      }
      if (needsCycleCheck && from && to) {
        await lockPostgresSupersessionScope(tx, from.projectId, input.fromKind);
        if (await createsPostgresTemporalCycle(tx, input, from.projectId)) {
          throw new Error('Knowledge edge supersession would create a cycle');
        }
      }
      if (!input.validFrom && !input.recordedAt && validTo === null) {
        const [current] = await tx.select().from(client.schema.knowledgeEdges).where(and(
          eq(client.schema.knowledgeEdges.fromId, input.fromId),
          eq(client.schema.knowledgeEdges.fromKind, input.fromKind),
          eq(client.schema.knowledgeEdges.toId, input.toId),
          eq(client.schema.knowledgeEdges.toKind, input.toKind),
          eq(client.schema.knowledgeEdges.edgeType, input.edgeType),
          isNull(client.schema.knowledgeEdges.validTo),
          isNull(client.schema.knowledgeEdges.recordedTo),
        )).orderBy(desc(client.schema.knowledgeEdges.recordedAt)).limit(1);
        if (current) return toKnowledgeEdge(current);
      }
      const [inserted] = await tx.insert(client.schema.knowledgeEdges).values(candidate).onConflictDoNothing().returning();
      if (inserted) return toKnowledgeEdge(inserted);
      const [existing] = await tx.select().from(client.schema.knowledgeEdges).where(and(
        eq(client.schema.knowledgeEdges.fromId, input.fromId),
        eq(client.schema.knowledgeEdges.fromKind, input.fromKind),
        eq(client.schema.knowledgeEdges.toId, input.toId),
        eq(client.schema.knowledgeEdges.toKind, input.toKind),
        eq(client.schema.knowledgeEdges.edgeType, input.edgeType),
        eq(client.schema.knowledgeEdges.validFrom, candidate.validFrom),
        eq(client.schema.knowledgeEdges.recordedAt, candidate.recordedAt),
      )).limit(1);
      return existing ? toKnowledgeEdge(existing) : candidate;
    });
  }
  const { raw } = client;
  const sqlite = (raw as any).$client;
  if (!sqlite) throw new Error('Database not available');
  const ownsTransaction = !sqlite.inTransaction;
  if (ownsTransaction) sqlite.exec('BEGIN IMMEDIATE');
  let transactionOwned = ownsTransaction;
  try {
    // A caller may own a deferred transaction; acquire its write lock before
    // authorization reads so another connection cannot change their snapshot.
    if (!ownsTransaction) sqlite.prepare('UPDATE knowledge_edges SET id = id WHERE 0').run();

    if (strict) {
      const { filterStrictEntityEdges, filterStrictKnowledgeEdges } = await import('../graph/strict-access.js');
      const authorized = signedKnowledgeRelation
        ? await filterStrictKnowledgeEdges([candidate])
        : await filterStrictEntityEdges([candidate]);
      if (authorized.length !== 1) {
        if (transactionOwned) {
          sqlite.exec('COMMIT');
          transactionOwned = false;
        }
        throw new TrustBoundaryError('Source-backed graph-edge creation is not authorized under strict trust');
      }
    }

    // Keep endpoint validation and insertion in the same locked transaction.
    assertSqliteEdgeProject(sqlite, input.fromId, input.fromKind, input.toId, input.toKind, { requireEndpoints: true });

    if (!input.validFrom && !input.recordedAt && validTo === null) {
      const current = sqlite.prepare(`
        SELECT * FROM knowledge_edges
        WHERE from_id = ? AND from_kind = ? AND to_id = ? AND to_kind = ? AND edge_type = ?
          AND valid_to IS NULL AND recorded_to IS NULL
        ORDER BY recorded_at DESC LIMIT 1
      `).get(input.fromId, input.fromKind, input.toId, input.toKind, input.edgeType);
      if (current) {
        const existing = toKnowledgeEdge(current);
        if (strict) {
          const { filterStrictEntityEdges, filterStrictKnowledgeEdges } = await import('../graph/strict-access.js');
          const authorized = signedKnowledgeRelation
            ? await filterStrictKnowledgeEdges([existing])
            : await filterStrictEntityEdges([existing]);
          if (authorized.length !== 1) {
            if (transactionOwned) {
              sqlite.exec('COMMIT');
              transactionOwned = false;
            }
            throw new TrustBoundaryError('Existing graph edge is not authorized under strict trust');
          }
        }
        if (transactionOwned) {
          sqlite.exec('COMMIT');
          transactionOwned = false;
        }
        return existing;
      }
    }

    sqlite.prepare(`
      INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, valid_to, recorded_at, recorded_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id,
      input.fromId,
      input.fromKind,
      input.toId,
      input.toKind,
      input.edgeType,
      weight,
      serializeJson(metadata),
      now,
      validFrom,
      validTo,
      recordedAt,
    );

    const row = sqlite.prepare(`
      SELECT * FROM knowledge_edges WHERE from_id = ? AND from_kind = ? AND to_id = ? AND to_kind = ? AND edge_type = ? AND valid_from = ? AND recorded_at = ?
    `).get(input.fromId, input.fromKind, input.toId, input.toKind, input.edgeType, validFrom, recordedAt);
    if (transactionOwned) {
      sqlite.exec('COMMIT');
      transactionOwned = false;
    }
    return row ? toKnowledgeEdge(row) : candidate;
  } catch (error) {
    if (transactionOwned && sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Append a corrected edge version while retaining what Squish believed before. */
export async function reviseKnowledgeEdge(
  id: string,
  revision: { validFrom?: Date; validTo?: Date | null; weight?: number; metadata?: Record<string, unknown> | null; recordedAt?: Date; recordedTo?: Date | null; shouldApply?: () => boolean },
): Promise<KnowledgeEdge | null> {
  if (isStrictTrustPolicy()) await denyStrictEdgeMutation('revision', id);
  await ensureKnowledgeTables();
  const client = await getDbClient();
  if ((client.db as { $clientType?: string }).$clientType === 'postgres') {
    const native = await getDb();
    if (typeof (native as { transaction?: unknown }).transaction !== 'function') {
      throw new Error('PostgreSQL knowledge-edge revision requires a transaction-capable database');
    }
    return (native as any).transaction(async (tx: any) => {
      const [current] = await tx.select().from(client.schema.knowledgeEdges)
        .where(and(eq(client.schema.knowledgeEdges.id, id), isNull(client.schema.knowledgeEdges.recordedTo)))
        .for('update').limit(1);
      if (!current) return null;
      if (revision.shouldApply && !revision.shouldApply()) return null;
      const old = toKnowledgeEdge(current);
      const previousRecorded = epochMillis(old.recordedAt ?? old.createdAt);
      const requestedRecorded = revision.recordedAt ? epochMillis(revision.recordedAt) : Date.now();
      const recordedAt = Math.max(requestedRecorded, previousRecorded + 1);
      const validFrom = epochMillis(revision.validFrom ?? old.validFrom ?? old.createdAt);
      const validTo = revision.validTo === undefined ? (old.validTo ? epochMillis(old.validTo) : null)
        : revision.validTo === null ? null : epochMillis(revision.validTo);
      if (validTo !== null && validTo <= validFrom) throw new Error('Knowledge edge validTo must be later than validFrom');
      const recordedTo = revision.recordedTo == null ? null : epochMillis(revision.recordedTo);
      if (recordedTo !== null && recordedTo <= recordedAt) throw new Error('Knowledge edge recordedTo must be later than recordedAt');
      const replacementId = randomUUID();
      const weight = revision.weight ?? old.weight;
      const metadata = withGraphRelationSignature({
        fromId: old.fromId, fromKind: old.fromKind, toId: old.toId, toKind: old.toKind,
        edgeType: old.edgeType, weight, metadata: revision.metadata === undefined ? old.metadata : revision.metadata,
      });
      const needsCycleCheck = old.fromKind === old.toKind && supersessionTypes(old.fromKind)?.includes(old.edgeType);
      const nodeTableByKind = { entity: client.schema.entities, knowledge: client.schema.knowledge } as const;
      if (old.fromKind !== 'place' && old.toKind !== 'place') {
        const fromTable = nodeTableByKind[old.fromKind];
        const toTable = nodeTableByKind[old.toKind];
        const [fromRows, toRows] = await Promise.all([
          tx.select({ projectId: fromTable.projectId }).from(fromTable).where(eq(fromTable.id, old.fromId)).for('key share').limit(1),
          tx.select({ projectId: toTable.projectId }).from(toTable).where(eq(toTable.id, old.toId)).for('key share').limit(1),
        ]);
        const from = fromRows[0] as { projectId: string | null } | undefined;
        const to = toRows[0] as { projectId: string | null } | undefined;
        if (needsCycleCheck && (!from || !to)) throw new Error('Graph edge endpoints must exist');

        const requestedValidTo = revision.validTo === undefined
          ? (old.validTo ? epochMillis(old.validTo) : null)
          : revision.validTo === null ? null : epochMillis(revision.validTo);
        const oldValidFrom = epochMillis(old.validFrom ?? old.createdAt);
        const oldValidTo = old.validTo == null ? null : epochMillis(old.validTo);
        const isScopeMismatchClosure = revision.validFrom === undefined
          && requestedValidTo !== null
          && requestedValidTo <= Date.now()
          && requestedValidTo > oldValidFrom
          && (oldValidTo === null || requestedValidTo <= oldValidTo)
          && revision.weight === undefined
          && revision.metadata === undefined
          && revision.recordedTo == null
          && revision.shouldApply === undefined;
        if (from && to && from.projectId !== to.projectId && !isScopeMismatchClosure) {
          if (old.fromKind === 'entity' && old.toKind === 'entity') {
            throw new Error('Entity graph edges must stay within one project');
          }
          throw new Error('Graph edges must stay within one project');
        }

        if (needsCycleCheck && from && to && !isScopeMismatchClosure) {
          await lockPostgresSupersessionScope(tx, from.projectId, old.fromKind);
          if (await createsPostgresTemporalCycle(tx, {
            fromId: old.fromId,
            fromKind: old.fromKind,
            toId: old.toId,
            toKind: old.toKind,
            edgeType: old.edgeType,
            weight,
            metadata: metadata ?? undefined,
            validFrom: new Date(validFrom),
            validTo: validTo === null ? null : new Date(validTo),
            recordedAt: new Date(recordedAt),
          }, from.projectId)) {
            throw new Error('Knowledge edge supersession would create a cycle');
          }
        }
      }
      const closed = await tx.update(client.schema.knowledgeEdges).set({ recordedTo: new Date(recordedAt) })
        .where(and(eq(client.schema.knowledgeEdges.id, id), isNull(client.schema.knowledgeEdges.recordedTo)))
        .returning({ id: client.schema.knowledgeEdges.id });
      if (closed.length !== 1) throw new Error('Knowledge edge changed during revision');
      const [replacement] = await tx.insert(client.schema.knowledgeEdges).values({
        id: replacementId,
        fromId: old.fromId,
        fromKind: old.fromKind,
        toId: old.toId,
        toKind: old.toKind,
        edgeType: old.edgeType,
        weight,
        metadata,
        createdAt: new Date(recordedAt),
        validFrom: new Date(validFrom),
        validTo: validTo === null ? null : new Date(validTo),
        recordedAt: new Date(recordedAt),
        recordedTo: recordedTo === null ? null : new Date(recordedTo),
      }).returning();
      return replacement ? toKnowledgeEdge(replacement) : null;
    });
  }
  const { raw } = client;
  const sqlite = (raw as any).$client;
  if (!sqlite) throw new Error('Database not available');
  const revise = async (): Promise<KnowledgeEdge | null> => {
    // SQLite applies the temporal close+replacement synchronously below. Recheck
    // after all async setup so lifecycle invalidation can cancel stale feedback.
    if (revision.shouldApply && !revision.shouldApply()) return null;
    const ownsTransaction = !sqlite.inTransaction;
    if (ownsTransaction) sqlite.exec('BEGIN IMMEDIATE');
    try {
      // A caller-owned deferred transaction must acquire the writer lock before
      // reading the current version or checking temporal cycle constraints.
      if (!ownsTransaction) sqlite.prepare('UPDATE knowledge_edges SET id = id WHERE 0').run();
      const current = sqlite.prepare('SELECT * FROM knowledge_edges WHERE id = ? AND recorded_to IS NULL').get(id);
      if (!current) {
        if (ownsTransaction) sqlite.exec('COMMIT');
        return null;
      }
      const old = toKnowledgeEdge(current);
      const previousRecorded = epochMillis(old.recordedAt ?? old.createdAt);
      const requestedRecorded = revision.recordedAt ? epochMillis(revision.recordedAt) : Date.now();
      const recordedAt = Math.max(requestedRecorded, previousRecorded + 1);
      const validFrom = epochMillis(revision.validFrom ?? old.validFrom ?? old.createdAt);
      const validTo = revision.validTo === undefined ? (old.validTo ? epochMillis(old.validTo) : null)
        : revision.validTo === null ? null : epochMillis(revision.validTo);
      if (validTo !== null && validTo <= validFrom) throw new Error('Knowledge edge validTo must be later than validFrom');

      const recordedTo = revision.recordedTo == null ? null : epochMillis(revision.recordedTo);
      if (recordedTo !== null && recordedTo <= recordedAt) throw new Error('Knowledge edge recordedTo must be later than recordedAt');
      const replacementId = randomUUID();
      const weight = revision.weight ?? old.weight;
      const metadata = withGraphRelationSignature({
        fromId: old.fromId, fromKind: old.fromKind, toId: old.toId, toKind: old.toKind,
        edgeType: old.edgeType, weight, metadata: revision.metadata === undefined ? old.metadata : revision.metadata,
      });
      const requestedValidTo = revision.validTo == null ? null : epochMillis(revision.validTo);
      const oldValidFrom = epochMillis(old.validFrom ?? old.createdAt);
      const oldValidTo = old.validTo == null ? null : epochMillis(old.validTo);
      const isScopeMismatchClosure = revision.validFrom === undefined
        && requestedValidTo !== null
        && requestedValidTo <= Date.now()
        && requestedValidTo > oldValidFrom
        && (oldValidTo === null || requestedValidTo <= oldValidTo)
        && revision.weight === undefined
        && revision.metadata === undefined
        && revision.recordedTo == null
        && revision.shouldApply === undefined;
      assertSqliteEdgeProject(sqlite, old.fromId, old.fromKind, old.toId, old.toKind, {
        allowExistingScopeClosure: isScopeMismatchClosure,
      });
      const needsCycleCheck = old.fromKind === old.toKind && (
        (old.fromKind === 'entity' && old.edgeType === 'supersedes_version')
        || (old.fromKind === 'knowledge' && (old.edgeType === 'supersedes' || old.edgeType === 'updates'))
      );
      if (needsCycleCheck && createsSqliteTemporalCycle(sqlite, {
        fromId: old.fromId,
        fromKind: old.fromKind,
        toId: old.toId,
        toKind: old.toKind,
        edgeType: old.edgeType,
        weight,
        metadata: metadata ?? undefined,
        validFrom: new Date(validFrom),
        validTo: validTo === null ? null : new Date(validTo),
        recordedAt: new Date(recordedAt),
      })) {
        throw new Error('Knowledge edge supersession would create a cycle');
      }
      const closed = sqlite.prepare('UPDATE knowledge_edges SET recorded_to = ? WHERE id = ? AND recorded_to IS NULL').run(recordedAt, id);
      if (lastStatementChanges(sqlite) !== 1) throw new Error('Knowledge edge changed during revision');
      sqlite.prepare(`
        INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, valid_to, recorded_at, recorded_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(replacementId, old.fromId, old.fromKind, old.toId, old.toKind, old.edgeType,
        weight,
        serializeJson(metadata),
        recordedAt, validFrom, validTo, recordedAt, recordedTo);
      if (ownsTransaction) sqlite.exec('COMMIT');
      const row = sqlite.prepare('SELECT * FROM knowledge_edges WHERE id = ?').get(replacementId);
      return row ? toKnowledgeEdge(row) : null;
    } catch (error) {
      if (ownsTransaction && sqlite.inTransaction) sqlite.exec('ROLLBACK');
      throw error;
    }
  };
  return withSqliteSupersessionWriteLock(sqlite, revise);
}

/** End a relationship in valid time without deleting either temporal version. */
export async function closeKnowledgeEdge(id: string, validTo: Date, recordedAt?: Date): Promise<KnowledgeEdge | null> {
  return reviseKnowledgeEdge(id, { validTo, recordedAt });
}

/** Retract a false recorded assertion while preserving its historical interval. */
export async function retractKnowledgeEdge(id: string, recordedAt = new Date()): Promise<KnowledgeEdge | null> {
  if (isStrictTrustPolicy()) await denyStrictEdgeMutation('retraction', id);
  await ensureKnowledgeTables();
  const client = await getDbClient();
  if ((client.db as { $clientType?: string }).$clientType === 'postgres') {
    const native = await getDb();
    if (typeof (native as { transaction?: unknown }).transaction !== 'function') {
      throw new Error('PostgreSQL knowledge-edge retraction requires a transaction-capable database');
    }
    return (native as any).transaction(async (tx: any) => {
      const [current] = await tx.select().from(client.schema.knowledgeEdges)
        .where(and(eq(client.schema.knowledgeEdges.id, id), isNull(client.schema.knowledgeEdges.recordedTo)))
        .for('update').limit(1);
      if (!current) return null;
      const old = toKnowledgeEdge(current);
      const corrected = epochMillis(recordedAt);
      const prior = epochMillis(old.recordedAt ?? old.createdAt);
      if (corrected <= prior) throw new Error('Knowledge edge recordedAt must be later than its current recordedAt');
      const [updated] = await tx.update(client.schema.knowledgeEdges).set({ recordedTo: new Date(corrected) })
        .where(and(eq(client.schema.knowledgeEdges.id, id), isNull(client.schema.knowledgeEdges.recordedTo)))
        .returning();
      return updated ? toKnowledgeEdge(updated) : null;
    });
  }
  const { raw } = client;
  const sqlite = (raw as any).$client;
  if (!sqlite) throw new Error('Database not available');
  const current = sqlite.prepare('SELECT * FROM knowledge_edges WHERE id = ? AND recorded_to IS NULL').get(id);
  if (!current) return null;
  const old = toKnowledgeEdge(current);
  const correctionRecorded = epochMillis(recordedAt);
  const priorRecorded = epochMillis(old.recordedAt ?? old.createdAt);
  if (correctionRecorded <= priorRecorded) throw new Error('Knowledge edge recordedAt must be later than its current recordedAt');

  const ownsTransaction = !sqlite.inTransaction;
  if (ownsTransaction) sqlite.exec('BEGIN IMMEDIATE');
  try {
    const closed = sqlite.prepare('UPDATE knowledge_edges SET recorded_to = ? WHERE id = ? AND recorded_to IS NULL')
      .run(correctionRecorded, id);
    if (lastStatementChanges(sqlite) !== 1) throw new Error('Knowledge edge changed during retraction');
    if (ownsTransaction) sqlite.exec('COMMIT');
    const row = sqlite.prepare('SELECT * FROM knowledge_edges WHERE id = ?').get(id);
    return row ? toKnowledgeEdge(row) : null;
  } catch (error) {
    if (ownsTransaction) sqlite.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Get all edges from a node (outgoing).
 */
export async function getEdgesFrom(
  nodeId: string,
  nodeKind: EdgeNodeKind,
  edgeType?: string,
  asOf: KnowledgeEdgeAsOf = {},
): Promise<KnowledgeEdge[]> {
  await ensureKnowledgeTables();
  const client = await getDbClient();
  const { raw } = client;
  if ((client.db as { $clientType?: string }).$clientType === 'postgres') {
    const conditions = [
      eq(client.schema.knowledgeEdges.fromId, nodeId),
      eq(client.schema.knowledgeEdges.fromKind, nodeKind),
      ...postgresEdgeAsOfConditions(client.schema, asOf),
    ];
    if (edgeType) conditions.push(eq(client.schema.knowledgeEdges.edgeType, edgeType));
    const rows = await client.db.select().from(client.schema.knowledgeEdges)
      .where(and(...conditions))
      .orderBy(desc(client.schema.knowledgeEdges.weight), asc(client.schema.knowledgeEdges.id));
    return strictVisibleEdges(rows.map(toKnowledgeEdge), asOf);
  }
  const sqlite = (raw as any).$client;
  if (!sqlite) return [];

  let query = 'SELECT * FROM knowledge_edges WHERE from_id = ? AND from_kind = ?';
  const params: any[] = [nodeId, nodeKind];

  if (edgeType) {
    query += ' AND edge_type = ?';
    params.push(edgeType);
  }

  const temporal = asOfPredicate(asOf);
  query += temporal.sql;
  params.push(...temporal.params);

  query += ' ORDER BY weight DESC';

  const edges = sqlite.prepare(query).all(...params).map(toKnowledgeEdge) as KnowledgeEdge[];
  return strictVisibleEdges(edges, asOf);
}

/**
 * Get all edges to a node (incoming).
 */
export async function getEdgesTo(
  nodeId: string,
  nodeKind: EdgeNodeKind,
  edgeType?: string,
  asOf: KnowledgeEdgeAsOf = {},
): Promise<KnowledgeEdge[]> {
  await ensureKnowledgeTables();
  const client = await getDbClient();
  const { raw } = client;
  if ((client.db as { $clientType?: string }).$clientType === 'postgres') {
    const conditions = [
      eq(client.schema.knowledgeEdges.toId, nodeId),
      eq(client.schema.knowledgeEdges.toKind, nodeKind),
      ...postgresEdgeAsOfConditions(client.schema, asOf),
    ];
    if (edgeType) conditions.push(eq(client.schema.knowledgeEdges.edgeType, edgeType));
    const rows = await client.db.select().from(client.schema.knowledgeEdges)
      .where(and(...conditions))
      .orderBy(desc(client.schema.knowledgeEdges.weight), asc(client.schema.knowledgeEdges.id));
    return strictVisibleEdges(rows.map(toKnowledgeEdge), asOf);
  }
  const sqlite = (raw as any).$client;
  if (!sqlite) return [];

  let query = 'SELECT * FROM knowledge_edges WHERE to_id = ? AND to_kind = ?';
  const params: any[] = [nodeId, nodeKind];

  if (edgeType) {
    query += ' AND edge_type = ?';
    params.push(edgeType);
  }

  const temporal = asOfPredicate(asOf);
  query += temporal.sql;
  params.push(...temporal.params);

  query += ' ORDER BY weight DESC';

  const edges = sqlite.prepare(query).all(...params).map(toKnowledgeEdge) as KnowledgeEdge[];
  return strictVisibleEdges(edges, asOf);
}

/**
 * Get all edges connected to a node (both directions).
 */
export async function getEdgesForNode(
  nodeId: string,
  nodeKind: EdgeNodeKind,
  asOf: KnowledgeEdgeAsOf = {},
): Promise<KnowledgeEdge[]> {
  await ensureKnowledgeTables();
  const client = await getDbClient();
  const { raw } = client;
  if ((client.db as { $clientType?: string }).$clientType === 'postgres') {
    const conditions = [
      or(
        and(eq(client.schema.knowledgeEdges.fromId, nodeId), eq(client.schema.knowledgeEdges.fromKind, nodeKind)),
        and(eq(client.schema.knowledgeEdges.toId, nodeId), eq(client.schema.knowledgeEdges.toKind, nodeKind)),
      ),
      ...postgresEdgeAsOfConditions(client.schema, asOf),
    ];
    const rows = await client.db.select().from(client.schema.knowledgeEdges)
      .where(and(...conditions))
      .orderBy(desc(client.schema.knowledgeEdges.weight), asc(client.schema.knowledgeEdges.id));
    return strictVisibleEdges(rows.map(toKnowledgeEdge), asOf);
  }
  const sqlite = (raw as any).$client;
  if (!sqlite) return [];

  const temporal = asOfPredicate(asOf);
  const rows = sqlite.prepare(`
    SELECT * FROM knowledge_edges
    WHERE ((from_id = ? AND from_kind = ?) OR (to_id = ? AND to_kind = ?))
      AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
      AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)
    ORDER BY weight DESC
  `).all(nodeId, nodeKind, nodeId, nodeKind, ...temporal.params);

  const edges = rows.map(toKnowledgeEdge) as KnowledgeEdge[];
  return strictVisibleEdges(edges, asOf);
}

function edgeSupportIds(edge: KnowledgeEdge): string[] | null {
  const supportIds = edge.metadata?.sourceMemoryIds;
  if (!Array.isArray(supportIds)) return null;
  const normalized = [...new Set(supportIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))];
  return normalized.length > 0 ? normalized : null;
}

async function filterInactiveSourceEdges(edges: KnowledgeEdge[], asOf: KnowledgeEdgeAsOf): Promise<KnowledgeEdge[]> {
  if (isStrictTrustPolicy() || asOf.validAt !== undefined || asOf.recordedAt !== undefined) return edges;
  const supportIds = [...new Set(edges.flatMap((edge) => edgeSupportIds(edge) ?? []))];
  if (supportIds.length === 0) {
    return edges.filter((edge) => edgeSupportIds(edge) === null);
  }

  const client = await getDbClient();
  const sqlite = (client.raw as { $client?: { prepare?: (sql: string) => { all: (...values: unknown[]) => Array<{ id: string }> } } }).$client;
  const currentTime = new Date();
  const nowSeconds = Math.floor(currentTime.getTime() / 1000);
  const activeSources: Array<{ id: string }> = sqlite?.prepare
    ? sqlite.prepare(`
        SELECT id FROM memories
        WHERE id IN (${supportIds.map(() => '?').join(', ')}) AND status = 'active' AND is_active = 1
          AND ${sqlLifecycleBound('valid_from', '<=')}
          AND ${sqlLifecycleBound('valid_to', '>')}
          AND ${sqlLifecycleBound('expires_at', '>')}
      `).all(...supportIds, nowSeconds, nowSeconds, nowSeconds)
    : await client.db.select({ id: client.schema.memories.id }).from(client.schema.memories).where(and(
      inArray(client.schema.memories.id, supportIds),
      eq(client.schema.memories.status, 'active'),
      eq(client.schema.memories.isActive, true),
      or(isNull(client.schema.memories.validFrom), lte(client.schema.memories.validFrom, currentTime)),
      or(isNull(client.schema.memories.validTo), gt(client.schema.memories.validTo, currentTime)),
      or(isNull(client.schema.memories.expiresAt), gt(client.schema.memories.expiresAt, currentTime)),
    ));
  const activeIds = new Set(activeSources.map((source) => source.id));
  return edges.filter((edge) => {
    const sources = edgeSupportIds(edge);
    return sources === null || sources.some((id) => activeIds.has(id));
  });
}

/** Raw-edge APIs expose only currently supported rows and, under strict trust, authorized relations. */
async function strictVisibleEdges(edges: KnowledgeEdge[], asOf: KnowledgeEdgeAsOf = {}): Promise<KnowledgeEdge[]> {
  const currentEdges = await filterInactiveSourceEdges(edges, asOf);
  if (!isStrictTrustPolicy()) return currentEdges;
  const { resolveTrustedCallerId } = await import('../acl/trust-policy.js');
  const callerId = resolveTrustedCallerId();
  if (!callerId) throw new TrustBoundaryError('Strict edge reads require an authenticated caller identity');
  const entityRelations = currentEdges.filter((edge) => edge.fromKind === 'entity' && edge.toKind === 'entity');
  const knowledgeRelations = currentEdges.filter((edge) => edge.fromKind === 'knowledge'
    && edge.toKind === 'knowledge' && isSourceBackedKnowledgeEdgeType(edge.edgeType));
  const { filterStrictEntityEdges, filterStrictKnowledgeEdges } = await import('../graph/strict-access.js');
  const visible = await filterStrictEntityEdges(entityRelations, new Map(), callerId, true, asOf);
  const authorizedKnowledgeRelations = await filterStrictKnowledgeEdges(knowledgeRelations, new Map(), callerId, asOf);
  const withheld = currentEdges.length - entityRelations.length - knowledgeRelations.length;
  if (withheld > 0) {
    const { writeTrustAudit } = await import('../acl/trust-audit.js');
    for (const edge of currentEdges.filter((candidate) => !entityRelations.includes(candidate) && !knowledgeRelations.includes(candidate))) {
      await writeTrustAudit({ actorId: callerId, resourceId: edge.id, assetType: 'knowledge_edge', decision: 'deny', reason: 'private_default' });
    }
  }
  return [...visible, ...authorizedKnowledgeRelations];
}

/** Close every current edge touching a node while preserving its prior versions. */
export async function closeEdgesForNode(nodeId: string, nodeKind: EdgeNodeKind, at = new Date()): Promise<number> {
  if (isStrictTrustPolicy()) await denyStrictEdgeMutation('bulk close', nodeId);
  const edges = await getEdgesForNode(nodeId, nodeKind);
  let closed = 0;
  for (const edge of edges) {
    if (await reviseKnowledgeEdge(edge.id, { validTo: at, recordedAt: at })) closed++;
  }
  return closed;
}

/**
 * Delete an edge by ID.
 */
export async function deleteKnowledgeEdge(id: string): Promise<boolean> {
  if (isStrictTrustPolicy()) await denyStrictEdgeMutation('deletion', id);
  await ensureKnowledgeTables();
  const { raw } = await getDbClient();
  const sqlite = (raw as any).$client;
  if (!sqlite) return false;

  const result = sqlite.prepare('DELETE FROM knowledge_edges WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Delete all edges from/to a node (used during cleanup).
 */
export async function deleteEdgesForNode(nodeId: string, nodeKind: EdgeNodeKind): Promise<number> {
  if (isStrictTrustPolicy()) await denyStrictEdgeMutation('bulk deletion', nodeId);
  await ensureKnowledgeTables();
  const { raw } = await getDbClient();
  const sqlite = (raw as any).$client;
  if (!sqlite) return 0;

  const r1 = sqlite.prepare('DELETE FROM knowledge_edges WHERE from_id = ? AND from_kind = ?').run(nodeId, nodeKind);
  const r2 = sqlite.prepare('DELETE FROM knowledge_edges WHERE to_id = ? AND to_kind = ?').run(nodeId, nodeKind);
  return r1.changes + r2.changes;
}

// ─── Graph Traversal ─────────────────────────────────────────────────────────

/**
 * Get connected entities for a knowledge record.
 *
 * Finds entity IDs linked to this knowledge via knowledge_edges, then returns
 * other knowledge records that also reference those same entities — giving
 * callers a transitive view of the knowledge graph through shared entities.
 */
export async function getConnectedEntities(knowledgeId: string): Promise<Knowledge[]> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(`connected_entities:${knowledgeId}`, 'knowledge_edge', 'Unscoped connected-entity reads are disabled under strict trust');
  }
  await ensureKnowledgeTables();
  const client = await getDbClient();
  const { raw } = client;
  if ((client.db as { $clientType?: string }).$clientType === 'postgres') {
    const edges = client.schema.knowledgeEdges;
    const [origin] = await client.db.select({ projectId: client.schema.knowledge.projectId })
      .from(client.schema.knowledge).where(eq(client.schema.knowledge.id, knowledgeId)).limit(1);
    if (!origin) return [];
    const asOf = { validAt: new Date(), recordedAt: new Date() };
    const active = postgresEdgeAsOfConditions(client.schema, asOf);
    const outgoing = await client.db.select({ entityId: edges.toId }).from(edges).where(and(
      eq(edges.fromId, knowledgeId), eq(edges.fromKind, 'knowledge'), eq(edges.toKind, 'entity'), ...active,
    ));
    const incoming = await client.db.select({ entityId: edges.fromId }).from(edges).where(and(
      eq(edges.toId, knowledgeId), eq(edges.toKind, 'knowledge'), eq(edges.fromKind, 'entity'), ...active,
    ));
    const entityIds = [...new Set([...outgoing, ...incoming].map((row) => row.entityId))];
    if (entityIds.length === 0) return [];

    const [fromKnowledge, toKnowledgeEdges] = await Promise.all([
      client.db.select({ knowledgeId: edges.fromId }).from(edges)
        .innerJoin(client.schema.knowledge, eq(client.schema.knowledge.id, edges.fromId)).where(and(
        inArray(edges.toId, entityIds), eq(edges.toKind, 'entity'), eq(edges.fromKind, 'knowledge'),
        postgresProjectCondition(client.schema.knowledge.projectId, origin.projectId),
        ...postgresEdgeAsOfConditions(client.schema, asOf),
      )),
      client.db.select({ knowledgeId: edges.toId }).from(edges)
        .innerJoin(client.schema.knowledge, eq(client.schema.knowledge.id, edges.toId)).where(and(
        inArray(edges.fromId, entityIds), eq(edges.fromKind, 'entity'), eq(edges.toKind, 'knowledge'),
        postgresProjectCondition(client.schema.knowledge.projectId, origin.projectId),
        ...postgresEdgeAsOfConditions(client.schema, asOf),
      )),
    ]);
    const knowledgeIds = [...new Set([...fromKnowledge, ...toKnowledgeEdges]
      .map((row) => row.knowledgeId).filter((id) => id !== knowledgeId))];
    if (knowledgeIds.length === 0) return [];
    const rows = await client.db.select().from(client.schema.knowledge).where(and(
      inArray(client.schema.knowledge.id, knowledgeIds), eq(client.schema.knowledge.isActive, true),
      postgresProjectCondition(client.schema.knowledge.projectId, origin.projectId),
    )).orderBy(desc(client.schema.knowledge.updatedAt), asc(client.schema.knowledge.id)).limit(50);
    return rows.map((row: Record<string, unknown>) => toKnowledge(row));
  }
  const sqlite = (raw as any).$client;
  if (!sqlite) return [];
  const origin = sqlite.prepare('SELECT project_id FROM knowledge WHERE id = ?').get(knowledgeId) as { project_id: string | null } | undefined;
  if (!origin) return [];
  const now = Date.now();
  const activeParams = [now, now, now, now];

  // Collect entity IDs from both outgoing and incoming edges
  const outgoingEdges = sqlite.prepare(`
    SELECT edge.to_id AS entity_id FROM knowledge_edges AS edge
    JOIN entities AS entity ON entity.id = edge.to_id AND entity.project_id IS ?
    WHERE edge.from_id = ? AND edge.from_kind = 'knowledge' AND edge.to_kind = 'entity'
      AND edge.valid_from <= ? AND (edge.valid_to IS NULL OR edge.valid_to > ?)
      AND edge.recorded_at <= ? AND (edge.recorded_to IS NULL OR edge.recorded_to > ?)
  `).all(origin.project_id, knowledgeId, ...activeParams) as { entity_id: string }[];

  const incomingEdges = sqlite.prepare(`
    SELECT edge.from_id AS entity_id FROM knowledge_edges AS edge
    JOIN entities AS entity ON entity.id = edge.from_id AND entity.project_id IS ?
    WHERE edge.to_id = ? AND edge.to_kind = 'knowledge' AND edge.from_kind = 'entity'
      AND edge.valid_from <= ? AND (edge.valid_to IS NULL OR edge.valid_to > ?)
      AND edge.recorded_at <= ? AND (edge.recorded_to IS NULL OR edge.recorded_to > ?)
  `).all(origin.project_id, knowledgeId, ...activeParams) as { entity_id: string }[];

  const entityIds = [
    ...outgoingEdges.map(e => e.entity_id),
    ...incomingEdges.map(e => e.entity_id),
  ];

  if (entityIds.length === 0) return [];

  // For each entity, find other knowledge records connected to it
  const knowledgeIds = new Set<string>();
  const placeholders = entityIds.map(() => '?').join(',');

  // Knowledge → Entity edges (knowledge is the source)
  const fromKnowledge = sqlite.prepare(`
    SELECT DISTINCT edge.from_id AS knowledge_id FROM knowledge_edges AS edge
    JOIN knowledge AS source ON source.id = edge.from_id AND source.project_id IS ?
    WHERE edge.to_id IN (${placeholders}) AND edge.to_kind = 'entity' AND edge.from_kind = 'knowledge'
      AND edge.valid_from <= ? AND (edge.valid_to IS NULL OR edge.valid_to > ?)
      AND edge.recorded_at <= ? AND (edge.recorded_to IS NULL OR edge.recorded_to > ?)
  `).all(origin.project_id, ...entityIds, ...activeParams) as { knowledge_id: string }[];

  // Entity → Knowledge edges (knowledge is the target)
  const toKnowledgeRows = sqlite.prepare(`
    SELECT DISTINCT edge.to_id AS knowledge_id FROM knowledge_edges AS edge
    JOIN knowledge AS target ON target.id = edge.to_id AND target.project_id IS ?
    WHERE edge.from_id IN (${placeholders}) AND edge.from_kind = 'entity' AND edge.to_kind = 'knowledge'
      AND edge.valid_from <= ? AND (edge.valid_to IS NULL OR edge.valid_to > ?)
      AND edge.recorded_at <= ? AND (edge.recorded_to IS NULL OR edge.recorded_to > ?)
  `).all(origin.project_id, ...entityIds, ...activeParams) as { knowledge_id: string }[];

  for (const row of fromKnowledge) {
    if (row.knowledge_id !== knowledgeId) knowledgeIds.add(row.knowledge_id);
  }
  for (const row of toKnowledgeRows) {
    if (row.knowledge_id !== knowledgeId) knowledgeIds.add(row.knowledge_id);
  }

  if (knowledgeIds.size === 0) return [];

  // Fetch the connected knowledge records
  const ids = Array.from(knowledgeIds);
  const fetchPlaceholders = ids.map(() => '?').join(',');
  const rows = sqlite.prepare(`
    SELECT * FROM knowledge
    WHERE id IN (${fetchPlaceholders}) AND project_id IS ? AND is_active = 1
    ORDER BY updated_at DESC
    LIMIT 50
  `).all(...ids, origin.project_id);

  return rows.map(toKnowledge);
}

/**
 * Get connected places for a knowledge record.
 *
 * Finds place IDs linked to this knowledge via knowledge_edges, then returns
 * other knowledge records that share those same places — either via edges
 * or via the knowledge table's place_id / primary_place columns.
 */
export async function getConnectedPlaces(knowledgeId: string): Promise<Knowledge[]> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(`connected_places:${knowledgeId}`, 'knowledge_edge', 'Unscoped connected-place reads are disabled under strict trust');
  }
  await ensureKnowledgeTables();
  const client = await getDbClient();
  const { raw } = client;
  if ((client.db as { $clientType?: string }).$clientType === 'postgres') {
    const edges = client.schema.knowledgeEdges;
    const [origin] = await client.db.select({ projectId: client.schema.knowledge.projectId })
      .from(client.schema.knowledge).where(eq(client.schema.knowledge.id, knowledgeId)).limit(1);
    if (!origin) return [];
    const asOf = { validAt: new Date(), recordedAt: new Date() };
    const active = postgresEdgeAsOfConditions(client.schema, asOf);
    const outgoing = await client.db.select({ placeId: edges.toId }).from(edges).where(and(
      eq(edges.fromId, knowledgeId), eq(edges.fromKind, 'knowledge'), eq(edges.toKind, 'place'), ...active,
    ));
    const incoming = await client.db.select({ placeId: edges.fromId }).from(edges).where(and(
      eq(edges.toId, knowledgeId), eq(edges.toKind, 'knowledge'), eq(edges.fromKind, 'place'), ...active,
    ));
    const placeIds = [...new Set([...outgoing, ...incoming].map((row) => row.placeId))];
    if (placeIds.length === 0) return [];

    const relatedEdges = client.schema.knowledgeEdges;
    const [fromKnowledge, toKnowledgeEdges, columnMatches] = await Promise.all([
      client.db.select({ knowledgeId: relatedEdges.fromId }).from(relatedEdges)
        .innerJoin(client.schema.knowledge, eq(client.schema.knowledge.id, relatedEdges.fromId)).where(and(
        inArray(relatedEdges.toId, placeIds), eq(relatedEdges.toKind, 'place'), eq(relatedEdges.fromKind, 'knowledge'),
        postgresProjectCondition(client.schema.knowledge.projectId, origin.projectId),
        ...postgresEdgeAsOfConditions(client.schema, asOf),
      )),
      client.db.select({ knowledgeId: relatedEdges.toId }).from(relatedEdges)
        .innerJoin(client.schema.knowledge, eq(client.schema.knowledge.id, relatedEdges.toId)).where(and(
        inArray(relatedEdges.fromId, placeIds), eq(relatedEdges.fromKind, 'place'), eq(relatedEdges.toKind, 'knowledge'),
        postgresProjectCondition(client.schema.knowledge.projectId, origin.projectId),
        ...postgresEdgeAsOfConditions(client.schema, asOf),
      )),
      client.db.select({ knowledgeId: client.schema.knowledge.id }).from(client.schema.knowledge).where(and(
        or(
          inArray(client.schema.knowledge.placeId, placeIds),
          inArray(client.schema.knowledge.primaryPlace, placeIds),
        ),
        eq(client.schema.knowledge.isActive, true),
        postgresProjectCondition(client.schema.knowledge.projectId, origin.projectId),
      )),
    ]);
    const knowledgeIds = [...new Set([...fromKnowledge, ...toKnowledgeEdges, ...columnMatches]
      .map((row) => row.knowledgeId).filter((id) => id !== knowledgeId))];
    if (knowledgeIds.length === 0) return [];
    const rows = await client.db.select().from(client.schema.knowledge).where(and(
      inArray(client.schema.knowledge.id, knowledgeIds), eq(client.schema.knowledge.isActive, true),
      postgresProjectCondition(client.schema.knowledge.projectId, origin.projectId),
    )).orderBy(desc(client.schema.knowledge.updatedAt), asc(client.schema.knowledge.id)).limit(50);
    return rows.map((row: Record<string, unknown>) => toKnowledge(row));
  }
  const sqlite = (raw as any).$client;
  if (!sqlite) return [];
  const origin = sqlite.prepare('SELECT project_id FROM knowledge WHERE id = ?').get(knowledgeId) as { project_id: string | null } | undefined;
  if (!origin) return [];
  const now = Date.now();
  const activeParams = [now, now, now, now];

  // Place-assignment edges commonly store the stable place_type in their
  // endpoint, while older callers may store the place row ID. Resolve both
  // forms to project-local place types before looking for peer memories.
  const outgoingEdges = sqlite.prepare(`
    SELECT DISTINCT place.place_type AS place_type FROM knowledge_edges AS edge
    JOIN places AS place ON (place.id = edge.to_id OR place.place_type = edge.to_id)
      AND place.project_id IS ?
    WHERE edge.from_id = ? AND edge.from_kind = 'knowledge' AND edge.to_kind = 'place'
      AND edge.valid_from <= ? AND (edge.valid_to IS NULL OR edge.valid_to > ?)
      AND edge.recorded_at <= ? AND (edge.recorded_to IS NULL OR edge.recorded_to > ?)
  `).all(origin.project_id, knowledgeId, ...activeParams) as { place_type: string }[];

  const incomingEdges = sqlite.prepare(`
    SELECT DISTINCT place.place_type AS place_type FROM knowledge_edges AS edge
    JOIN places AS place ON (place.id = edge.from_id OR place.place_type = edge.from_id)
      AND place.project_id IS ?
    WHERE edge.to_id = ? AND edge.to_kind = 'knowledge' AND edge.from_kind = 'place'
      AND edge.valid_from <= ? AND (edge.valid_to IS NULL OR edge.valid_to > ?)
      AND edge.recorded_at <= ? AND (edge.recorded_to IS NULL OR edge.recorded_to > ?)
  `).all(origin.project_id, knowledgeId, ...activeParams) as { place_type: string }[];

  const placeTypes = [...new Set([
    ...outgoingEdges.map((edge) => edge.place_type),
    ...incomingEdges.map((edge) => edge.place_type),
  ])];

  if (placeTypes.length === 0) return [];

  const placeTypePlaceholders = placeTypes.map(() => '?').join(',');
  const placeRows = sqlite.prepare(`SELECT id, place_type FROM places
    WHERE project_id IS ? AND place_type IN (${placeTypePlaceholders})`)
    .all(origin.project_id, ...placeTypes) as Array<{ id: string; place_type: string }>;
  const placeIds = [...new Set(placeRows.flatMap((place) => [place.id, place.place_type]))];

  const knowledgeIds = new Set<string>();
  const placeholders = placeIds.map(() => '?').join(',');

  // Knowledge → Place edges (knowledge is the source)
  const fromKnowledge = sqlite.prepare(`
    SELECT DISTINCT edge.from_id AS knowledge_id FROM knowledge_edges AS edge
    JOIN places AS place ON (place.id = edge.to_id OR place.place_type = edge.to_id)
      AND place.project_id IS ? AND place.place_type IN (${placeTypePlaceholders})
    JOIN knowledge AS source ON source.id = edge.from_id AND source.project_id IS ?
    WHERE edge.to_kind = 'place' AND edge.from_kind = 'knowledge'
      AND edge.valid_from <= ? AND (edge.valid_to IS NULL OR edge.valid_to > ?)
      AND edge.recorded_at <= ? AND (edge.recorded_to IS NULL OR edge.recorded_to > ?)
  `).all(origin.project_id, ...placeTypes, origin.project_id, ...activeParams) as { knowledge_id: string }[];

  // Place → Knowledge edges (knowledge is the target)
  const toKnowledgeRows = sqlite.prepare(`
    SELECT DISTINCT edge.to_id AS knowledge_id FROM knowledge_edges AS edge
    JOIN places AS place ON (place.id = edge.from_id OR place.place_type = edge.from_id)
      AND place.project_id IS ? AND place.place_type IN (${placeTypePlaceholders})
    JOIN knowledge AS target ON target.id = edge.to_id AND target.project_id IS ?
    WHERE edge.from_kind = 'place' AND edge.to_kind = 'knowledge'
      AND edge.valid_from <= ? AND (edge.valid_to IS NULL OR edge.valid_to > ?)
      AND edge.recorded_at <= ? AND (edge.recorded_to IS NULL OR edge.recorded_to > ?)
  `).all(origin.project_id, ...placeTypes, origin.project_id, ...activeParams) as { knowledge_id: string }[];

  // Also find knowledge records that reference these places via columns
  const columnMatches = sqlite.prepare(`
    SELECT id AS knowledge_id FROM knowledge
    WHERE (place_id IN (${placeholders}) OR primary_place IN (${placeholders}))
      AND project_id IS ?
      AND is_active = 1
  `).all(...placeIds, ...placeIds, origin.project_id) as { knowledge_id: string }[];

  for (const row of fromKnowledge) {
    if (row.knowledge_id !== knowledgeId) knowledgeIds.add(row.knowledge_id);
  }
  for (const row of toKnowledgeRows) {
    if (row.knowledge_id !== knowledgeId) knowledgeIds.add(row.knowledge_id);
  }
  for (const row of columnMatches) {
    if (row.knowledge_id !== knowledgeId) knowledgeIds.add(row.knowledge_id);
  }

  if (knowledgeIds.size === 0) return [];

  // Fetch the connected knowledge records
  const ids = Array.from(knowledgeIds);
  const fetchPlaceholders = ids.map(() => '?').join(',');
  const rows = sqlite.prepare(`
    SELECT * FROM knowledge
    WHERE id IN (${fetchPlaceholders}) AND project_id IS ? AND is_active = 1
    ORDER BY updated_at DESC
    LIMIT 50
  `).all(...ids, origin.project_id);

  return rows.map(toKnowledge);
}
