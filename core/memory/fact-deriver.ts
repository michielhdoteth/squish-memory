/**
 * Fact Deriver
 * 
 * Derives implicit facts from existing relationships in the knowledge graph.
 * Example: works_on(A, X) + uses(X, Y) -> depends_on(A, Y)
 */

import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';
import { createAssociation } from '../associations.js';
import type { RelationType } from '../graph/llm-entity-extractor.js';
import { getEntityRelations, getProjectEntities } from '../graph/relationship-extractor.js';
import { createKnowledgeEdge } from '../knowledge/knowledge-edges.js';
import type { KnowledgeEdgeType } from '../knowledge/types.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';

// Extend RelationType to include derived relation types
type ExtendedRelationType = RelationType | 'oversees' | 'may_affect';

// ─── Derivation Rules ─────────────────────────────────────────────────────────

interface DerivationRule {
  name: string;
  fromType: RelationType;
  toType: RelationType;
  derivedType: ExtendedRelationType;
  description: string;
  confidence: number;
  /** Memory association type to create when storing this derivation */
  memoryAssociationType: 'derives' | 'extends';
}

const DERIVATION_RULES: DerivationRule[] = [
  // Transitivity rules - use 'derives' for memory associations
  {
    name: 'works_on_uses_depends_on',
    fromType: 'works_on',
    toType: 'uses',
    derivedType: 'depends_on',
    description: 'If A works on X and X uses Y, then A depends on Y',
    confidence: 0.8,
    memoryAssociationType: 'derives',
  },
  {
    name: 'manages_works_oversees',
    fromType: 'manages',
    toType: 'works_on',
    derivedType: 'oversees',
    description: 'If A manages B and B works on X, then A oversees X',
    confidence: 0.75,
    memoryAssociationType: 'derives',
  },
  {
    name: 'caused_affects_may_affect',
    fromType: 'caused',
    toType: 'affects',
    derivedType: 'may_affect',
    description: 'If X caused Y and Y affects Z, then X may affect Z',
    confidence: 0.7,
    memoryAssociationType: 'derives',
  },
  // Enrichment rules - use 'extends' for memory associations
  {
    name: 'part_of_contains',
    fromType: 'part_of',
    toType: 'contains',
    derivedType: 'related_to',
    description: 'If A is part of X and X contains B, then A is related to B',
    confidence: 0.6,
    memoryAssociationType: 'extends',
  },
  {
    name: 'uses_depends_on',
    fromType: 'uses',
    toType: 'depends_on',
    derivedType: 'depends_on',
    description: 'If A uses X and X depends on Y, then A depends on Y',
    confidence: 0.85,
    memoryAssociationType: 'derives',
  },
  {
    name: 'created_resolved',
    fromType: 'created',
    toType: 'resolved',
    derivedType: 'related_to',
    description: 'If A created X and X was resolved by B, then A is related to B',
    confidence: 0.5,
    memoryAssociationType: 'extends',
  },
  {
    name: 'blocks_depends_on',
    fromType: 'blocks',
    toType: 'depends_on',
    derivedType: 'blocks',
    description: 'If X blocks A and A depends on Y, then X may block Y',
    confidence: 0.65,
    memoryAssociationType: 'derives',
  },
];

export interface DerivedFact {
  fromEntityId: string;
  fromEntityName: string;
  toEntityId: string;
  toEntityName: string;
  relationType: RelationType;
  rule: string;
  confidence: number;
  isDerived: boolean;
}

/**
 * Find memories that mention a specific entity name.
 * Returns memory IDs that could be source memories for associations.
 */
async function findMemoriesForEntity(
  entityName: string,
  projectId: string,
  limit: number = 3
): Promise<string[]> {
  try {
    const db = await getDb();
    const schema = await getSchema();

    const memories = await (db as any)
      .select({ id: schema.memories.id })
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.projectId, projectId),
          sql`LOWER(${schema.memories.content}) LIKE ${'%' + entityName.toLowerCase() + '%'}`
        )
      )
      .limit(limit);

    return memories.map((m: any) => m.id as string);
  } catch (error) {
    logger.debug('Error finding memories for entity', { entityName, error: error as Error });
    return [];
  }
}

// ─── Main Derivation Function ─────────────────────────────────────────────────

/**
 * Derive implicit facts from existing relationships in the knowledge graph.
 * Applies transitivity and causal rules to find new relationships.
 */
export async function deriveFacts(
  projectId: string,
  options?: {
    maxDerivations?: number;
    minConfidence?: number;
    storeResults?: boolean;
  }
): Promise<DerivedFact[]> {
  const strict = isStrictTrustPolicy();
  const { maxDerivations = 50, minConfidence = 0.6, storeResults = true } = options || {};
  const db = await getDb();
  const schema = await getSchema();

  // Get all entities for this project
  const entities = strict
    ? await getProjectEntities(projectId)
    : await (db as any)
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.projectId, projectId));

  if (entities.length < 2) return [];

  const entityMap = new Map<string, any>(entities.map((e: any) => [e.id as string, e] as [string, any]));
  const derivedFacts: DerivedFact[] = [];

  // Get all relations for this project's entities
  const entityIds = entities.map((e: any) => e.id);
  const allRelations = await getEntityRelations(entityIds);

  // Build adjacency list for fast lookup
  const outgoing = new Map<string, Array<{
    toEntityId: string;
    relationType: string;
    weight: number;
    edgeId: string;
    properties: Record<string, unknown> | null;
  }>>();

  for (const rel of allRelations) {
    if (!outgoing.has(rel.fromEntityId)) {
      outgoing.set(rel.fromEntityId, []);
    }
    outgoing.get(rel.fromEntityId)!.push({
      toEntityId: rel.toEntityId,
      relationType: rel.relationType,
      weight: rel.weight || 1,
      edgeId: rel.id,
      properties: rel.properties,
    });
  }

  // Apply derivation rules
  for (const rule of DERIVATION_RULES) {
    if (derivedFacts.length >= maxDerivations) break;
    if (rule.confidence < minConfidence) continue;

    // Find all pairs where fromType matches
    for (const [fromId, targets] of outgoing) {
      if (derivedFacts.length >= maxDerivations) break;

      for (const fromRel of targets) {
        if (fromRel.relationType !== rule.fromType) continue;
        const midId = fromRel.toEntityId;

        // Check if midId has outgoing toType relations
        const midTargets = outgoing.get(midId);
        if (!midTargets) continue;

        for (const toRel of midTargets) {
          if (toRel.relationType !== rule.toType) continue;
          const toId = toRel.toEntityId;
          if (strict && (fromRel.properties?.derived === true || toRel.properties?.derived === true)) continue;

          // Found a derivation: fromId --fromType--> midId --toType--> toId
          // Derive: fromId --derivedType--> toId
          const fromEntity = entityMap.get(fromId);
          const toEntity = entityMap.get(toId);

          if (!fromEntity || !toEntity) continue;

          // Check if this derived relation already exists
          const alreadyExists = allRelations.some(rel =>
            rel.fromEntityId === fromId && rel.toEntityId === toId && rel.relationType === rule.derivedType
          );
          if (alreadyExists) continue;

          const derivedFact: DerivedFact = {
            fromEntityId: fromId,
            fromEntityName: fromEntity.name,
            toEntityId: toId,
            toEntityName: toEntity.name,
            relationType: rule.derivedType as RelationType,
            rule: rule.name,
            confidence: rule.confidence,
            isDerived: true,
          };

          derivedFacts.push(derivedFact);

          // Store the derived fact if requested
          if (storeResults) {
            try {
              const metadata = {
                derived: true,
                rule: rule.name,
                confidence: rule.confidence,
                description: rule.description,
                ...(strict ? {
                  sourceMemoryIds: [...new Set([
                    ...(Array.isArray(fromRel.properties?.sourceMemoryIds) ? fromRel.properties.sourceMemoryIds as string[] : []),
                    ...(Array.isArray(toRel.properties?.sourceMemoryIds) ? toRel.properties.sourceMemoryIds as string[] : []),
                  ])].sort(),
                  derivationProof: {
                    version: 1,
                    rule: rule.name,
                    fromPremiseEdgeId: fromRel.edgeId,
                    toPremiseEdgeId: toRel.edgeId,
                    middleEntityId: midId,
                    fromRelationType: fromRel.relationType,
                    toRelationType: toRel.relationType,
                  },
                } : {}),
              };
              if (strict && (!Array.isArray(metadata.sourceMemoryIds) || metadata.sourceMemoryIds.length === 0)) continue;
              await createKnowledgeEdge({
                fromId, fromKind: 'entity', toId, toKind: 'entity',
                edgeType: rule.derivedType as KnowledgeEdgeType,
                weight: Math.round(rule.confidence * 10),
                metadata,
              });
              // Also create memory associations between source memories
              // Use 'derives' for transitive rules, 'extends' for enrichment rules
              if (!strict) {
                try {
                  const fromMemories = await findMemoriesForEntity(fromEntity.name, projectId, 2);
                  const toMemories = await findMemoriesForEntity(toEntity.name, projectId, 2);

                  // Create associations between source memories of derived entities
                  for (const fromMemId of fromMemories) {
                    for (const toMemId of toMemories) {
                      if (fromMemId !== toMemId) {
                        await createAssociation(
                          fromMemId,
                          toMemId,
                          rule.memoryAssociationType,
                          rule.confidence,
                          { tag: 'INFERRED', score: rule.confidence }
                        );
                      }
                    }
                  }
                } catch (assocError) {
                  logger.debug('Error creating memory association for derived fact', {
                    rule: rule.name,
                    from: fromEntity.name,
                    to: toEntity.name,
                    error: assocError as Error,
                  });
                }
              }
            } catch (error) {
              logger.debug('Error storing derived fact', {
                rule: rule.name,
                from: fromEntity.name,
                to: toEntity.name,
                error: error as Error,
              });
            }
          }
        }
      }
    }
  }

  logger.info('Fact derivation completed', {
    projectId,
    derivedCount: derivedFacts.length,
    rulesApplied: DERIVATION_RULES.length,
  });

  return derivedFacts;
}

/**
 * Get all derived facts for a project.
 */
export async function getDerivedFacts(projectId: string): Promise<DerivedFact[]> {
  const db = await getDb();
  const schema = await getSchema();

  // Get all entities for this project
  const entities = isStrictTrustPolicy()
    ? await getProjectEntities(projectId)
    : await (db as any)
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.projectId, projectId));

  const entityIds = entities.map((e: any) => e.id);
  if (entityIds.length === 0) return [];

  // Get all derived relations
  const derivedRelations: any[] = [];
  const relations = await getEntityRelations(entityIds);
  for (const rel of relations) {
      const props = rel.properties;
      if (props && props.derived === true) {
        const fromEntity = entities.find((e: any) => e.id === rel.fromEntityId);
        const toEntity = entities.find((e: any) => e.id === rel.toEntityId);

        derivedRelations.push({
          fromEntityId: rel.fromEntityId,
          fromEntityName: fromEntity?.name || 'Unknown',
          toEntityId: rel.toEntityId,
          toEntityName: toEntity?.name || 'Unknown',
          relationType: rel.relationType as RelationType,
          rule: (props.rule as string) || 'unknown',
          confidence: (props.confidence as number) || 0.5,
          isDerived: true,
        });
      }
  }

  return derivedRelations;
}
