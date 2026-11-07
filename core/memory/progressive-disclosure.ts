import { randomUUID } from 'crypto';
import { eq, desc, and, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { createDatabaseClient } from '../storage/database.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';

export interface LightweightIndex {
  id: string;
  memoryId: string;
  contentHash: string;
  contentPreview: string;
  keyTerms: string[];
  category: string;
  importance: number;
  createdAt: Date;
}

export interface MemoryPreview {
  id: string;
  type: string;
  contentPreview: string;
  keyTerms: string[];
  category: string;
  importance: number;
  lastAccessedAt?: Date;
}

export interface FullMemoryLoad {
  id: string;
  content: string;
  summary?: string;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface TokenBudgetStatus {
  budget: number;
  used: number;
  remaining: number;
  loadedCount: number;
  preloadCount: number;
}

const PREVIEW_TOKENS = 50;
const MAX_PRELOAD_CANDIDATES = 20;
const TOKEN_ESTIMATE_CHARS = 4;

async function assertProgressiveDisclosureAvailable(operation: string): Promise<void> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface('progressive_disclosure', 'memory_index', `Progressive-disclosure ${operation} is disabled under strict trust until caller-scoped memory authorization is implemented`);
  }
}

export async function createLightweightIndex(
  memoryId: string,
  content: string,
  category: string,
  importance: number
): Promise<LightweightIndex> {
  await assertProgressiveDisclosureAvailable('writes');
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();
  
  const contentHash = hashContent(content);
  const contentPreview = extractPreview(content);
  const keyTerms = extractKeyTerms(content);

  const index: LightweightIndex = {
    id: randomUUID(),
    memoryId,
    contentHash,
    contentPreview,
    keyTerms,
    category,
    importance,
    createdAt: new Date(),
  };

  await db.insert(schema.lightweightMemoryIndices).values({
    id: index.id,
    memoryId: index.memoryId,
    contentHash: index.contentHash,
    contentPreview: index.contentPreview,
    keyTerms: JSON.stringify(index.keyTerms),
    category: index.category,
    importanceScore: index.importance,
    createdAt: index.createdAt,
  });

  return index;
}

export async function searchLightweightIndices(
  projectId: string,
  query: string,
  limit: number = 10
): Promise<MemoryPreview[]> {
  await assertProgressiveDisclosureAvailable('search');
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);

  const results = await db
    .select({
      id: schema.lightweightMemoryIndices.id,
      memoryId: schema.lightweightMemoryIndices.memoryId,
      contentPreview: schema.lightweightMemoryIndices.contentPreview,
      keyTerms: schema.lightweightMemoryIndices.keyTerms,
      category: schema.lightweightMemoryIndices.category,
      importanceScore: schema.lightweightMemoryIndices.importanceScore,
      lastAccessedAt: schema.memories.lastAccessedAt,
    })
    .from(schema.lightweightMemoryIndices)
    .leftJoin(
      schema.memories,
      eq(schema.lightweightMemoryIndices.memoryId, schema.memories.id)
    )
    .where(eq(schema.lightweightMemoryIndices.memoryId, schema.memories.id))
    .limit(limit * 2);

  const scored = results.map((row: any) => {
    let score = (row.importanceScore as number) ?? 50;
    const keyTerms: string[] = typeof row.keyTerms === 'string' 
      ? JSON.parse(row.keyTerms as string) 
      : (row.keyTerms as string[]) ?? [];
    const termsLower = keyTerms.map((t: string) => t.toLowerCase());

    for (const term of queryTerms) {
      if (row.contentPreview.toLowerCase().includes(term)) {
        score += 10;
      }
      if (termsLower.some((t: string) => t.includes(term))) {
        score += 15;
      }
    }

    return {
      id: row.id as string,
      memoryId: row.memoryId as string,
      contentPreview: row.contentPreview as string,
      keyTerms,
      category: row.category as string,
      importance: (row.importanceScore as number) ?? 50,
      lastAccessedAt: row.lastAccessedAt as Date | undefined,
      score,
    };
  });

  scored.sort((a: any, b: any) => b.score - a.score);

  return scored.slice(0, limit).map((item: any) => ({
    id: item.memoryId,
    type: 'preview',
    contentPreview: item.contentPreview,
    keyTerms: item.keyTerms,
    category: item.category,
    importance: item.importance,
    lastAccessedAt: item.lastAccessedAt,
  }));
}

export async function loadFullMemory(memoryId: string): Promise<FullMemoryLoad | null> {
  await assertProgressiveDisclosureAvailable('full-memory reads');
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  const rows = await db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.id, memoryId))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    content: row.content,
    summary: row.summary ?? undefined,
    tags: Array.isArray(row.tags) ? row.tags : [],
    metadata: row.metadata ?? undefined,
  };
}

export async function estimateTokenCount(text: string): Promise<number> {
  return Math.ceil(text.length / TOKEN_ESTIMATE_CHARS);
}

export async function allocateTokenBudget(
  sessionId: string,
  budget: number
): Promise<TokenBudgetStatus> {
  await assertProgressiveDisclosureAvailable('session budget reads');
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  const [session] = await db
    .select()
    .from(schema.contextPagingSessions)
    .where(eq(schema.contextPagingSessions.sessionId, sessionId))
    .limit(1);

  if (!session) {
    return {
      budget,
      used: 0,
      remaining: budget,
      loadedCount: 0,
      preloadCount: 0,
    };
  }

  const tokensUsed = session.tokensUsed ?? 0;
  const loadedCount = (session.loadedMemoryIds as string[])?.length ?? 0;
  const preloadCount = (session.preloadCandidateIds as string[])?.length ?? 0;

  return {
    budget,
    used: tokensUsed,
    remaining: Math.max(0, budget - tokensUsed),
    loadedCount,
    preloadCount,
  };
}

export async function preloadCandidateMemories(
  sessionId: string,
  projectId: string,
  budget: number,
  excludeLoadedIds: string[]
): Promise<string[]> {
  await assertProgressiveDisclosureAvailable('preload candidate selection');
  const status = await allocateTokenBudget(sessionId, budget);
  const availableTokens = status.remaining;

  if (availableTokens < PREVIEW_TOKENS * 2) {
    return [];
  }

  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  const rows = await db
    .select({
      id: schema.memories.id,
      content: schema.memories.content,
      importanceScore: schema.memories.importanceScore,
      lastAccessedAt: schema.memories.lastAccessedAt,
    })
    .from(schema.memories)
    .where(
      and(
        eq(schema.memories.projectId, projectId),
        eq(schema.memories.isActive, true),
        excludeLoadedIds.length > 0 
          ? sql`${schema.memories.id} NOT IN (${excludeLoadedIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',')})` 
          : sql`TRUE`
      )
    )
    .orderBy(desc(schema.memories.importanceScore), desc(schema.memories.lastAccessedAt))
    .limit(MAX_PRELOAD_CANDIDATES);

  const candidates: string[] = [];
  let tokensForPreload = Math.min(availableTokens - PREVIEW_TOKENS, availableTokens * 0.3);

  for (const row of rows) {
    const tokens = await estimateTokenCount(row.content ?? '');
    if (tokens <= tokensForPreload) {
      candidates.push(row.id as string);
      tokensForPreload -= tokens;
    }
    if (candidates.length >= 5) break;
  }

  await db
    .update(schema.contextPagingSessions)
    .set({
      preloadCandidateIds: candidates,
      updatedAt: new Date(),
    })
    .where(eq(schema.contextPagingSessions.sessionId, sessionId));

  return candidates;
}

export async function getPreloadCandidates(sessionId: string): Promise<MemoryPreview[]> {
  await assertProgressiveDisclosureAvailable('preload candidate reads');
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  const [session] = await db
    .select()
    .from(schema.contextPagingSessions)
    .where(eq(schema.contextPagingSessions.sessionId, sessionId))
    .limit(1);

  if (!session) return [];

  const candidateIds = (session.preloadCandidateIds as string[]) ?? [];
  if (candidateIds.length === 0) return [];

  const previews: MemoryPreview[] = [];
  for (const memoryId of candidateIds.slice(0, 5)) {
    const [index] = await db
      .select()
      .from(schema.lightweightMemoryIndices)
      .where(eq(schema.lightweightMemoryIndices.memoryId, memoryId))
      .limit(1);

    if (index) {
      const keyTerms: string[] = typeof index.keyTerms === 'string'
        ? JSON.parse(index.keyTerms as string)
        : (index.keyTerms as string[]) ?? [];

      previews.push({
        id: index.memoryId as string,
        type: 'preload',
        contentPreview: index.contentPreview as string,
        keyTerms,
        category: index.category as string,
        importance: (index.importanceScore as number) ?? 50,
      });
    }
  }

  return previews;
}

export async function updateIndexImportance(
  memoryId: string,
  importance: number
): Promise<void> {
  await assertProgressiveDisclosureAvailable('index updates');
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  await db
    .update(schema.lightweightMemoryIndices)
    .set({
      importanceScore: importance,
    })
    .where(eq(schema.lightweightMemoryIndices.memoryId, memoryId));
}

export async function deleteLightweightIndex(memoryId: string): Promise<void> {
  await assertProgressiveDisclosureAvailable('index deletion');
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  await db
    .delete(schema.lightweightMemoryIndices)
    .where(eq(schema.lightweightMemoryIndices.memoryId, memoryId));
}

function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function extractPreview(content: string): string {
  const firstPeriod = content.indexOf('.');
  const firstNewline = content.indexOf('\n');
  
  let endIndex = content.length;
  if (firstPeriod > 0 && firstPeriod < 100) {
    endIndex = firstPeriod + 1;
  } else if (firstNewline > 0 && firstNewline < 100) {
    endIndex = firstNewline;
  }
  
  return content.substring(0, Math.min(endIndex, 150)).trim();
}

function extractKeyTerms(content: string): string[] {
  const words = content.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  
  const stopWords = new Set([
    'this', 'that', 'with', 'from', 'have', 'been', 'were', 'they',
    'their', 'which', 'about', 'would', 'could', 'should', 'there',
    'what', 'when', 'where', 'who', 'will', 'just', 'like', 'into',
    'than', 'then', 'both', 'each', 'more', 'most', 'other', 'some',
    'such', 'only', 'over', 'very', 'also', 'back', 'after', 'being',
  ]);
  
  const termCounts: Record<string, number> = {};
  for (const word of words) {
    if (!stopWords.has(word) && !/^\d+$/.test(word)) {
      termCounts[word] = (termCounts[word] ?? 0) + 1;
    }
  }
  
  return Object.entries(termCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([term]) => term);
}
