/**
 * Relationship Extractor
 *
 * Populates entity_relations table with typed relationships extracted
 * from memory content.
 */

import { eq, and, or } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';
import { config } from '../../config.js';
import {
  extractEntitiesAndRelations,
  type ExtractedRelation,
  type RelationType,
} from './llm-entity-extractor.js';
import type { ExtractedEntity } from '../memory/entity-extractor.js';

// Fallback relationship types for non-LLM extraction
const FALLBACK_RELATION_TYPES = {
  CO_OCCURS: 'co_occurs_with' as RelationType,
  SAME_SENTENCE: 'mentioned_together' as RelationType,
  SEQUENTIAL: 'mentioned_before' as RelationType,
};

/**
 * Generate fallback relationships from entity co-occurrence when LLM is unavailable.
 * Creates edges between entities that appear in the same memory or sentence.
 */
function generateCoOccurrenceRelations(
  entities: ExtractedEntity[],
  content: string
): ExtractedRelation[] {
  const relations: ExtractedRelation[] = [];

  if (entities.length < 2) return relations;

  // Split content into sentences
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);

  // For each pair of entities, determine relationship strength based on proximity
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const e1 = entities[i];
      const e2 = entities[j];

      // Skip if same entity
      if (e1.name.toLowerCase() === e2.name.toLowerCase()) continue;

      // Check if they appear in the same sentence
      const sameSentence = sentences.some(sentence => {
        return sentence.toLowerCase().includes(e1.name.toLowerCase()) &&
               sentence.toLowerCase().includes(e2.name.toLowerCase());
      });

      // Check if e1 appears before e2 in text
      const e1Index = content.toLowerCase().indexOf(e1.name.toLowerCase());
      const e2Index = content.toLowerCase().indexOf(e2.name.toLowerCase());
      const sequential = e1Index >= 0 && e2Index >= 0 && e1Index < e2Index;

      // Determine relation type and confidence
      let relationType: RelationType;
      let confidence: number;

      if (sameSentence) {
        relationType = FALLBACK_RELATION_TYPES.SAME_SENTENCE;
        confidence = 0.7;
      } else if (sequential) {
        relationType = FALLBACK_RELATION_TYPES.SEQUENTIAL;
        confidence = 0.5;
      } else {
        relationType = FALLBACK_RELATION_TYPES.CO_OCCURS;
        confidence = 0.3;
      }

      // Create bidirectional relationships
      relations.push({
        fromEntity: e1.name,
        toEntity: e2.name,
        relationType,
        confidence,
        context: `Co-occurrence in memory (${relationType})`,
      });

      relations.push({
        fromEntity: e2.name,
        toEntity: e1.name,
        relationType,
        confidence,
        context: `Co-occurrence in memory (${relationType})`,
      });
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
  // Step 1: Extract entities and relations from content
  const extraction = await extractEntitiesAndRelations(content, options);

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
  const storedRelations = await storeRelations(relationsToStore, entityIdMap);

  // Step 5: Link entities to the memory record
  await linkEntitiesToMemory(memoryId, extraction.entities, projectId);

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
 * Store extracted relations in the entity_relations table.
 * Deduplicates by from+to+type.
 */
async function storeRelations(
  relations: ExtractedRelation[],
  entityIdMap: Map<string, string>
): Promise<number> {
  const db = await getDb();
  const schema = await getSchema();
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
      // Check if relation already exists
      const existing = await (db as any)
        .select()
        .from(schema.entityRelations)
        .where(
          and(
            eq(schema.entityRelations.fromEntityId, fromId),
            eq(schema.entityRelations.toEntityId, toId),
            eq(schema.entityRelations.type, relation.relationType)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        // Strengthen existing relation
        await (db as any)
          .update(schema.entityRelations)
          .set({
            weight: Math.min(10, (existing[0].weight || 1) + 1),
            properties: {
              ...(existing[0].properties as Record<string, unknown> || {}),
              confidence: relation.confidence,
              context: relation.context,
              lastSeen: new Date().toISOString(),
            } as any,
          })
          .where(eq(schema.entityRelations.id, existing[0].id));
      } else {
        // Create new relation
        await (db as any).insert(schema.entityRelations).values({
          fromEntityId: fromId,
          toEntityId: toId,
          type: relation.relationType,
          weight: Math.round(relation.confidence * 10),
          properties: {
            confidence: relation.confidence,
            context: relation.context,
          } as any,
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
  entities: ExtractedEntity[],
  projectId: string
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
  const db = await getDb();
  const schema = await getSchema();

  const whereConditions = relationTypes
    ? and(
        or(...entityIds.map(id => eq(schema.entityRelations.fromEntityId, id))),
        or(...relationTypes.map(type => eq(schema.entityRelations.type, type)))
      )
    : or(...entityIds.map(id => eq(schema.entityRelations.fromEntityId, id)));

  const relations = await (db as any)
    .select()
    .from(schema.entityRelations)
    .where(whereConditions);

  // Also get incoming relations
  const incomingRelations = await (db as any)
    .select()
    .from(schema.entityRelations)
    .where(or(...entityIds.map(id => eq(schema.entityRelations.toEntityId, id))));

  // Combine and deduplicate
  const allRelations = [...relations, ...incomingRelations];
  const seen = new Set<string>();
  const unique: StoredRelation[] = [];

  for (const r of allRelations) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      unique.push({
        id: r.id,
        fromEntityId: r.fromEntityId,
        toEntityId: r.toEntityId,
        fromEntityName: '', // Will be populated by caller if needed
        toEntityName: '',
        relationType: r.type as RelationType,
        weight: r.weight || 1,
        properties: r.properties as Record<string, unknown> | null,
      });
    }
  }

  return unique;
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

  const entities = await (db as any)
    .select({
      id: schema.entities.id,
      name: schema.entities.name,
      type: schema.entities.type,
      description: schema.entities.description,
    })
    .from(schema.entities)
    .where(eq(schema.entities.projectId, projectId))
    .limit(limit);

  return entities;
}

/**
 * Delete all entities and relations for a project (for graph rebuild).
 */
export async function clearProjectGraph(projectId: string): Promise<void> {
  const db = await getDb();
  const schema = await getSchema();

  // Delete relations first (foreign key constraint)
  const projectEntities = await (db as any)
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(eq(schema.entities.projectId, projectId));

  const entityIds = projectEntities.map((e: any) => e.id);

  if (entityIds.length > 0) {
    // Delete relations involving these entities
    for (const entityId of entityIds) {
      await (db as any)
        .delete(schema.entityRelations)
        .where(
          or(
            eq(schema.entityRelations.fromEntityId, entityId),
            eq(schema.entityRelations.toEntityId, entityId)
          )
        );
    }
  }

  // Delete entities
  await (db as any)
    .delete(schema.entities)
    .where(eq(schema.entities.projectId, projectId));

  logger.info('Cleared project graph', { projectId, entityCount: entityIds.length });
}