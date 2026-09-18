/**
 * LLM Consolidator
 *
 * Uses LLM to find creative cross-connections across memories that the
 * algorithmic DBSCAN approach would miss. Stores insights as knowledge
 * records and creates edges between related memories.
 *
 * Design principles:
 * - LLM is ALWAYS optional - returns empty results when unavailable
 * - No placeholder content - only real LLM-generated insights
 * - Uses existing knowledge system (createKnowledge + createKnowledgeEdge)
 * - Tag-based batching: groups memories with shared tags for semantic coherence
 * - Processes only recent unconsolidated memories (sliding window)
 * - Tracks processed memories to avoid re-analysis
 * - Capped at configurable max per run (default 40 memories = 2-3 LLM calls)
 */

import { eq, and, isNull, or, desc, inArray } from 'drizzle-orm';
import { config } from '../../config.js';
import { callLLM } from '../llm/client.js';
import { logger } from '../logger.js';
import { getDbClient } from '../lib/db-client.js';
import { createKnowledge } from '../knowledge/knowledge-crud.js';
import { createKnowledgeEdge } from '../knowledge/knowledge-edges.js';
import type { KnowledgeEdgeType } from '../knowledge/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConsolidationResult {
  insightsCreated: number;
  edgesCreated: number;
  memoriesProcessed: number;
  errors: string[];
}

interface MemoryRow {
  id: string;
  projectId: string | null;
  type: string;
  content: string;
  tags: string | null;
  metadata: string | null;
  importanceScore: number | null;
  createdAt: number;
}

interface CrossConnection {
  memoryIds: string[];
  insight: string;
  edgeType: KnowledgeEdgeType;
  confidence: number;
}

interface TagGroup {
  tag: string;
  memories: MemoryRow[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max memories to process per run (20 memories = ~1 LLM call with context) */
const DEFAULT_MAX_MEMORIES = 40;

/** Memories per LLM batch (keep context window manageable) */
const BATCH_SIZE = 15;

/** Max connections to extract per batch */
const MAX_CONNECTIONS_PER_BATCH = 5;

/** Max memories per connection */
const MAX_MEMORIES_PER_CONNECTION = 4;

/** Max characters per memory content sent to LLM */
const MAX_CONTENT_CHARS = 250;

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Run LLM-driven consolidation on recent memories.
 *
 * Strategy for 1k+ memory systems:
 * 1. Fetch unconsolidated memories ordered by recency
 * 2. Group by shared tags → semantically coherent batches
 * 3. For each tag group, analyze a sample (capped at BATCH_SIZE)
 * 4. Track processed memories to avoid re-analysis
 * 5. Cap total memories per run at DEFAULT_MAX_MEMORIES
 */
export async function runLLMConsolidation(
  projectId?: string,
  options?: {
    maxMemories?: number;
    batchSize?: number;
    daysBack?: number;
    llmEnabled?: boolean;
  }
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    insightsCreated: 0,
    edgesCreated: 0,
    memoriesProcessed: 0,
    errors: [],
  };

  const effectiveLlmEnabled = options?.llmEnabled ?? config.llmEnabled;
  if (!effectiveLlmEnabled) {
    logger.debug('[LLM Consolidation] LLM not enabled, skipping');
    return result;
  }

  const maxMemories = options?.maxMemories ?? DEFAULT_MAX_MEMORIES;
  const batchSize = options?.batchSize ?? BATCH_SIZE;
  const daysBack = options?.daysBack ?? 30;

  try {
    // Step 1: Fetch unconsolidated memories (recent window only)
    const memories = await fetchUnconsolidatedMemories(projectId, maxMemories, daysBack);
    if (memories.length === 0) {
      logger.debug('[LLM Consolidation] No unconsolidated memories in recent window');
      return result;
    }

    // Step 2: Filter out memories already processed by LLM consolidator
    const unprocessed = filterAlreadyProcessed(memories);
    if (unprocessed.length === 0) {
      logger.debug('[LLM Consolidation] All recent memories already processed');
      return result;
    }

    result.memoriesProcessed = unprocessed.length;

    // Step 3: Group memories by shared tags for semantic batching
    const tagGroups = buildTagGroups(unprocessed);

    // Step 4: Process each tag group
    for (const group of tagGroups) {
      if (group.memories.length < 2) continue; // need at least 2 for a connection

      const batch = group.memories.slice(0, batchSize);
      try {
        const connections = await analyzeBatch(batch, group.tag);

        for (const conn of connections) {
          try {
            // Resolve project ID from the first connected memory
            const sourceProject = unprocessed.find(m => m.id === conn.memoryIds[0])?.projectId;

            const insight = await createKnowledge({
              projectId: sourceProject ?? projectId,
              knowledgeKind: 'memory',
              knowledgeType: 'note',
              content: conn.insight,
              summary: `LLM cross-connection (${conn.edgeType}) in [${group.tag}]`,
              confidence: conn.confidence,
              confidenceLevel: conn.confidence > 0.7 ? 'certain' : 'speculative',
              importanceScore: conn.confidence * 0.8,
              tags: ['llm-consolidation', 'cross-connection', group.tag, conn.edgeType],
              metadata: {
                source: 'llm-consolidator',
                sourceMemoryIds: conn.memoryIds,
                edgeType: conn.edgeType,
                tagGroup: group.tag,
                detectedAt: new Date().toISOString(),
              },
            });
            result.insightsCreated++;

            // Create edges between connected memories
            for (let j = 0; j < conn.memoryIds.length; j++) {
              for (let k = j + 1; k < conn.memoryIds.length; k++) {
                try {
                  await createKnowledgeEdge({
                    fromId: conn.memoryIds[j],
                    fromKind: 'knowledge',
                    toId: conn.memoryIds[k],
                    toKind: 'knowledge',
                    edgeType: conn.edgeType,
                    weight: conn.confidence,
                    metadata: {
                      source: 'llm-consolidator',
                      insightId: insight.id,
                    },
                  });
                  result.edgesCreated++;
                } catch {
                  // Edge may already exist — deduplicate silently
                }
              }
            }

            // Mark source memories as LLM-consolidated
            await markAsProcessed(conn.memoryIds);
          } catch (err) {
            result.errors.push(`Failed to store insight: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        result.errors.push(`Batch analysis failed for [${group.tag}]: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logger.info('[LLM Consolidation] Complete', {
      memoriesProcessed: result.memoriesProcessed,
      insightsCreated: result.insightsCreated,
      edgesCreated: result.edgesCreated,
      tagGroups: tagGroups.length,
      errors: result.errors.length,
    });

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(msg);
    logger.error('[LLM Consolidation] Failed:', msg);
    return result;
  }
}

// ─── Memory Fetching ─────────────────────────────────────────────────────────

/**
 * Fetch recent unconsolidated memories, capped by maxMemories.
 * Only looks at a sliding window (daysBack) to avoid scanning 1k+ rows.
 */
async function fetchUnconsolidatedMemories(
  projectId: string | undefined,
  limit: number,
  daysBack: number
): Promise<MemoryRow[]> {
  const { db, schema } = await getDbClient();

  const cutoff = Math.floor(Date.now() / 1000) - daysBack * 86400;

  const conditions = [
    or(
      isNull(schema.memories.isConsolidated),
      eq(schema.memories.isConsolidated, false as any)
    ),
    // Sliding window: only recent memories
    // createdAt is unix timestamp
  ];

  if (projectId) {
    conditions.push(eq(schema.memories.projectId, projectId));
  }

  const rows = await db
    .select({
      id: schema.memories.id,
      projectId: schema.memories.projectId,
      type: schema.memories.type,
      content: schema.memories.content,
      tags: schema.memories.tags,
      metadata: schema.memories.metadata,
      importanceScore: schema.memories.importanceScore,
      createdAt: schema.memories.createdAt,
    })
    .from(schema.memories)
    .where(and(...conditions))
    .orderBy(desc(schema.memories.createdAt))
    .limit(limit)
    .all();

  // Filter by recency in JS (drizzle doesn't do raw comparisons on text columns)
  return (rows as MemoryRow[]).filter(m => {
    const ts = typeof m.createdAt === 'number' ? m.createdAt : 0;
    return ts >= cutoff;
  });
}

/**
 * Filter out memories already processed by LLM consolidator.
 * Checks metadata JSON for 'llm-consolidator' source marker.
 */
function filterAlreadyProcessed(memories: MemoryRow[]): MemoryRow[] {
  return memories.filter(m => {
    if (!m.metadata) return true;
    try {
      const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata;
      return meta.source !== 'llm-consolidator';
    } catch {
      return true; // corrupted metadata — include it
    }
  });
}

// ─── Tag-Based Grouping ──────────────────────────────────────────────────────

/**
 * Group memories by shared tags. Memories with no tags go into a
 * "general" bucket. This creates semantically coherent batches.
 */
function buildTagGroups(memories: MemoryRow[]): TagGroup[] {
  const groupMap = new Map<string, MemoryRow[]>();

  for (const m of memories) {
    const tags = parseTags(m.tags);
    if (tags.length === 0) {
      // Untagged memories → "general" group
      const existing = groupMap.get('general') ?? [];
      existing.push(m);
      groupMap.set('general', existing);
    } else {
      // Each tag gets this memory in its group
      for (const tag of tags) {
        const existing = groupMap.get(tag) ?? [];
        existing.push(m);
        groupMap.set(tag, existing);
      }
    }
  }

  // Convert to array, sort by group size (largest first)
  const groups: TagGroup[] = [];
  for (const [tag, mems] of groupMap) {
    groups.push({ tag, memories: mems });
  }
  groups.sort((a, b) => b.memories.length - a.memories.length);

  return groups;
}

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── LLM Analysis ────────────────────────────────────────────────────────────

/**
 * Send a batch of memories to LLM and extract cross-connections.
 * Includes the tag context to help LLM understand the grouping.
 */
async function analyzeBatch(
  memories: MemoryRow[],
  tagContext: string
): Promise<CrossConnection[]> {
  const memTexts = memories.map((m, i) => {
    const tags = parseTags(m.tags);
    return `[${i + 1}] (id=${m.id}, type=${m.type}) ${m.content.substring(0, MAX_CONTENT_CHARS)}${m.content.length > MAX_CONTENT_CHARS ? '...' : ''} [tags: ${tags.join(', ')}]`;
  }).join('\n\n');

  const prompt = `You are analyzing memories from an AI coding assistant's memory system. These memories share the tag context "[${tagContext}]". Find cross-connections between them.

Memories:
${memTexts}

Find connections between these memories. For each connection, respond in this JSON format:

[
  {
    "memoryIds": ["id1", "id2"],
    "insight": "Brief description of the connection",
    "edgeType": "related_to|supports|contradicts|informed_by|depends_on|extends",
    "confidence": 0.0-1.0
  }
]

Rules:
- Only connect memories with genuine semantic relationships
- Use exact memory IDs from the input
- Return ONLY the JSON array
- Max ${MAX_CONNECTIONS_PER_BATCH} connections
- edgeType must be one of: related_to, supports, contradicts, informed_by, depends_on, extends`;

  const response = await callLLM(prompt);
  if (!response) return [];

  return parseConnections(response);
}

// ─── Response Parsing ────────────────────────────────────────────────────────

function parseConnections(response: string): CrossConnection[] {
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const validEdgeTypes = new Set(['related_to', 'supports', 'contradicts', 'informed_by', 'depends_on', 'extends']);

    return parsed
      .filter((c: any) =>
        c.memoryIds &&
        Array.isArray(c.memoryIds) &&
        c.memoryIds.length >= 2 &&
        c.insight &&
        typeof c.insight === 'string' &&
        c.edgeType &&
        validEdgeTypes.has(c.edgeType) &&
        typeof c.confidence === 'number' &&
        c.confidence >= 0 &&
        c.confidence <= 1
      )
      .map((c: any) => ({
        memoryIds: c.memoryIds.slice(0, MAX_MEMORIES_PER_CONNECTION),
        insight: c.insight.substring(0, 500),
        edgeType: c.edgeType as KnowledgeEdgeType,
        confidence: Math.min(1, Math.max(0, c.confidence)),
      }))
      .slice(0, MAX_CONNECTIONS_PER_BATCH);
  } catch (err) {
    logger.debug('[LLM Consolidation] Failed to parse LLM response', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ─── Tracking ────────────────────────────────────────────────────────────────

/**
 * Mark memories as processed by adding 'llm-consolidator' source to metadata.
 * This prevents re-analysis on subsequent runs.
 */
async function markAsProcessed(memoryIds: string[]): Promise<void> {
  const { db, schema } = await getDbClient();

  for (const id of memoryIds) {
    try {
      // Fetch current metadata
      const row = await db
        .select({ metadata: schema.memories.metadata })
        .from(schema.memories)
        .where(eq(schema.memories.id, id))
        .get();

      if (!row) continue;

      const currentMeta = typeof row.metadata === 'string'
        ? (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })()
        : (row.metadata ?? {});

      // Add LLM consolidator marker
      const updatedMeta = {
        ...currentMeta,
        source: 'llm-consolidator',
        lastLlmConsolidation: new Date().toISOString(),
      };

      await db
        .update(schema.memories)
        .set({ metadata: JSON.stringify(updatedMeta) })
        .where(eq(schema.memories.id, id))
        .run();
    } catch (err) {
      logger.debug('[LLM Consolidation] Failed to mark memory as processed', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
