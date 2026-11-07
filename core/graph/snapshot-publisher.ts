import { randomUUID } from 'node:crypto';
import { sqlLifecycleBound } from '../lib/timestamps.js';
import type { Database } from 'better-sqlite3';
import type { ExtractedEntity } from '../memory/entity-extractor.js';
import type { ExtractedRelation, LLMExtractionResult } from './llm-entity-extractor.js';
import { generateCoOccurrenceRelations } from './relationship-extractor.js';
import { signGraphRelationProvenance } from '../acl/provenance.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyUnscopedGraphOperation } from './strict-gates.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
}

interface SqliteConnection {
  prepare(sql: string): SqliteStatement;
  transaction<T>(callback: () => T): (() => T) & { immediate: () => T };
}

interface MemoryInput {
  id: string;
  content: string;
  metadata?: unknown;
}

interface EntityRow {
  id: string;
  from_id: string;
  from_kind: string;
  to_id: string;
  to_kind: string;
  edge_type: string;
  weight: number;
  metadata: string | null;
  created_at: number;
  valid_from: number;
  valid_to: number | null;
  recorded_at: number;
  recorded_to: number | null;
}

export interface GraphSnapshotStats {
  entitiesCreated: number;
  relationsCreated: number;
}

const ENTITY_ID_BATCH_SIZE = 400;

function assertAcyclicSupersessionRelations(
  relations: Iterable<{ relation: ExtractedRelation }>,
): void {
  const outgoing = new Map<string, string[]>();
  for (const { relation } of relations) {
    if (relation.relationType !== 'supersedes_version') continue;
    if (relation.fromEntity === relation.toEntity) {
      throw new Error('Graph snapshot supersession relations would create a cycle');
    }
    const targets = outgoing.get(relation.fromEntity) ?? [];
    targets.push(relation.toEntity);
    outgoing.set(relation.fromEntity, targets);
  }

  const indegree = new Map<string, number>();
  for (const [entity, targets] of outgoing) {
    if (!indegree.has(entity)) indegree.set(entity, 0);
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }
  const pending = [...indegree].filter(([, degree]) => degree === 0).map(([entity]) => entity);
  let visited = 0;
  for (let index = 0; index < pending.length; index++) {
    const entity = pending[index]!;
    visited++;
    for (const target of outgoing.get(entity) ?? []) {
      const degree = indegree.get(target)! - 1;
      indegree.set(target, degree);
      if (degree === 0) pending.push(target);
    }
  }
  if (visited !== indegree.size) throw new Error('Graph snapshot supersession relations would create a cycle');
}

/** Replace a project's active entity graph as one recoverable SQLite commit. */
export async function publishProjectGraphSnapshot(
  sqlite: Database | SqliteConnection,
  projectId: string,
  memories: MemoryInput[],
  extractions: LLMExtractionResult[],
): Promise<GraphSnapshotStats> {
  if (isStrictTrustPolicy()) await denyUnscopedGraphOperation('publish_project_graph_snapshot', projectId);
  if (memories.length !== extractions.length) {
    throw new Error('Graph snapshot requires one extraction result per memory');
  }
  const connection = sqlite as unknown as SqliteConnection;
  if (typeof connection.prepare !== 'function' || typeof connection.transaction !== 'function') {
    throw new Error('Atomic graph snapshot publication requires a native SQLite connection; existing graph was preserved');
  }
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);

  const publish = connection.transaction(() => {
    // Extraction can take long enough for a source to be archived, expired, or
    // superseded after the rebuild's initial scan. Recheck in the same immediate
    // transaction that replaces the graph so a stale extraction cannot publish.
    const eligibleSources = new Set((connection.prepare(`
      SELECT id FROM memories
      WHERE project_id = ? AND status = 'active' AND is_active = 1
        AND ${sqlLifecycleBound('valid_from', '<=')}
        AND ${sqlLifecycleBound('valid_to', '>')}
        AND ${sqlLifecycleBound('expires_at', '>')}
    `).all(projectId, nowSeconds, nowSeconds, nowSeconds) as Array<{ id: string }>).map((row) => row.id));
    const eligibleMemories: MemoryInput[] = [];
    const eligibleExtractions: LLMExtractionResult[] = [];
    for (let index = 0; index < memories.length; index++) {
      const memory = memories[index]!;
      if (!eligibleSources.has(memory.id)) continue;
      eligibleMemories.push(memory);
      eligibleExtractions.push(extractions[index]!);
    }

    const priorEntities = connection.prepare('SELECT id FROM entities WHERE project_id = ?').all(projectId) as Array<{ id: string }>;
    const priorIds = priorEntities.map((entity) => entity.id);

    if (priorIds.length) {
      const edgesById = new Map<string, EntityRow>();
      for (let offset = 0; offset < priorIds.length; offset += ENTITY_ID_BATCH_SIZE) {
        const batch = priorIds.slice(offset, offset + ENTITY_ID_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        const edges = connection.prepare(`
          SELECT * FROM knowledge_edges
          WHERE ((from_kind = 'entity' AND from_id IN (${placeholders}))
            OR (to_kind = 'entity' AND to_id IN (${placeholders})))
            AND (valid_to IS NULL OR valid_to > ?)
            AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)
        `).all(...batch, ...batch, now, now, now) as EntityRow[];
        for (const edge of edges) edgesById.set(edge.id, edge);
      }
      const priorEdges = [...edgesById.values()];

      const close = connection.prepare('UPDATE knowledge_edges SET recorded_to = ? WHERE id = ? AND recorded_to IS NULL');
      const insertHistory = connection.prepare(`
        INSERT INTO knowledge_edges (
          id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata,
          created_at, valid_from, valid_to, recorded_at, recorded_to
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `);
      for (const edge of priorEdges) {
        const recordedAt = Math.max(now, edge.recorded_at + 1);
        const updated = close.run(recordedAt, edge.id);
        if (updated.changes !== 1) throw new Error(`Could not close prior graph edge ${edge.id}`);
        if (edge.valid_from < now) {
          insertHistory.run(
            randomUUID(), edge.from_id, edge.from_kind, edge.to_id, edge.to_kind, edge.edge_type,
            edge.weight, edge.metadata, recordedAt, edge.valid_from, now, recordedAt,
          );
        }
      }

      const legacyRelations = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entity_relations'",
      ).get();
      if (legacyRelations) {
        for (let offset = 0; offset < priorIds.length; offset += ENTITY_ID_BATCH_SIZE) {
          const batch = priorIds.slice(offset, offset + ENTITY_ID_BATCH_SIZE);
          const placeholders = batch.map(() => '?').join(', ');
          connection.prepare(`
            DELETE FROM entity_relations
            WHERE from_entity_id IN (${placeholders}) OR to_entity_id IN (${placeholders})
          `).run(...batch, ...batch);
        }
      }

      connection.prepare('DELETE FROM entities WHERE project_id = ?').run(projectId);
    }

    const entities = new Map<string, {
      entity: ExtractedEntity;
      mentions: number;
      lastMentionedAt: number;
    }>();
    for (const extraction of eligibleExtractions) {
      const seen = new Set<string>();
      for (const entity of extraction.entities) {
        const key = `${entity.name}\u0000${entity.type}`;
        const current = entities.get(key);
        if (current) {
          if (!seen.has(key)) current.mentions++;
          if (!current.entity.context && entity.context) current.entity = entity;
          current.lastMentionedAt = nowSeconds;
        } else {
          entities.set(key, { entity, mentions: 1, lastMentionedAt: nowSeconds });
        }
        seen.add(key);
      }
    }

    const entityIds = new Map<string, string>();
    const ambiguousEntityNames = new Set<string>();
    const insertEntity = connection.prepare(`
      INSERT INTO entities (id, project_id, name, type, description, properties, mention_count, last_mentioned_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const value of entities.values()) {
      const entity = value.entity;
      const id = randomUUID();
      if (entityIds.has(entity.name)) {
        // Relations address endpoints by name only. Do not guess which typed entity
        // an edge refers to when extraction produced the same name for multiple types.
        entityIds.delete(entity.name);
        ambiguousEntityNames.add(entity.name);
      } else if (!ambiguousEntityNames.has(entity.name)) {
        entityIds.set(entity.name, id);
      }
      insertEntity.run(
        id, projectId, entity.name, entity.type, entity.context || null,
        JSON.stringify({ confidence: entity.confidence, normalized: entity.normalized }),
        value.mentions, value.lastMentionedAt, nowSeconds, nowSeconds,
      );
    }

    const relationRows = new Map<string, {
      relation: ExtractedRelation;
      count: number;
      sourceMemoryIds: Set<string>;
    }>();
    for (const [index, extraction] of eligibleExtractions.entries()) {
      const memory = eligibleMemories[index]!;
      const relations = extraction.relations.length === 0 && extraction.entities.length >= 2
        ? generateCoOccurrenceRelations(extraction.entities, memory.content)
        : extraction.relations;
      for (const relation of relations) {
        if (!entityIds.has(relation.fromEntity) || !entityIds.has(relation.toEntity)) continue;
        const key = `${relation.fromEntity}\u0000${relation.toEntity}\u0000${relation.relationType}`;
        const current = relationRows.get(key);
        if (current) {
          current.count++;
          current.relation = relation;
          current.sourceMemoryIds.add(memory.id);
        } else {
          relationRows.set(key, { relation, count: 1, sourceMemoryIds: new Set([memory.id]) });
        }
      }
    }

    assertAcyclicSupersessionRelations(relationRows.values());

    const insertEdge = connection.prepare(`
      INSERT INTO knowledge_edges (
        id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata,
        created_at, valid_from, valid_to, recorded_at, recorded_to
      ) VALUES (?, ?, 'entity', ?, 'entity', ?, ?, ?, ?, ?, NULL, ?, NULL)
    `);
    for (const { relation, count, sourceMemoryIds } of relationRows.values()) {
      const fromId = entityIds.get(relation.fromEntity)!;
      const toId = entityIds.get(relation.toEntity)!;
      const weight = Math.min(10, Math.round(relation.confidence * 10) + count - 1);
      const metadata: Record<string, unknown> = {
        confidence: relation.confidence,
        context: relation.context,
        sourceMemoryIds: [...sourceMemoryIds].sort(),
      };
      const signature = signGraphRelationProvenance({
        fromId, fromKind: 'entity', toId, toKind: 'entity',
        edgeType: relation.relationType, weight, metadata,
      });
      if (signature) metadata.__squishGraphProvenance = signature;
      insertEdge.run(
        randomUUID(), fromId, toId,
        relation.relationType, weight, JSON.stringify(metadata),
        nowSeconds, now, now,
      );
    }

    const updateMemory = connection.prepare('UPDATE memories SET metadata = ? WHERE id = ?');
    for (const [index, extraction] of eligibleExtractions.entries()) {
      if (extraction.entities.length === 0) continue;
      const memory = eligibleMemories[index]!;
      let metadata: Record<string, unknown> = {};
      try {
        const parsed = typeof memory.metadata === 'string' ? JSON.parse(memory.metadata) : memory.metadata;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
      } catch {
        // Preserve malformed legacy metadata as an empty object, matching the prior writer.
      }
      const names = Array.isArray(metadata.entities) ? metadata.entities.filter((name): name is string => typeof name === 'string') : [];
      metadata.entities = [...new Set([...names, ...extraction.entities.map((entity) => entity.name)])];
      updateMemory.run(JSON.stringify(metadata), memory.id);
    }

    return { entitiesCreated: entities.size, relationsCreated: relationRows.size };
  });

  return publish.immediate();
}
