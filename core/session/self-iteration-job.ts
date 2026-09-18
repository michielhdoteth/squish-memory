/** Self-Iteration Job - Auto-extract key facts from ended conversations
 *
 * Processes conversations to extract memories and generate summaries
 */

import { sql, eq } from 'drizzle-orm';
import { registerJobHandler, type JobExecutionContext, type JobHandler } from '../scheduler/cron-scheduler.js';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { getProjectById } from '../projects.js';
import { rememberMemory, search } from '../memory/memories.js';
import { serializeMetadata, deserializeMetadata } from '../memory/serialization.js';
import { logger } from '../logger.js';
import { meetsSemanticThreshold } from '../scoring/three-field.js';
import { generateExtractiveSummary, extractMessageContent } from '../utils/content-extraction.js';
import {
  extractStrategiesFromConversation,
} from '../knowledge/extractor.js';
import {
  listKnowledgeByKind,
  updateKnowledge,
  createKnowledge,
  searchKnowledge,
  getKnowledgeById,
} from '../knowledge/store.js';
import { boostConfidence, runDecayCycle } from '../knowledge/decay.js';
import { runDeduplicationCycle } from '../knowledge/deduplicator.js';
import type { CreateKnowledgeInput } from '../knowledge/types.js';
import type { MemoryType } from '../lib/types.js';

export interface SelfIterationConfig {
  enabled: boolean;
  extractFacts: boolean;
  generateSummaries: boolean;
  consolidateMemories: boolean;
  minMessageCount: number;
  maxMessagesToProcess: number;
}

const DEFAULT_CONFIG: SelfIterationConfig = {
  enabled: true,
  extractFacts: true,
  generateSummaries: true,
  consolidateMemories: true,
  minMessageCount: 5,
  maxMessagesToProcess: 50,
};

interface ConversationRow {
  id: string;
  sessionId: string;
  projectId: string | null;
  summary: string | null;
  messageCount: number;
  metadata: Record<string, unknown> | null;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: Date;
}

interface ExtractedFact {
  content: string;
  type: ExtractableMemoryType;
  confidence: number;
}

type ExtractableMemoryType = Extract<MemoryType, 'fact' | 'decision' | 'preference'>;

const MIN_CONFIDENCE_TO_STORE = 75;
const FORBIDDEN_BRAND_TERMS = new RegExp(
  `\\b(?:${['mem' + '\\s*' + 'palace', 'mem' + '-' + 'palace', 'om' + 'ni'].join('|')})\\b`,
  'i'
);

const LOW_SIGNAL_PATTERNS = [
  /^\s*(?:thanks?|thank you|hello|hi|hey)\b/i,
  /\b(?:can you|could you|please|help me|show me|explain|what is|how do i)\b/i,
  /\b(?:i'll|i will|we will|let's|todo|task|goal|next step|follow up|remind me)\b/i,
  /^\s*[-*]\s+\[[ x]\]/i,
];

const EXTRACTION_PATTERNS: Array<{
  pattern: RegExp;
  type: ExtractableMemoryType;
  confidence: number;
  prefix: string;
}> = [
  {
    pattern: /\b(?:i|we)\s+(?:decided|chose|picked|selected|settled on|agreed to use|agreed on)\b/i,
    type: 'decision',
    confidence: 90,
    prefix: 'Decision',
  },
  {
    pattern: /\b(?:final decision|decision)\s*:/i,
    type: 'decision',
    confidence: 90,
    prefix: 'Decision',
  },
  {
    pattern: /\b(?:i|we)\s+(?:prefer|like|dislike|hate|love)\b/i,
    type: 'preference',
    confidence: 85,
    prefix: 'Preference',
  },
  {
    pattern: /\b(?:my|our|the user's)\s+(?:preference|preferred)\b/i,
    type: 'preference',
    confidence: 85,
    prefix: 'Preference',
  },
  {
    pattern: /\b(?:remember|don't forget)\s+(?:that\s+)?\S+/i,
    type: 'fact',
    confidence: 80,
    prefix: 'Fact',
  },
  {
    pattern: /\b(?:project|repo|workspace|service|app)\s+\S+\s+(?:uses|runs on|depends on|requires|stores)\b/i,
    type: 'fact',
    confidence: 80,
    prefix: 'Fact',
  },
];

/**
 * Parse LLM fact extraction response
 */
function parseExtractedFacts(llmResponse: string): ExtractedFact[] {
  try {
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const json = JSON.parse(jsonMatch[0]);
    return json.extractedFacts || [];
  } catch {
    logger.warn('[SelfIteration] Failed to parse fact extraction response');
    return [];
  }
}

function normalizeCaptureKey(content: string): string {
  return content
    .toLowerCase()
    .replace(/^(?:decision|preference|fact):\s*/i, '')
    .replace(/['"`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s./:-]/g, '')
    .trim();
}

function isLowSignalCapture(content: string): boolean {
  const text = content.trim();
  if (text.length < 20 || text.split(/\s+/).length < 4) return true;
  if (text.endsWith('?')) return true;
  if (FORBIDDEN_BRAND_TERMS.test(text)) return true;
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

function splitCandidateStatements(content: string): string[] {
  return content
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function extractDurableSelfIterationFacts(messages: MessageRow[]): ExtractedFact[] {
  const captures = new Map<string, ExtractedFact>();

  for (const msg of messages) {
    if (msg.role !== 'user') continue;

    for (const statement of splitCandidateStatements(msg.content)) {
      if (isLowSignalCapture(statement)) continue;

      for (const { pattern, type, confidence, prefix } of EXTRACTION_PATTERNS) {
        if (!pattern.test(statement)) continue;

        const normalizedStatement = statement.replace(/^(?:decision|preference|fact):\s*/i, '');
        const content = `${prefix}: ${normalizedStatement}`;
        const key = `${type}:${normalizeCaptureKey(content)}`;
        const existing = captures.get(key);
        if (!existing || confidence > existing.confidence) {
          captures.set(key, { content, type, confidence });
        }
      }
    }
  }

  return Array.from(captures.values()).filter((fact) => fact.confidence >= MIN_CONFIDENCE_TO_STORE);
}

async function hasSimilarSelfIterationMemory(fact: ExtractedFact, projectPath?: string): Promise<boolean> {
  const matches = await search({
    query: fact.content,
    type: fact.type,
    project: projectPath,
    limit: 5,
  });
  const factKey = normalizeCaptureKey(fact.content);

  return matches.some((match) => {
    const matchMetadata = match.metadata ?? {};
    if (matchMetadata.extractionMethod !== 'self-iteration') return false;
    // Batch 3: gate on honest semantic match quality, not boost-inflated composite.
    if (meetsSemanticThreshold(match, 0.92)) return true;
    return normalizeCaptureKey(match.content) === factKey;
  });
}

/**
 * Get conversations ready for self-iteration
 */
async function getConversationsForIteration(minMessageCount: number): Promise<ConversationRow[]> {
  const db = await getDb();
  if (!db) return [];

  const schema = await getSchema();
  const sqliteDb = db as any;

  // Get conversations that:
  // 1. Have ended (endedAt is not null)
  // 2. Haven't been processed yet (metadata.selfIterationProcessed is not set)
  // 3. Have enough messages (messageCount >= minMessageCount)
  const conversations = await sqliteDb.select()
    .from(schema.conversations)
    .where(sql`${schema.conversations.endedAt} IS NOT NULL
      AND ${schema.conversations.messageCount} >= ${minMessageCount}`)
    .limit(10);

  return (conversations as any[])
    .map((conversation) => ({
      ...conversation,
      metadata: deserializeMetadata(conversation.metadata ?? null),
    }))
    .filter((conversation) => !conversation.metadata?.selfIterationProcessed) as ConversationRow[];
}

/**
 * Get messages for a conversation
 */
async function getConversationMessages(conversationId: string): Promise<MessageRow[]> {
  const db = await getDb();
  if (!db) return [];

  const schema = await getSchema();
  const sqliteDb = db as any;

  const messages = await sqliteDb.select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(schema.messages.createdAt);

  return messages.map((m: any) => ({
    id: m.id,
    conversationId: m.conversation_id,
    role: m.role,
    content: m.content,
    createdAt: new Date(m.createdAt),
  })) as MessageRow[];
}

/**
 * Mark conversation as processed
 */
async function markConversationProcessed(conversationId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const schema = await getSchema();
  const sqliteDb = db as any;

  const rows = await sqliteDb.select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  const existingMetadata = deserializeMetadata(rows[0]?.metadata ?? null) ?? {};

  await sqliteDb.update(schema.conversations)
    .set({
      metadata: serializeMetadata({
        ...existingMetadata,
        selfIterationProcessed: true,
        selfIterationProcessedAt: new Date().toISOString(),
      }),
    })
    .where(eq(schema.conversations.id, conversationId));
}

/**
 * Process a single conversation
 */
async function processConversation(
  conversation: ConversationRow,
  config: SelfIterationConfig
): Promise<{ memoriesCreated: number; summariesCreated: number }> {
  const messages = await getConversationMessages(conversation.id);
  let memoriesCreated = 0;
  let summariesCreated = 0;

  // Limit messages if configured
  const messagesToProcess = config.maxMessagesToProcess > 0
    ? messages.slice(-config.maxMessagesToProcess)
    : messages;

  if (messagesToProcess.length === 0) {
    return { memoriesCreated, summariesCreated };
  }

  // Extract facts using improved pattern matching
  if (config.extractFacts) {
    const extractedFacts = extractDurableSelfIterationFacts(messagesToProcess);
    const project = conversation.projectId ? await getProjectById(conversation.projectId) : null;
    const projectPath = project?.path;

    // Store extracted facts as memories
    for (const fact of extractedFacts) {
      try {
        if (await hasSimilarSelfIterationMemory(fact, projectPath)) {
          logger.debug(`[SelfIteration] Suppressed duplicate memory`, { type: fact.type, contentLength: fact.content.length });
          continue;
        }

        await rememberMemory({
          content: fact.content,
          type: fact.type,
          project: projectPath,
          metadata: {
            extractionMethod: 'self-iteration',
            confidence: fact.confidence,
            conversationId: conversation.id,
            sessionId: conversation.sessionId,
          },
          source: 'self-iteration',
        });
        memoriesCreated++;
        logger.info(`[SelfIteration] Extracted memory`, { type: fact.type, contentLength: fact.content.length });
      } catch (error) {
        logger.error(`[SelfIteration] Failed to store memory:`, error);
      }
    }
  }

  // Auto-extract strategies from conversation into unified knowledge table
  try {
    const conversationContent = messagesToProcess.map(m => `[${m.role}]: ${m.content}`).join('\n\n');
    const project = conversation.projectId ? await getProjectById(conversation.projectId) : null;
    const extractedStrategies = await extractStrategiesFromConversation(conversationContent, {
      projectId: project?.id,
      sourceType: 'conversation',
    });
    for (const extracted of extractedStrategies) {
      try {
        // Check for similar existing knowledge before creating
        const similarResults = await searchKnowledge({
          contentQuery: extracted.title + ' ' + extracted.description,
          projectId: project?.id,
          kinds: ['strategy'],
          limit: 5,
        });
        if (similarResults.length > 0) {
          // Boost confidence of existing strategy instead of creating duplicate
          await boostConfidence(similarResults[0].id, 0.1);
          logger.debug(`[SelfIteration] Boosted existing strategy ${similarResults[0].id}`);
          continue;
        }

        const knowledgeInput: CreateKnowledgeInput = {
          projectId: project?.id,
          knowledgeKind: 'strategy',
          knowledgeType: extracted.strategyType,
          content: extracted.description,
          title: extracted.title,
          description: extracted.description,
          steps: extracted.steps,
          successCriteria: extracted.successCriteria,
          failureIndicators: extracted.failureIndicators,
          confidence: extracted.confidence / 100,
          tags: ['auto-extracted'],
        };
        await createKnowledge(knowledgeInput);
      } catch (strategyCreateError: any) {
        logger.debug('[SelfIteration] Failed to create strategy:', strategyCreateError);
      }
    }
  } catch (strategyError: any) {
    logger.warn('[SelfIteration] Strategy extraction failed:', strategyError);
  }

  // Generate summary
  if (config.generateSummaries && messagesToProcess.length > 0) {
    // Use extractive summarization for better results
    const extracted = extractMessageContent(messagesToProcess);
    const summary = generateExtractiveSummary(extracted);

    // Update conversation with summary
    const db = await getDb();
    const schema = await getSchema();
    const sqliteDb = db as any;

    await sqliteDb.update(schema.conversations)
      .set({ summary })
      .where(eq(schema.conversations.id, conversation.id));

    summariesCreated++;
    logger.info(`[SelfIteration] Generated summary for conversation ${conversation.sessionId}`);
  }

  return { memoriesCreated, summariesCreated };
}

/**
 * Register self-iteration job handler
 */
const selfIterationHandler: JobHandler = async (
  context: JobExecutionContext
): Promise<{ recordsProcessed: number; summary: Record<string, unknown> }> => {
  logger.info('[SelfIteration] Starting job');

  const config = {
    ...DEFAULT_CONFIG,
    ...(context.config as Partial<SelfIterationConfig>),
  };

  if (!config.enabled) {
    logger.info('[SelfIteration] Job disabled, skipping');
    return { recordsProcessed: 0, summary: { status: 'disabled' } };
  }

  try {
    const conversations = await getConversationsForIteration(
      config.minMessageCount || DEFAULT_CONFIG.minMessageCount
    );

    if (conversations.length === 0) {
      logger.info('[SelfIteration] No conversations to process');
      return { recordsProcessed: 0, summary: { status: 'no_conversations' } };
    }

    let totalMemoriesCreated = 0;
    let totalSummariesGenerated = 0;
    let processedCount = 0;

    for (const conversation of conversations) {
      // Skip if already processed
      if (conversation.metadata?.selfIterationProcessed) {
        continue;
      }

      try {
        const result = await processConversation(conversation, config);
        totalMemoriesCreated += result.memoriesCreated;
        totalSummariesGenerated += result.summariesCreated;

        await markConversationProcessed(conversation.id);
        processedCount++;
      } catch (error) {
        logger.error(`[SelfIteration] Failed to process conversation ${conversation.id}:`, error);
      }
    }

    logger.info(`[SelfIteration] Processed ${processedCount}/${conversations.length} conversations`);
    logger.info(`[SelfIteration] Created ${totalMemoriesCreated} memories`);
    logger.info(`[SelfIteration] Generated ${totalSummariesGenerated} summaries`);

    // Run unified knowledge maintenance: decay, dedup, deprecate unused
    try {
      // Run unified knowledge decay cycle (handles all kinds: memory, belief, strategy)
      try {
        await runDecayCycle();
        logger.info('[SelfIteration] Knowledge decay cycle complete');
      } catch (decayErr: any) {
        logger.debug('[SelfIteration] Knowledge decay cycle failed:', decayErr);
      }

      // Run unified knowledge dedup cycle (handles all kinds)
      try {
        await runDeduplicationCycle();
        logger.info('[SelfIteration] Knowledge dedup cycle complete');
      } catch (dedupErr: any) {
        logger.debug('[SelfIteration] Knowledge dedup cycle failed:', dedupErr);
      }
    } catch (maintenanceError: any) {
      logger.debug('[SelfIteration] Knowledge maintenance failed:', maintenanceError);
    }

    return {
      recordsProcessed: processedCount,
      summary: {
        memoriesCreated: totalMemoriesCreated,
        summariesGenerated: totalSummariesGenerated,
        totalConversations: conversations.length,
      },
    };
  } catch (error) {
    logger.error('[SelfIteration] Job failed:', error);
    return {
      recordsProcessed: 0,
      summary: { error: error instanceof Error ? error.message : String(error) },
    };
  }
};

export { selfIterationHandler, DEFAULT_CONFIG };
