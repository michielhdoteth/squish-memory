/**
 * Learnings Module
 * Agent learnings: success, failure, fix, insight
 * With auto-linking to similar memories and learnings
 */

import { randomUUID } from 'crypto';
import { desc, eq, sql, and } from 'drizzle-orm';
import { config } from '../../config.js';
import { getEmbedding, activeEmbeddingModel } from '../embeddings.js';
import { getOrCreateProject, requireProject } from '../projects.js';
import { serializeMetadata, deserializeMetadata } from '../memory/serialization.js';
import { normalizeTimestamp, prepareEmbedding } from '../lib/utils.js';
import { logger } from '../logger.js';
import { getDbClient } from '../lib/db-client.js';
import { createAssociation } from '../associations.js';
import { search, type SearchResult } from '../memory/memories.js';
import { updateAgentPreference } from '../agent-preferences.js';
import { emit } from '../event-bus.js';
import { meetsSemanticThreshold } from '../scoring/three-field.js';

// Learning type: success, failure, fix, insight
export type LearningType = 'success' | 'failure' | 'fix' | 'insight';

export interface LearningInput {
  type: LearningType;
  content: string;
  context?: string;
  action?: string;
  target?: string;
  project?: string;
  memoryId?: string;  // Optional link to a memory
  autoLink?: boolean;  // Auto-link to similar memories/learnings (default: true)
}

export interface LearningRecord {
  id: string;
  projectId?: string | null;
  conversationId?: string | null;
  type: LearningType;
  action: string;
  target?: string | null;
  summary: string;
  details?: Record<string, unknown> | null;
  memoryId?: string | null;
  isImported?: boolean;
  createdAt?: string | null;
}

/**
 * Create a learning and optionally auto-link to similar memories/learnings
 */
export async function createLearning(input: LearningInput): Promise<LearningRecord> {
  const { db, schema } = await getDbClient();
  const project = await getOrCreateProject(input.project);
  const embedding = await getEmbedding(input.content);
  const id = randomUUID();

  const learningType = input.type;
  const autoLink = input.autoLink !== false; // default true

  // Build details with learning metadata
  const details = serializeMetadata({
    learningType: learningType,
    learningContent: input.content,
    learningContext: input.context,
  });

  // Batch 4: blob+stamp prepared, but the learnings table only persists the
  // JSON compat column today (no embedding_blob columns on that table yet).
  const { embeddingJson } = prepareEmbedding(embedding, { model: activeEmbeddingModel() });

  // Insert the learning
  await db.insert(schema.learnings).values({
    id,
    projectId: project?.id ?? null,
    type: learningType,
    action: input.action ?? input.content,
    summary: input.context || input.content,
    target: input.target ?? null,
    details,
    memoryId: input.memoryId ?? null,
    embeddingJson,
    createdAt: new Date(),
  });

  // If memoryId provided, create bidirectional link
  if (input.memoryId) {
    await createAssociation(
      input.memoryId,  // from memory
      id,             // to learning
      'relates_to',
      1
    );
  }

  // Auto-link to similar memories and learnings (if enabled)
  if (autoLink) {
    await autoLinkLearning(id, input.content, project?.id ?? null);
  }

  // Extract and store agent preferences from this learning
  await updateAgentPreference(project?.id ?? 'default', input.content, id);

  const record: LearningRecord = {
    id,
    projectId: project?.id ?? null,
    conversationId: null,
    type: learningType,
    action: input.action ?? input.content,
    target: input.target ?? null,
    summary: input.context || input.content,
    details: { learningType: learningType, learningContent: input.content, learningContext: input.context },
    memoryId: input.memoryId ?? null,
    createdAt: new Date().toISOString(),
  };

  emit({
    type: 'learning:stored',
    payload: {
      learningId: id,
      type: learningType,
      content: input.content,
    },
  });

  return record;
}

/**
 * Auto-link a learning to similar memories above threshold
 */
async function autoLinkLearning(learningId: string, content: string, projectId: string | null) {
  const SIMILARITY_THRESHOLD = 0.85;
  const MAX_LINKS = 5;

  if (!projectId) return;

  try {
    // Search for similar memories using the search function
    const similarMemories = await search({
      query: content,
      limit: MAX_LINKS,
    });

    // Filter by semantic match quality (Batch 3: honest semanticScore,
    // not the boost-inflated composite `similarity` used to carry)
    const relevantMemories = (similarMemories as SearchResult[]).filter((m: SearchResult) =>
      meetsSemanticThreshold(m, SIMILARITY_THRESHOLD)
    );

    // Create associations with memories
    for (const mem of relevantMemories) {
      await createAssociation(
        learningId,     // from learning
        mem.id,         // to memory
        'relates_to',
        mem.similarity ?? 0.9
      );
    }

    logger.info(`Auto-linked learning ${learningId} to ${relevantMemories.length} memories`);
  } catch (error) {
    logger.error('Error in auto-linking:', error);
    // Don't fail learning creation if auto-link fails
  }
}

/**
 * Get learnings for a project
 */
export async function getLearnings(projectPath: string, limit: number): Promise<LearningRecord[]> {
  try {
    const { db, schema } = await getDbClient();
    const project = await requireProject(projectPath);

    const rows = await db.select().from(schema.learnings)
      .where(eq(schema.learnings.projectId, project.id))
      .orderBy(desc(schema.learnings.createdAt))
      .limit(limit);

    return rows.map((row: any) => normalizeLearning(row));
  } catch (error: any) {
    throw error;
  }
}

/**
 * Get recent learnings
 */
export async function getRecentLearnings(projectPath: string, limit: number = 10): Promise<LearningRecord[]> {
  try {
    const { db, schema } = await getDbClient();
    const project = await requireProject(projectPath);

    const rows = await db.select().from(schema.learnings)
      .where(eq(schema.learnings.projectId, project.id))
      .orderBy(desc(schema.learnings.createdAt))
      .limit(limit);

    return rows.map((row: any) => normalizeLearning(row));
  } catch (error: any) {
    logger.error('Error getting recent learnings', error);
    throw error;
  }
}

/**
 * Get learning by ID
 */
export async function getLearningById(learningId: string): Promise<LearningRecord | null> {
  try {
    const { db, schema } = await getDbClient();
    const rows = await db.select().from(schema.learnings)
      .where(eq(schema.learnings.id, learningId))
      .limit(1);

    if (rows.length === 0) return null;
    return normalizeLearning(rows[0]);
  } catch (error: any) {
    logger.error('Error getting learning', error);
    throw error;
  }
}

/**
 * Get learnings linked to a specific memory
 */
export async function getLearningsForMemory(memoryId: string): Promise<LearningRecord[]> {
  try {
    const { db, schema } = await getDbClient();
    const rows = await db.select().from(schema.learnings)
      .where(eq(schema.learnings.memoryId, memoryId))
      .orderBy(desc(schema.learnings.createdAt));

    return rows.map((row: any) => normalizeLearning(row));
  } catch (error: any) {
    logger.error('Error getting learnings for memory', error);
    throw error;
  }
}

/**
 * Delete a learning
 */
export async function deleteLearning(learningId: string): Promise<boolean> {
  try {
    const { db, schema } = await getDbClient();
    await db.delete(schema.learnings)
      .where(eq(schema.learnings.id, learningId));
    return true;
  } catch (error: any) {
    logger.error('Error deleting learning', error);
    return false;
  }
}

function normalizeLearning(row: any): LearningRecord {
  const details = deserializeMetadata(row.details ?? null);
  return {
    id: row.id,
    projectId: row.projectId ?? row.project_id ?? null,
    conversationId: row.conversationId ?? row.conversation_id ?? null,
    type: row.type as LearningType,
    action: row.action,
    target: row.target ?? null,
    summary: row.summary,
    details,
    memoryId: row.memoryId ?? row.memory_id ?? null,
    isImported: row.isImported ?? row.is_imported ?? false,
    createdAt: normalizeTimestamp(row.createdAt ?? row.created_at),
  };
}

// Backwards compatibility aliases
export const getObservations = getLearnings;
export const getRecentObservations = getRecentLearnings;
export const getObservationById = getLearningById;
