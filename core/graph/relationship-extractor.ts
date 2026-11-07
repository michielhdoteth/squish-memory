/**
 * Relationship Extractor
 *
 * Populates the canonical entity graph with typed relationships extracted
 * from memory content.
 */

import { eq, and, gt, isNull, lte, or } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { getRawClient } from '../../db/utils.js';
import { logger } from '../logger.js';
import { config } from '../../config.js';
import { signGraphRelationProvenance } from '../acl/provenance.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyUnscopedGraphOperation } from './strict-gates.js';
import { filterStrictEntityEdges } from './strict-access.js';
import { deserializeJson } from '../knowledge/helpers.js';
import {
  extractEntitiesAndRelations,
  type LLMExtractionResult,
  type ExtractedRelation,
  type RelationType,
} from './llm-entity-extractor.js';
import type { ExtractedEntity } from '../memory/entity-extractor.js';
import { createKnowledgeEdge, getEdgesFrom, getEdgesTo, getEdgesForNode, reviseKnowledgeEdge } from '../knowledge/knowledge-edges.js';
import type { KnowledgeEdge, KnowledgeEdgeType } from '../knowledge/types.js';

// Fallback relationship types for non-LLM extraction
const FALLBACK_RELATION_TYPES = {
  CO_OCCURS: 'co_occurs_with' as RelationType,
  SAME_SENTENCE: 'mentioned_together' as RelationType,
  SEQUENTIAL: 'mentioned_before' as RelationType,
};

function findEntityMentions(content: string, name: string): Array<{ start: number; end: number }> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
  return Array.from(content.matchAll(pattern), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

/**
 * Generate fallback relationships from entity co-occurrence when LLM is unavailable.
 * Creates edges between entities that appear in the same memory or sentence.
 */
export function generateCoOccurrenceRelations(
  entities: ExtractedEntity[],
  content: string
): ExtractedRelation[] {
  const relations: ExtractedRelation[] = [];

  if (entities.length < 2) return relations;

  // For each pair of entities, determine relationship strength based on proximity
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const e1 = entities[i];
      const e2 = entities[j];

      // Skip if same entity
      if (e1.name.toLowerCase() === e2.name.toLowerCase()) continue;

      const e1Mentions = findEntityMentions(content, e1.name);
      const e2Mentions = findEntityMentions(content, e2.name);
      // A short entity name inside a longer entity mention is not independent
      // evidence that the two entities co-occurred.
      const independentPairs = e1Mentions.flatMap((first) => e2Mentions
        .filter((second) => first.end <= second.start || second.end <= first.start)
        .map((second) => ({ first, second })));
      if (independentPairs.length === 0) continue;

      const sameSentence = independentPairs.some(({ first, second }) => {
        const start = Math.min(first.start, second.start);
        const end = Math.max(first.end, second.end);
        return !/[.!?]/.test(content.slice(start, end));
      });

      // Use the earliest independent pair so nested names cannot reverse the
      // direction of a later, real mention.
      independentPairs.sort((left, right) =>
        Math.min(left.first.start, left.second.start) - Math.min(right.first.start, right.second.start)
        || Math.max(left.first.start, left.second.start) - Math.max(right.first.start, right.second.start));
      const { first: firstMention, second: secondMention } = independentPairs[0]!;
      const sequential = firstMention.start < secondMention.start;

      // Co-occurrence is symmetric, but mention order is directional. Do not
      // manufacture a reverse `mentioned_before` edge for the same pair.
      if (sameSentence) {
        relations.push(
          {
            fromEntity: e1.name,
            toEntity: e2.name,
            relationType: FALLBACK_RELATION_TYPES.SAME_SENTENCE,
            confidence: 0.7,
            context: `Co-occurrence in memory (${FALLBACK_RELATION_TYPES.SAME_SENTENCE})`,
          },
          {
            fromEntity: e2.name,
            toEntity: e1.name,
            relationType: FALLBACK_RELATION_TYPES.SAME_SENTENCE,
            confidence: 0.7,
            context: `Co-occurrence in memory (${FALLBACK_RELATION_TYPES.SAME_SENTENCE})`,
          },
        );
      } else if (sequential) {
        relations.push({
          fromEntity: e1.name,
          toEntity: e2.name,
          relationType: FALLBACK_RELATION_TYPES.SEQUENTIAL,
          confidence: 0.5,
          context: `Co-occurrence in memory (${FALLBACK_RELATION_TYPES.SEQUENTIAL})`,
        });
      } else {
        // Not sequential: the earliest independent pair mentions the second
        // entity first, so the ordered edge points back at e1. (The old third
        // `else if (!sequential)` plus a trailing `else` made this the only
        // reachable branch; the CO_OCCURS block after it was dead.)
        relations.push({
          fromEntity: e2.name,
          toEntity: e1.name,
          relationType: FALLBACK_RELATION_TYPES.SEQUENTIAL,
          confidence: 0.5,
          context: `Co-occurrence in memory (${FALLBACK_RELATION_TYPES.SEQUENTIAL})`,
        });
      }
    }
  }

  return relations;
}

export interface StoredRelation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  fromEntityName: string;
  toEntityName: string;
  relationType: RelationType;
  weight: number;
  properties: Record<string, unknown> | null;
}

/**
 * Extract entities and relations from memory content and store them in the database.
 * Returns the stored entities and relations.
 */
export async function extractAndStoreRelations(
  memoryId: string,
  content: string,
  projectId: string,
  options?: {
    preferLLM?: boolean;
    maxContentLength?: number;
  }
): Promise<{
  entities: number;
  relations: number;
  source: 'llm' | 'regex' | 'fallback';
}> {
  if (isStrictTrustPolicy()) await denyUnscopedGraphOperation('extract_and_store_relations', memoryId);
  const extraction = await extractEntitiesAndRelations(content, options);
  return storeExtractedRelations(memoryId, content, projectId, extraction);
}

/** Persist a previously extracted memory graph result. */
export async function storeExtractedRelations(
  memoryId: string,
  content: string,
  projectId: string,
  extraction: LLMExtractionResult
): Promise<{
  entities: number;
  relations: number;
  source: 'llm' | 'regex' | 'fallback';
}> {
  if (isStrictTrustPolicy()) await denyUnscopedGraphOperation('store_extracted_relations', memoryId);

  if (extraction.entities.length === 0 && extraction.relations.length === 0) {
    return { entities: 0, relations: 0, source: extraction.source === 'none' ? 'fallback' : extraction.source };
  }

  // Step 2: Store entities and get their IDs
  const entityIdMap = await storeEntities(extraction.entities, projectId);

  // Step 3: Generate fallback relationships if LLM didn't produce any
  let relationsToStore = extraction.relations;
  if (relationsToStore.length === 0 && extraction.entities.length >= 2) {
    logger.debug('No relations extracted, generating co-occurrence fallback', {
      entityCount: extraction.entities.length,
    });
    const fallbackRelations = generateCoOccurrenceRelations(extraction.entities, content);
    relationsToStore = fallbackRelations;
  }

  // Step 4: Store relations between entities
  const storedRelations = await storeEntityRelations(relationsToStore, entityIdMap, memoryId);

  // Step 5: Link entities to the memory record
  await linkEntitiesToMemory(memoryId, extraction.entities);

  logger.info('Extracted and stored entities/relations', {
    memoryId,
    entityCount: entityIdMap.size,
    relationCount: storedRelations,
    source: extraction.source,
  });

  return {
    entities: entityIdMap.size,
    relations: storedRelations,
    source: extraction.source === 'none' ? 'fallback' : extraction.source,
  };
}

/**
 * Store extracted entities in the database, returning a map of entity name -> ID.
 * Deduplicates by name+type within the project.
 */
async function storeEntities(
  entities: ExtractedEntity[],
  projectId: string
): Promise<Map<string, string>> {
  const db = await getDb();
  const schema = await getSchema();
  const entityIdMap = new Map<string, string>();

  for (const entity of entities) {
    try {
      // Check if entity already exists (by name + type + project)
      const existing = await (db as any)
        .select()
        .from(schema.entities)
        .where(
          and(
            eq(schema.entities.projectId, projectId),
            eq(schema.entities.name, entity.name),
            eq(schema.entities.type, entity.type)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        // Update mention count and last_mentioned_at
        await (db as any)
          .update(schema.entities)
          .set({
            mentionCount: (existing[0].mentionCount || 0) + 1,
            lastMentionedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.entities.id, existing[0].id));

        entityIdMap.set(entity.name, existing[0].id);
      } else {
        // Create new entity
        const newEntity = {
          name: entity.name,
          type: entity.type,
          projectId,
          description: entity.context || null,
          properties: config.mode === 'team'
            ? {
                confidence: entity.confidence,
                normalized: entity.normalized,
              } as any
            : JSON.stringify({
                confidence: entity.confidence,
                normalized: entity.normalized,
              }),
        };

        const inserted = await (db as any)
          .insert(schema.entities)
          .values(newEntity)
          .returning();

        entityIdMap.set(entity.name, inserted[0].id);
      }
    } catch (error) {
      logger.debug('Error storing entity', { entity: entity.name, error: error as Error });
      // Continue with other entities
    }
  }

  return entityIdMap;
}

/**
 * Store extracted relations in canonical temporal edges only. Deduplicate by
 * direction and relation type; legacy rows are imported by the migration.
 */
export async function storeEntityRelations(
  relations: ExtractedRelation[],
  entityIdMap: Map<string, string>,
  sourceMemoryId?: string,
): Promise<number> {
  let storedCount = 0;

  for (const relation of relations) {
    const fromId = entityIdMap.get(relation.fromEntity);
    const toId = entityIdMap.get(relation.toEntity);

    // Skip relations where we can't resolve both entities
    if (!fromId || !toId) {
      // Try to find entities by name even if not in our extraction
      continue;
    }

    try {
      const currentEdges = await getEdgesFrom(fromId, 'entity', relation.relationType);
      const currentEdge = currentEdges.find(edge => edge.toKind === 'entity' && edge.toId === toId);
      const previousMetadata = currentEdge?.metadata ?? {};
      const nextMetadata = {
        ...previousMetadata,
        ...(sourceMemoryId ? {
          sourceMemoryIds: [...new Set([
            ...(Array.isArray(previousMetadata.sourceMemoryIds)
              ? previousMetadata.sourceMemoryIds.filter((id): id is string => typeof id === 'string')
              : []),
            sourceMemoryId,
          ])],
        } : {}),
        confidence: relation.confidence,
        context: relation.context,
        ...(currentEdge ? { lastSeen: new Date().toISOString() } : {}),
      };
      if (currentEdge) {
        await reviseKnowledgeEdge(currentEdge.id, {
          weight: Math.min(10, (currentEdge.weight || 1) + 1),
          metadata: nextMetadata,
        });
      } else {
        await createKnowledgeEdge({
          fromId, fromKind: 'entity', toId, toKind: 'entity',
          edgeType: relation.relationType as KnowledgeEdgeType,
          weight: Math.round(relation.confidence * 10),
          metadata: nextMetadata,
        });
      }

      storedCount++;
    } catch (error) {
      logger.debug('Error storing relation', {
        from: relation.fromEntity,
        to: relation.toEntity,
        error: error as Error,
      });
    }
  }

  return storedCount;
}

/**
 * Link extracted entities to a memory record.
 * Updates the memory's metadata with entity references.
 */
async function linkEntitiesToMemory(
  memoryId: string,
  entities: ExtractedEntity[]
): Promise<void> {
  const db = await getDb();
  const schema = await getSchema();

  try {
    // Get current memory metadata
    const memories = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .limit(1);

    if (memories.length === 0) return;

    const memory = memories[0];
    const existingMetadata = (memory.metadata as Record<string, unknown>) || {};

    // Add entity names to metadata
    const entityNames = entities.map(e => e.name);
    const existingEntities = Array.isArray(existingMetadata.entities) ? existingMetadata.entities as string[] : [];
    const updatedMetadata = {
      ...existingMetadata,
      entities: [...new Set([...existingEntities, ...entityNames])],
    };

    await (db as any)
      .update(schema.memories)
      .set({ metadata: updatedMetadata as any })
      .where(eq(schema.memories.id, memoryId));
  } catch (error) {
    logger.debug('Error linking entities to memory', { memoryId, error: error as Error });
  }
}

/**
 * Get all relations for a set of entity IDs.
 * Used by graph traversal to find connected entities.
 */
export async function getEntityRelations(
  entityIds: string[],
  relationTypes?: RelationType[]
): Promise<StoredRelation[]> {
  if (entityIds.length === 0) return [];
  const allowed = relationTypes ? new Set<string>(relationTypes) : null;
  const edges = (await Promise.all(entityIds.flatMap(id => [
    getEdgesFrom(id, 'entity'), getEdgesTo(id, 'entity'),
  ]))).flat();
  const visibleEdges = isStrictTrustPolicy() ? await filterStrictEntityEdges(edges) : edges;
  const byRelation = new Map<string, StoredRelation>();
  for (const edge of visibleEdges) {
    if (edge.fromKind !== 'entity' || edge.toKind !== 'entity' || (allowed && !allowed.has(edge.edgeType))) continue;
    const key = `${edge.fromId}\u0000${edge.toId}\u0000${edge.edgeType}`;
    byRelation.set(key, {
      id: edge.id, fromEntityId: edge.fromId, toEntityId: edge.toId,
      fromEntityName: '', toEntityName: '', relationType: edge.edgeType as RelationType,
      weight: edge.weight || 1, properties: edge.metadata,
    });
  }
  return [...byRelation.values()];
}

/**
 * Get all entities for a project.
 */
export async function getProjectEntities(
  projectId: string,
  limit: number = 100
): Promise<Array<{ id: string; name: string; type: string; description: string | null }>> {
  const db = await getDb();
  const schema = await getSchema();

  const entityQuery = (db as any)
    .select({
      id: schema.entities.id,
      name: schema.entities.name,
      type: schema.entities.type,
      description: schema.entities.description,
    })
    .from(schema.entities)
    .where(eq(schema.entities.projectId, projectId));
  const entities = isStrictTrustPolicy() ? await entityQuery : await entityQuery.limit(limit);

  if (isStrictTrustPolicy()) {
    const now = new Date();
    const edgeRows = await db.select().from(schema.knowledgeEdges).where(and(
      eq(schema.knowledgeEdges.fromKind, 'entity'),
      eq(schema.knowledgeEdges.toKind, 'entity'),
      lte(schema.knowledgeEdges.validFrom, now),
      or(isNull(schema.knowledgeEdges.validTo), gt(schema.knowledgeEdges.validTo, now)),
      lte(schema.knowledgeEdges.recordedAt, now),
      or(isNull(schema.knowledgeEdges.recordedTo), gt(schema.knowledgeEdges.recordedTo, now)),
    )) as Array<Omit<KnowledgeEdge, 'metadata'> & { metadata: unknown }>;
    const normalizedEdges = edgeRows.map((edge) => ({
      ...edge,
      metadata: typeof edge.metadata === 'string'
        ? deserializeJson<Record<string, unknown>>(edge.metadata)
        : edge.metadata && typeof edge.metadata === 'object' && !Array.isArray(edge.metadata)
          ? edge.metadata as Record<string, unknown>
          : null,
    }));
    const visibleEdges = await filterStrictEntityEdges(normalizedEdges);
    const visibleIds = new Set(visibleEdges.flatMap((edge) => [edge.fromId, edge.toId]));
    return entities.filter((entity: { id: string }) => visibleIds.has(entity.id)).slice(0, limit).map((entity: {
      id: string; name: string;
    }) => ({ id: entity.id, name: entity.name, type: 'entity', description: null }));
  }

  return entities;
}

/**
 * Delete all entities and relations for a project (for graph rebuild).
 */
export async function clearProjectGraph(projectId: string): Promise<void> {
  if (isStrictTrustPolicy()) await denyUnscopedGraphOperation('clear_project_graph', projectId);
  const db = await getDb();
  const schema = await getSchema();

  // Delete relations first (foreign key constraint)
  const projectEntities = await (db as any)
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(eq(schema.entities.projectId, projectId));

  const entityIds = projectEntities.map((e: any) => e.id);

  if (entityIds.length > 0) {
    const edgeIds = new Set<string>();
    for (const entityId of entityIds) {
      for (const edge of await getEdgesForNode(entityId, 'entity')) edgeIds.add(edge.id);
    }
    const closedAt = new Date();
    for (const edgeId of edgeIds) {
      await reviseKnowledgeEdge(edgeId, { validTo: closedAt, recordedAt: closedAt });
    }
    const raw = getRawClient(db);
    const legacyTable = raw?.prepare?.("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entity_relations'").get();
    if (legacyTable && raw?.prepare) {
      for (let offset = 0; offset < entityIds.length; offset += 400) {
        const batch = entityIds.slice(offset, offset + 400);
        const placeholders = batch.map(() => '?').join(', ');
        raw.prepare(`DELETE FROM entity_relations WHERE from_entity_id IN (${placeholders}) OR to_entity_id IN (${placeholders})`)
          .run(...batch, ...batch);
      }
    }
  }

  // Delete entities
  await (db as any)
    .delete(schema.entities)
    .where(eq(schema.entities.projectId, projectId));

  logger.info('Cleared project graph', { projectId, entityCount: entityIds.length });
}
