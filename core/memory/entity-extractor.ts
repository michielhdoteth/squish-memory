/**
 * Entity Extractor
 * Extracts named entities from memory content
 * Supports people, files, functions, dates, locations, concepts, tools, and patterns
 */

import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';
import { eq, and } from 'drizzle-orm';
import { logger } from '../logger.js';

export type EntityType =
  | 'person'
  | 'organization'
  | 'matter'
  | 'document'
  | 'document_version'
  | 'status'
  | 'file'
  | 'function'
  | 'class'
  | 'concept'
  | 'tool'
  | 'date'
  | 'location'
  | 'pattern'
  | 'technique'
  | 'other';

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  confidence: number; // 0-1
  startIndex: number;
  endIndex: number;
  context: string;
  normalized?: string;
}

function denyUnscopedEntityOperation(operation: string, resourceId: string): Promise<never> {
  if (!isStrictTrustPolicy()) {
    return Promise.reject(new Error('Entity operation guard called outside strict trust'));
  }
  return denyStrictSurface(resourceId, 'graph_operation', `Entity extractor ${operation} is disabled under strict trust until caller-scoped authorization is implemented`);
}

// Regex patterns for entity detection
const PATTERNS = {
  // File paths: src/components/Button.tsx
  filePath: /(?:^|[^\w])(?:\.?\/[\w.-]*[\w.-]*(?:\/[\w.-]+)*|[\w.-]+\.(?:ts|tsx|js|jsx|py|rb|go|java|cpp|c|h|json|yaml|yml|env|md|txt|csv|sql|graphql))\b/gm,

  // Functions/methods
  functionCall: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g,

  // Classes
  className: /\b(?:class|new|extends|implements)\s+([A-Z][a-zA-Z0-9_$]*)\b/g,

  // Common names
  personName: /(?:^|[^.\w])\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b(?![^.\w])/g,

  // Capitalized concepts
  concept: /\b(?:[A-Z][a-z]+\s+)+(?:System|Architecture|Pattern|Model|Algorithm|Framework|Library|Process|Concept|Method)\b/g,

  // Tools
  tool: /\b(?:React|Vue|Angular|Node\.?js?|Express|Django|Flask|FastAPI|PostgreSQL|MongoDB|Redis|Docker|Kubernetes)\b/g,

  // Design patterns
  designPattern: /\b(?:abstract\s+)?(?:factory|singleton|observer|decorator|strategy|adapter)\s+(?:pattern|method)\b/gi,

  // Techniques
  technique: /\b(?:memoization|caching|lazy\s+loading|debouncing|throttling)\b/gi,

  // ISO dates
  date: /\b(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2})?\b/g,

  // Quoted concepts (single or double quoted phrases)
  quotedConcept: /(?:['"])([^'"]{3,})(?:['"])/g,
};

/**
 * Extract unique entity names for auto-linking
 */
export function extractEntityNames(content: string): string[] {
  const names = new Set<string>();

  // Extract person names
  const namePattern = /(?:^|[^.\w])\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b(?![^.\w])/g;
  let match;
  while ((match = namePattern.exec(content)) !== null) {
    if (match[1]) names.add(match[1].toLowerCase());
  }

  // Extract capitalized concepts
  const conceptPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
  while ((match = conceptPattern.exec(content)) !== null) {
    names.add(match[0].toLowerCase());
  }

  return Array.from(names).slice(0, 10);
}

/**
 * Extract entities from content
 */
export async function extractEntities(content: string): Promise<ExtractedEntity[]> {
  const entities: ExtractedEntity[] = [];
  const seenKeys = new Set<string>(); // Deduplicate entities

  // Extract file paths
  const filePaths = Array.from(content.matchAll(PATTERNS.filePath));
  for (const match of filePaths) {
    const name = match[0].trim();
    const key = `file:${name}`;
    if (!seenKeys.has(key)) {
      entities.push({
        name,
        type: 'file',
        confidence: 0.9,
        startIndex: match.index || 0,
        endIndex: (match.index || 0) + match[0].length,
        context: extractContext(content, match.index || 0),
        normalized: normalizePath(name),
      });
      seenKeys.add(key);
    }
  }

  // Extract function calls
  const functionCalls = Array.from(content.matchAll(PATTERNS.functionCall));
  for (const match of functionCalls) {
    const name = match[1];
    if (!name) continue;
    const key = `function:${name}`;
    if (!seenKeys.has(key) && name.length > 2) {
      entities.push({
        name,
        type: 'function',
        confidence: 0.85,
        startIndex: match.index || 0,
        endIndex: (match.index || 0) + match[0].length,
        context: extractContext(content, match.index || 0),
      });
      seenKeys.add(key);
    }
  }

  // Extract class names
  const classNames = Array.from(content.matchAll(PATTERNS.className));
  for (const match of classNames) {
    const name = match[1];
    if (!name) continue;
    const key = `class:${name}`;
    if (!seenKeys.has(key)) {
      entities.push({
        name,
        type: 'class',
        confidence: 0.95,
        startIndex: match.index || 0,
        endIndex: (match.index || 0) + match[0].length,
        context: extractContext(content, match.index || 0),
      });
      seenKeys.add(key);
    }
  }

  // Extract technologies/tools
  const tools = Array.from(content.matchAll(PATTERNS.tool));
  for (const match of tools) {
    const name = match[0];
    const key = `tool:${name}`;
    if (!seenKeys.has(key)) {
      entities.push({
        name,
        type: 'tool',
        confidence: 0.9,
        startIndex: match.index || 0,
        endIndex: (match.index || 0) + match[0].length,
        context: extractContext(content, match.index || 0),
      });
      seenKeys.add(key);
    }
  }

  // Extract design patterns
  const patterns = Array.from(content.matchAll(PATTERNS.designPattern));
  for (const match of patterns) {
    const name = match[0];
    const key = `pattern:${name}`;
    if (!seenKeys.has(key)) {
      entities.push({
        name,
        type: 'pattern',
        confidence: 0.92,
        startIndex: match.index || 0,
        endIndex: (match.index || 0) + match[0].length,
        context: extractContext(content, match.index || 0),
      });
      seenKeys.add(key);
    }
  }

  // Extract techniques/methodologies
  const techniques = Array.from(content.matchAll(PATTERNS.technique));
  for (const match of techniques) {
    const name = match[0];
    const key = `technique:${name}`;
    if (!seenKeys.has(key)) {
      entities.push({
        name,
        type: 'technique',
        confidence: 0.88,
        startIndex: match.index || 0,
        endIndex: (match.index || 0) + match[0].length,
        context: extractContext(content, match.index || 0),
      });
      seenKeys.add(key);
    }
  }

  // Extract dates
  const dates = Array.from(content.matchAll(PATTERNS.date));
  for (const match of dates) {
    const name = match[0];
    const key = `date:${name}`;
    if (!seenKeys.has(key)) {
      entities.push({
        name,
        type: 'date',
        confidence: 0.95,
        startIndex: match.index || 0,
        endIndex: (match.index || 0) + match[0].length,
        context: extractContext(content, match.index || 0),
      });
      seenKeys.add(key);
    }
  }

  // Extract quoted important concepts
  const quotedConcepts = Array.from(content.matchAll(PATTERNS.quotedConcept));
  for (const match of quotedConcepts) {
    const name = match[1];
    if (!name) continue;
    const key = `concept:${name}`;
    if (!seenKeys.has(key) && name.length > 2) {
      entities.push({
        name,
        type: 'concept',
        confidence: 0.8,
        startIndex: match.index || 0,
        endIndex: (match.index || 0) + match[0].length,
        context: extractContext(content, match.index || 0),
      });
      seenKeys.add(key);
    }
  }

  // Extract capitalized concepts
  const concepts = Array.from(content.matchAll(PATTERNS.concept));
  for (const match of concepts) {
    const name = match[0];
    const key = `concept:${name}`;
    if (!seenKeys.has(key)) {
      entities.push({
        name,
        type: 'concept',
        confidence: 0.75,
        startIndex: match.index || 0,
        endIndex: (match.index || 0) + match[0].length,
        context: extractContext(content, match.index || 0),
      });
      seenKeys.add(key);
    }
  }

  // Sort by start index
  entities.sort((a, b) => a.startIndex - b.startIndex);

  logger.debug('Entities extracted', {
    count: entities.length,
    byType: countByType(entities),
  });

  return entities;
}

/**
 * Link extracted entities to memory records
 * Creates entity records in the knowledge graph
 */
export async function linkEntitiesToMemories(
  memoryId: string,
  entities: ExtractedEntity[]
): Promise<void> {
  if (isStrictTrustPolicy()) await denyUnscopedEntityOperation('linking', memoryId);
  if (entities.length === 0) return;

  try {
    const db = await getDb();
    const schema = await getSchema();

    // Get memory to find project
    const memories = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .limit(1);

    if (memories.length === 0) return;
    const memory = memories[0];

    // Insert unique entities into the knowledge graph
    for (const entity of entities) {
      try {
        // Check if entity already exists
        const existing = await (db as any)
          .select()
          .from(schema.entities)
          .where(
            and(
              eq(schema.entities.projectId, memory.projectId),
              eq(schema.entities.name, entity.name),
              eq(schema.entities.type, entity.type)
            )
          )
          .limit(1);

        if (existing.length === 0) {
          // Insert new entity with metadata in properties
          await (db as any).insert(schema.entities).values({
            name: entity.name,
            type: entity.type,
            projectId: memory.projectId,
            description: entity.context,
            properties: {
              confidence: entity.confidence,
              extractedFrom: memoryId,
              normalized: entity.normalized,
            },
          });
        }
      } catch (error) {
        logger.error('Error inserting entity', { entity, error });
      }
    }

    logger.debug('Entities linked to memory', {
      memoryId,
      entityCount: entities.length,
    });
  } catch (error) {
    logger.error('Error linking entities to memories', error);
  }
}

/**
 * Get entities extracted from a memory based on properties
 */
export async function getMemoryEntities(memoryId: string): Promise<ExtractedEntity[]> {
  if (isStrictTrustPolicy()) await denyUnscopedEntityOperation('memory lookup', memoryId);
  try {
    const db = await getDb();
    const schema = await getSchema();

    // Find all entities with this memory ID in properties
    const allEntities = await (db as any).select().from(schema.entities);

    const entities: ExtractedEntity[] = [];

    for (const entity of allEntities) {
      const props = entity.properties as Record<string, unknown>;
      if (props && props.extractedFrom === memoryId) {
        entities.push({
          name: entity.name,
          type: entity.type as EntityType,
          confidence: (props.confidence as number) || 0.8,
          startIndex: 0,
          endIndex: 0,
          context: entity.description || '',
          normalized: props.normalized as string | undefined,
        });
      }
    }

    return entities;
  } catch (error) {
    logger.error('Error getting memory entities', error);
    return [];
  }
}

/**
 * Get all entities for a project
 */
export async function getProjectEntities(
  projectId: string,
  type?: EntityType
): Promise<any[]> {
  if (isStrictTrustPolicy()) await denyUnscopedEntityOperation('project listing', projectId);
  try {
    const db = await getDb();
    const schema = await getSchema();

    let query: any = (db as any).select().from(schema.entities).where(eq(schema.entities.projectId, projectId));

    if (type) {
      query = query.where(eq(schema.entities.type, type));
    }

    return await query;
  } catch (error) {
    logger.error('Error getting project entities', error);
    return [];
  }
}

/**
 * Extract context around entity
 */
function extractContext(content: string, index: number, contextLength: number = 50): string {
  const start = Math.max(0, index - contextLength);
  const end = Math.min(content.length, index + contextLength);
  return content.substring(start, end).trim();
}

/**
 * Normalize file path
 */
function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^\.\//, '')
    .toLowerCase()
    .replace(/\\/g, '/');
}

/**
 * Count entities by type
 */
function countByType(entities: ExtractedEntity[]): Record<EntityType, number> {
  const counts = {} as Record<EntityType, number>;

  for (const entity of entities) {
    counts[entity.type] = (counts[entity.type] || 0) + 1;
  }

  return counts;
}
