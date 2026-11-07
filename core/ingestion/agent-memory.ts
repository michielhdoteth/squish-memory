/**
 * Agent-Aware Memory Management
 * Provides agent isolation and visibility rules
 */

import { and, eq, inArray, or } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { config } from '../../config.js';
import { getEmbedding, embeddingModelFor, activeEmbeddingModel } from '../embeddings.js';
import { logger } from '../logger.js';
import { annotateMemoryMetadata, buildMemoryPolicy, buildVisibilityScopes, serializeVisibilityScopes } from '../memory/policy.js';

export type VisibilityScope = 'private' | 'project';

export interface AgentContext {
  agentId: string;
  agentRole?: string;
  userId?: string;
  projectId?: string;
}

/**
 * Store a memory with agent context
 */
export async function storeAgentMemory(
  content: string,
  context: AgentContext,
  options: {
    type?: string;
    sector?: string;
    visibilityScope?: VisibilityScope;
    tags?: string[];
    metadata?: Record<string, unknown>;
  } = {}
): Promise<string> {
  if (!config.agentIsolationEnabled) {
    // Fall back to standard memory storage
    return await storeStandardMemory(content, options);
  }

  try {
    const db = await getDb();
    const schema = await getSchema();

    const memoryId = randomUUID();
    const embedding = await getEmbedding(content);
    const visibilityScope = options.visibilityScope || 'project';

    // Determine scopes based on visibility
    const scopes = buildVisibilityScopes(visibilityScope, 'agent', context.agentId);
    const serializedReadScope = serializeVisibilityScopes(scopes.readScope);
    const serializedWriteScope = serializeVisibilityScopes(scopes.writeScope);
    const memoryPolicy = buildMemoryPolicy({
      content,
      type: options.type as any,
      tags: options.tags,
      visibilityScope,
      importanceScore: 0,
      accessCount: 0,
      usageCount: 0,
      isPinned: false,
    });

    await (db as any).insert(schema.memories).values({
      id: memoryId,
      content,
      type: options.type || 'observation',
      sector: options.sector || 'episodic',
      agentId: context.agentId,
      agentRole: context.agentRole || 'general',
      userId: context.userId || null,
      projectId: context.projectId || null,
      visibilityScope,
      writeScope: serializedWriteScope,
      readScope: serializedReadScope,
      tags: options.tags || [],
      metadata: serializeMemoryMetadata(annotateMemoryMetadata(options.metadata || null, memoryPolicy)),
      embedding: embedding || null,
      embeddingModel: embeddingModelFor(embedding) ?? activeEmbeddingModel(),
      embeddingDim: embedding?.length ?? null,
      confidence: 100,
      relevanceScore: 50,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return memoryId;
  } catch (error) {
    logger.error('Error storing agent memory', error);
    throw error;
  }
}



function serializeMemoryMetadata(metadata: Record<string, unknown>): Record<string, unknown> | string {
  return JSON.stringify(metadata);
}

async function storeStandardMemory(
  content: string,
  options: {
    type?: string;
    sector?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  } = {}
): Promise<string> {
  // Fallback to standard memory storage if agent isolation is disabled
  const db = await getDb();
  const schema = await getSchema();
  const memoryId = randomUUID();
  const embedding = await getEmbedding(content);

  await (db as any).insert(schema.memories).values({
    id: memoryId,
    content,
    type: options.type || 'observation',
    sector: options.sector || 'episodic',
    tags: options.tags || [],
    metadata: options.metadata || null,
    embedding: embedding || null,
    embeddingModel: embeddingModelFor(embedding) ?? activeEmbeddingModel(),
    embeddingDim: embedding?.length ?? null,
    confidence: 100,
    relevanceScore: 50,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return memoryId;
}

async function searchStandardMemories(
  query: string,
  options: {
    limit?: number;
    type?: string;
  } = {}
): Promise<any[]> {
  // Fallback to standard memory search if agent isolation is disabled
  const db = await getDb();
  const schema = await getSchema();
  const limit = Math.min(options.limit || 10, 100);

  let where: any = undefined;
  if (options.type) {
    where = eq(schema.memories.type as any, options.type);
  }

  return await (db as any)
    .select()
    .from(schema.memories)
    .where(
      where
        ? and(where, (schema.memories.content as any).ilike(`%${query}%`))
        : (schema.memories.content as any).ilike(`%${query}%`)
    )
    .limit(limit);
}
