/**
 * Entity Operations
 *
 * CRUD and lookup for graph entities via the storage layer.
 */

import { logger } from '../logger.js';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { findEntitiesByName } from '../graph/graph-traversal.js';
import { getEntityRelations, getProjectEntities } from '../graph/relationship-extractor.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import type { EntityRecord, EntityRelation } from './types.js';

/**
 * Find entities by name across the graph.
 */
export async function getEntities(
  name: string,
  projectId: string,
  options?: { limit?: number; fuzzy?: boolean }
): Promise<EntityRecord[]> {
  const nodes = await findEntitiesByName(name, projectId, options);
  return nodes.map(n => ({
    id: n.id,
    name: n.name,
    type: n.type,
    description: n.description,
    properties: n.properties,
  }));
}

/**
 * Get a single entity by name with its relations and mention count.
 */
export async function getEntity(
  entityName: string,
  projectId: string
): Promise<{
  entity: EntityRecord | null;
  relations: EntityRelation[];
  mentionCount: number;
}> {
  const nodes = await findEntitiesByName(entityName, projectId, { limit: 1, fuzzy: true });
  if (nodes.length === 0) {
    return { entity: null, relations: [], mentionCount: 0 };
  }

  const entityNode = nodes[0];
  const entity: EntityRecord = {
    id: entityNode.id,
    name: entityNode.name,
    type: entityNode.type,
    description: entityNode.description,
    properties: entityNode.properties,
  };

  const relations = await getEntityRelations([entityNode.id]);

  let mentionCount = 0;
  if (!isStrictTrustPolicy()) try {
    const db = await getDb();
    const schema = await getSchema();
    const entityRow = await (db as any)
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entityNode.id))
      .limit(1);
    if (entityRow.length > 0) {
      const props = entityRow[0].properties as Record<string, unknown> | null;
      if (props && typeof props.mentionCount === 'number') {
        mentionCount = props.mentionCount;
      }
    }
  } catch (err: unknown) {
    logger.debug('[EntityOps] Failed to get mentionCount', { error: err instanceof Error ? err.message : String(err) });
  }

  return { entity, relations, mentionCount };
}

/**
 * Get all relations for an entity by name.
 */
export async function getEntityRelationsByName(
  entityName: string,
  projectId: string
): Promise<EntityRelation[]> {
  const nodes = await findEntitiesByName(entityName, projectId, { limit: 1, fuzzy: true });
  if (nodes.length === 0) return [];
  return getEntityRelations([nodes[0].id]);
}

/**
 * Get all entities for a project.
 */
export async function getProjectEntityList(
  projectId: string,
  limit?: number
): Promise<EntityRecord[]> {
  const entities = await getProjectEntities(projectId, limit);
  return entities.map(e => ({
    id: e.id,
    name: e.name,
    type: e.type,
    description: e.description,
    properties: null,
  }));
}
