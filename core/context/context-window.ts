import { eq, and, sql } from 'drizzle-orm';
import { estimateTextTokens } from '../lib/tokens.js';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { createDatabaseClient } from '../storage/database.js';
import { requireProject } from '../projects.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';

export interface ContextWindowConfig {
  maxTokens: number;
  warningThreshold: number;
  criticalThreshold: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextWindowConfig = {
  maxTokens: 128000,
  warningThreshold: 0.80,
  criticalThreshold: 0.95,
};

export interface TokenUsageStats {
  coreMemoryTokens: number;
  memoriesTokens: number;
  totalTokens: number;
  maxTokens: number;
  usagePercent: number;
  status: 'ok' | 'warning' | 'critical';
  remainingTokens: number;
}

export interface OptimizationSuggestion {
  type: 'drop' | 'summarize' | 'consolidate';
  memoryId: string;
  memoryType: string;
  contentPreview: string;
  tokens: number;
  reason: string;
  priority: number;
}

export function estimateTokens(content: string): number {
  if (!content) return 0;
  return estimateTextTokens(content);
}

async function assertContextWindowReadAvailable(operation: string): Promise<void> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(
      `context_window:${operation}`,
      'context_window',
      `Context-window ${operation} is disabled under strict trust until caller-scoped memory authorization is implemented`,
    );
  }
}

export async function getTokenUsage(projectPath: string): Promise<TokenUsageStats> {
  await assertContextWindowReadAvailable('usage reads');
  const project = await requireProject(projectPath);
  const projectId = project.id;
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();
  const memories = schema.memories; const coreMemory = schema.coreMemory;

  const coreMemoryRows = await db
    .select()
    .from(coreMemory)
    .where(eq(coreMemory.projectId, projectId as any));

  let coreMemoryTokens = 0;
  for (const row of coreMemoryRows) {
    coreMemoryTokens += (row as any).tokensEstimate || estimateTokens((row as any).content || '');
  }

  const memoryRows = await db
    .select({
      tokens: (memories as any).tokensEstimate,
      content: memories.content,
    })
    .from(memories)
    .where(eq(memories.projectId, projectId as any));

  let memoriesTokens = 0;
  for (const row of memoryRows) {
    memoriesTokens += (row as any).tokens || estimateTokens((row as any).content || '');
  }

  const totalTokens = coreMemoryTokens + memoriesTokens;
  const config = DEFAULT_CONTEXT_CONFIG;
  const usagePercent = (totalTokens / config.maxTokens) * 100;
  const remainingTokens = Math.max(0, config.maxTokens - totalTokens);

  let status: 'ok' | 'warning' | 'critical' = 'ok';
  if (usagePercent >= config.criticalThreshold * 100) {
    status = 'critical';
  } else if (usagePercent >= config.warningThreshold * 100) {
    status = 'warning';
  }

  return {
    coreMemoryTokens,
    memoriesTokens,
    totalTokens,
    maxTokens: config.maxTokens,
    usagePercent,
    status,
    remainingTokens,
  };
}

export async function checkContextLimit(
  projectPath: string,
  additionalTokens: number
): Promise<{ ok: boolean; warning?: string; stats: TokenUsageStats }> {
  const stats = await getTokenUsage(projectPath);
  const projectedTotal = stats.totalTokens + additionalTokens;
  const projectedPercent = (projectedTotal / stats.maxTokens) * 100;

  if (projectedPercent >= DEFAULT_CONTEXT_CONFIG.criticalThreshold * 100) {
    return {
      ok: false,
      warning: `CRITICAL: Adding ${additionalTokens} tokens would exceed ${(DEFAULT_CONTEXT_CONFIG.criticalThreshold * 100).toFixed(0)}% of context limit (${projectedPercent.toFixed(1)}% projected). Consider optimizing first.`,
      stats,
    };
  }

  if (projectedPercent >= DEFAULT_CONTEXT_CONFIG.warningThreshold * 100) {
    return {
      ok: true,
      warning: `WARNING: Adding ${additionalTokens} tokens would reach ${(projectedPercent.toFixed(1))}% of context limit. Consider optimizing soon.`,
      stats,
    };
  }

  return { ok: true, stats };
}

export async function getOptimizationSuggestions(
  projectPath: string
): Promise<OptimizationSuggestion[]> {
  await assertContextWindowReadAvailable('optimization suggestions');
  const project = await requireProject(projectPath);
  const projectId = project.id;
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();
  const memories = schema.memories;

  const candidates = await db
    .select({
      id: memories.id,
      type: memories.type,
      content: memories.content,
      tokens: (memories as any).tokensEstimate,
      importanceScore: (memories as any).importanceScore,
      accessCount: (memories as any).accessCount,
      createdAt: memories.createdAt,
      isPinned: (memories as any).isPinned,
      isProtected: (memories as any).isProtected,
    })
    .from(memories)
    .where(eq(memories.projectId, projectId as any))
    .orderBy(sql`(importance_score * 0.4 + (100 - COALESCE(access_count, 0)) * 0.3 + (strftime('%s', 'now') - created_at / 1000) / 86400 * 0.3) ASC`)
    .limit(20);

  const suggestions: OptimizationSuggestion[] = [];

  for (const mem of candidates) {
    const tokens = (mem as any).tokens || estimateTokens((mem as any).content || '');
    const contentPreview = (mem as any).content?.substring(0, 100) + '...';
    const isPinned = (mem as any).isPinned === 1 || (mem as any).isPinned === true;
    const isProtected = (mem as any).isProtected === 1 || (mem as any).isProtected === true;
    const accessCount = (mem as any).accessCount || 0;
    const importanceScore = (mem as any).importanceScore || 50;

    if (isPinned || isProtected) {
      continue;
    }

    if (importanceScore < 30 && accessCount < 3) {
      suggestions.push({
        type: 'drop',
        memoryId: mem.id,
        memoryType: mem.type,
        contentPreview,
        tokens,
        reason: `Low importance (${importanceScore}) and rarely accessed (${accessCount} times)`,
        priority: 1,
      });
    } else if (importanceScore < 50 && tokens > 500) {
      suggestions.push({
        type: 'summarize',
        memoryId: mem.id,
        memoryType: mem.type,
        contentPreview,
        tokens,
        reason: `Large memory (${tokens} tokens) with moderate importance`,
        priority: 2,
      });
    } else if (tokens > 1000) {
      suggestions.push({
        type: 'consolidate',
        memoryId: mem.id,
        memoryType: mem.type,
        contentPreview,
        tokens,
        reason: `Very large memory (${tokens} tokens) - candidate for consolidation`,
        priority: 3,
      });
    }
  }

  return suggestions.sort((a, b) => a.priority - b.priority).slice(0, 10);
}

export async function getContextWindowStatus(projectPath: string): Promise<{
  config: ContextWindowConfig;
  usage: TokenUsageStats;
  suggestions: OptimizationSuggestion[];
  memoryCount: number;
  coreMemorySections: number;
}> {
  await assertContextWindowReadAvailable('status reads');
  const project = await requireProject(projectPath);
  const projectId = project.id;
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  const [usage, suggestions] = await Promise.all([
    getTokenUsage(projectPath),
    getOptimizationSuggestions(projectPath),
  ]);

  const memoryCount = await db
    .select({ count: sql`COUNT(*)` })
    .from(schema.memories)
    .where(eq(schema.memories.projectId, projectId as any));

  const coreMemorySections = await db
    .select({ count: sql`COUNT(*)` })
    .from(schema.coreMemory)
    .where(eq(schema.coreMemory.projectId, projectId as any));

  return {
    config: DEFAULT_CONTEXT_CONFIG,
    usage,
    suggestions,
    memoryCount: (memoryCount[0] as any)?.count || 0,
    coreMemorySections: (coreMemorySections[0] as any)?.count || 0,
  };
}

// ─── Tiered Context Injection (v2.4) ────────────────────────────────────────

export type InjectionTier = 'full' | 'summarized' | 'compressed' | 'dropped';

export interface MemoryForInjection {
  id: string;
  content: string;
  type: string;
  importanceScore: number;
  accessCount: number;
  isPinned: boolean;
  isProtected: boolean;
  tokensEstimate: number;
}

export interface TierConfig {
  minImportance: number;
  maxTokens?: number;
}

export interface TieredInjectionConfig {
  maxTokens: number;
  tiers: {
    full: TierConfig;
    summarized: TierConfig;
    compressed: TierConfig;
    dropped: TierConfig;
  };
}

export const DEFAULT_INJECTION_CONFIG: TieredInjectionConfig = {
  maxTokens: 8000,
  tiers: {
    full: { minImportance: 80, maxTokens: 5000 },
    summarized: { minImportance: 50, maxTokens: 3000 },
    compressed: { minImportance: 20, maxTokens: 1000 },
    dropped: { minImportance: 0 },
  },
};

export interface InjectedMemory {
  id: string;
  content: string;
  originalContent: string;
  type: string;
  tier: InjectionTier;
  tokens: number;
  importanceScore: number;
}

export interface TieredInjectionResult {
  injected: InjectedMemory[];
  dropped: MemoryForInjection[];
  totalTokens: number;
  remainingTokens: number;
  budgetExceeded: boolean;
}

/**
 * Select the appropriate injection tier for a memory based on its importance
 * and protection status. Pinned/protected memories always get 'full' tier.
 */
export function selectInjectionTier(
  memory: MemoryForInjection,
  config: TieredInjectionConfig
): InjectionTier {
  if (memory.isPinned || memory.isProtected) {
    return 'full';
  }

  const importance = memory.importanceScore;

  if (importance >= config.tiers.full.minImportance) return 'full';
  if (importance >= config.tiers.summarized.minImportance) return 'summarized';
  if (importance >= config.tiers.compressed.minImportance) return 'compressed';
  return 'dropped';
}

/**
 * Truncate content to fit within a token budget.
 */
function truncateContent(content: string, maxTokens: number): string {
  const maxChars = maxTokens * 4; // estimateTokens is length/4
  if (content.length <= maxChars) return content;
  return content.substring(0, maxChars) + '...';
}

/**
 * Inject memories into context using tier-based selection and budget awareness.
 * - Pinned/protected memories are always injected at full tier
 * - Remaining memories are sorted by importance and injected until budget is exhausted
 * - Each tier has its own token limit for individual memories
 */
export function injectMemoriesTiered(
  memories: MemoryForInjection[],
  config: TieredInjectionConfig
): TieredInjectionResult {
  const injected: InjectedMemory[] = [];
  const dropped: MemoryForInjection[] = [];
  let totalTokens = 0;

  // Separate pinned/protected from regular memories
  const pinnedMemories = memories.filter(m => m.isPinned || m.isProtected);
  const regularMemories = memories.filter(m => !m.isPinned && !m.isProtected);

  // Sort regular memories by importance descending
  regularMemories.sort((a, b) => b.importanceScore - a.importanceScore);

  // Always inject pinned/protected memories at full tier
  for (const mem of pinnedMemories) {
    const tier = 'full' as InjectionTier;
    const tierConfig = config.tiers[tier];
    const tokens = mem.tokensEstimate || estimateTokens(mem.content);
    const effectiveTokens = tierConfig.maxTokens
      ? Math.min(tokens, tierConfig.maxTokens)
      : tokens;
    const content = tierConfig.maxTokens
      ? truncateContent(mem.content, tierConfig.maxTokens)
      : mem.content;

    injected.push({
      id: mem.id,
      content,
      originalContent: mem.content,
      type: mem.type,
      tier,
      tokens: effectiveTokens,
      importanceScore: mem.importanceScore,
    });
    totalTokens += effectiveTokens;
  }

  // Inject regular memories until budget is exhausted
  for (const mem of regularMemories) {
    const tier = selectInjectionTier(mem, config);

    if (tier === 'dropped') {
      dropped.push(mem);
      continue;
    }

    const tierConfig = config.tiers[tier];
    const tokens = mem.tokensEstimate || estimateTokens(mem.content);
    const effectiveTokens = tierConfig.maxTokens
      ? Math.min(tokens, tierConfig.maxTokens)
      : tokens;

    // Check if adding this memory would exceed the budget
    if (totalTokens + effectiveTokens > config.maxTokens) {
      dropped.push(mem);
      continue;
    }

    const content = tierConfig.maxTokens
      ? truncateContent(mem.content, tierConfig.maxTokens)
      : mem.content;

    injected.push({
      id: mem.id,
      content,
      originalContent: mem.content,
      type: mem.type,
      tier,
      tokens: effectiveTokens,
      importanceScore: mem.importanceScore,
    });
    totalTokens += effectiveTokens;
  }

  const remainingTokens = Math.max(0, config.maxTokens - totalTokens);
  const budgetExceeded = totalTokens > config.maxTokens;

  return {
    injected,
    dropped,
    totalTokens,
    remainingTokens,
    budgetExceeded,
  };
}
