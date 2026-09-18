import { eq } from 'drizzle-orm';
import { getDbClient } from '../lib/db-client.js';
import { logger } from '../logger.js';
import { serializeMetadata, deserializeMetadata } from './serialization.js';
import { detectMemorySignals, type MemorySignals } from './trigger-detector.js';
import type { MemoryType } from '../lib/types.js';

export type VisibilityScope = 'private' | 'project' | 'team';
export type MemoryAudience = 'personal' | 'project' | 'team';
export type MemoryPolicySource = 'explicit' | 'heuristic' | 'manual';
export type MemoryPolicyReviewState = 'suggested' | 'promoted' | 'demoted';

export interface MemoryPolicyHistoryEntry {
  from: VisibilityScope;
  to: VisibilityScope;
  reason: string;
  at: string;
}

export interface MemoryPolicyRecommendation {
  scope: VisibilityScope;
  reason: string;
  source: MemoryPolicySource;
}

export interface MemoryPolicy {
  captureMode: 'private-first';
  currentScope: VisibilityScope;
  audience: MemoryAudience;
  shared: boolean;
  reason: string;
  recommendation: MemoryPolicyRecommendation;
  history: MemoryPolicyHistoryEntry[];
  reviewState: MemoryPolicyReviewState;
  lastReviewedAt: string;
}

export interface MemoryPolicyContext {
  content?: string;
  type?: MemoryType;
  tags?: string[];
  visibilityScope?: VisibilityScope;
  importanceScore?: number;
  accessCount?: number;
  usageCount?: number;
  isPinned?: boolean;
  signals?: MemorySignals;
  teamId?: string;
}

export interface MemoryPolicyUpdateResult {
  memoryId: string;
  visibilityScope: VisibilityScope;
  policy: MemoryPolicy;
}

export function classifyAudience(scope: VisibilityScope): MemoryAudience {
  switch (scope) {
    case 'private':
      return 'personal';
    case 'project':
      return 'project';
    case 'team':
      return 'team';
    default:
      return 'project';
  }
}

export function buildVisibilityScopes(
  scope: VisibilityScope,
  subjectKind: 'user' | 'agent',
  subjectId?: string,
  teamId?: string,
): { readScope: string[]; writeScope: string[] } {
  const identity = subjectId ? `${subjectKind}:${subjectId}` : scope;

  switch (scope) {
    case 'private':
      return {
        readScope: subjectId ? [identity] : ['private'],
        writeScope: subjectId ? [identity] : ['private'],
      };
    case 'project':
      return {
        readScope: subjectId ? [identity, 'project:*'] : ['project:*'],
        writeScope: subjectId ? [identity, 'project:*'] : ['project:*'],
      };
    case 'team':
      return {
        readScope: subjectId
          ? [identity, ...(teamId ? [`team:${teamId}`] : ['team:*'])]
          : teamId ? [`team:${teamId}`] : ['team:*'],
        writeScope: subjectId
          ? [identity, ...(teamId ? [`team:${teamId}`] : ['team:*'])]
          : teamId ? [`team:${teamId}`] : ['team:*'],
      };
    default:
      return {
        readScope: subjectId ? [identity] : ['private'],
        writeScope: subjectId ? [identity] : ['private'],
      };
  }
}

export function serializeVisibilityScopes(scopes: string[]): string {
  return JSON.stringify(scopes);
}

export function recommendMemoryScope(input: MemoryPolicyContext): MemoryPolicyRecommendation {
  const signals = input.signals ?? detectMemorySignals(input.content ?? '');

  if (input.visibilityScope) {
    return {
      scope: input.visibilityScope,
      reason: 'explicit visibility requested',
      source: 'explicit',
    };
  }

  let score = 0;
  const reasons: string[] = ['private-first capture'];

  if (signals.explicitTriggers.length > 0) {
    score += 1;
    reasons.push('explicit trigger');
  }

  if (signals.implicit.decision || input.type === 'decision') {
    score += 3;
    reasons.push('decision');
  }

  if (signals.implicit.preference || input.type === 'preference') {
    score += 3;
    reasons.push('preference');
  }

  if (signals.implicit.workflowRule || signals.implicit.lesson) {
    score += 1;
    reasons.push('workflow rule');
  }

  if (signals.priority === 'high') {
    score += 1;
    reasons.push('high priority');
  }

  if (input.isPinned || (input.accessCount ?? 0) >= 5 || (input.usageCount ?? 0) >= 5) {
    score += 2;
    reasons.push('proven reuse');
  }

  if ((input.importanceScore ?? 0) >= 80) {
    score += 1;
    reasons.push('high importance');
  }

  if (score >= 4) {
    return {
      scope: 'project',
      reason: reasons.join(', '),
      source: 'heuristic',
    };
  }

  if (score >= 3) {
    return {
      scope: 'project',
      reason: reasons.join(', '),
      source: 'heuristic',
    };
  }

  return {
    scope: 'private',
    reason: reasons.join(', '),
    source: 'heuristic',
  };
}

export function buildMemoryPolicy(input: MemoryPolicyContext): MemoryPolicy {
  const recommendation = recommendMemoryScope(input);
  const currentScope = input.visibilityScope ?? 'private';
  const history = extractPolicyHistory(input);

  return {
    captureMode: 'private-first',
    currentScope,
    audience: classifyAudience(currentScope),
    shared: currentScope !== 'private',
    reason: recommendation.reason,
    recommendation,
    history,
    reviewState: currentScope === recommendation.scope ? 'promoted' : 'suggested',
    lastReviewedAt: new Date().toISOString(),
  };
}

export function extractMemoryPolicy(metadata: Record<string, unknown> | null | undefined): MemoryPolicy | null {
  if (!metadata) return null;
  const policy = (metadata as Record<string, unknown>).memoryPolicy;
  if (!policy || typeof policy !== 'object') return null;

  const currentScope = isVisibilityScope((policy as any).currentScope)
    ? (policy as any).currentScope
    : 'private';
  const recommendationScope = isVisibilityScope((policy as any).recommendation?.scope)
    ? (policy as any).recommendation.scope
    : currentScope;

  return {
    captureMode: 'private-first',
    currentScope,
    audience: classifyAudience(currentScope),
    shared: currentScope !== 'private',
    reason: typeof (policy as any).reason === 'string' ? (policy as any).reason : '',
    recommendation: {
      scope: recommendationScope,
      reason: typeof (policy as any).recommendation?.reason === 'string'
        ? (policy as any).recommendation.reason
        : '',
      source: isMemoryPolicySource((policy as any).recommendation?.source)
        ? (policy as any).recommendation.source
        : 'heuristic',
    },
    history: Array.isArray((policy as any).history)
      ? (policy as any).history.filter(isPolicyHistoryEntry)
      : [],
    reviewState: isMemoryPolicyReviewState((policy as any).reviewState)
      ? (policy as any).reviewState
      : 'suggested',
    lastReviewedAt: typeof (policy as any).lastReviewedAt === 'string'
      ? (policy as any).lastReviewedAt
      : new Date().toISOString(),
  };
}

export function annotateMemoryMetadata(
  metadata: Record<string, unknown> | null | undefined,
  policy: MemoryPolicy,
): Record<string, unknown> {
  const base = metadata ? { ...metadata } : {};
  const existing = extractMemoryPolicy(base);
  const history = policy.history.length > 0 ? policy.history : (existing?.history ?? []);

  base.memoryPolicy = {
    ...policy,
    history,
  };

  return base;
}

export async function promoteMemoryVisibility(
  memoryId: string,
  scope: VisibilityScope,
  reason: string,
  teamId?: string,
): Promise<MemoryPolicyUpdateResult | null> {
  try {
    const { db, schema } = await getDbClient();
    const rows = await db.select().from(schema.memories).where(eq(schema.memories.id, memoryId)).limit(1);
    const row = rows[0];
    if (!row) return null;

    const currentMetadata = deserializeMetadata(row.metadata ?? null) ?? {};
    const currentPolicy = extractMemoryPolicy(currentMetadata) ?? buildMemoryPolicy({
      visibilityScope: row.visibilityScope ?? 'private',
      content: row.content ?? '',
      type: row.type,
      accessCount: row.accessCount ?? 0,
      usageCount: row.usageCount ?? 0,
      isPinned: row.isPinned ?? false,
      importanceScore: row.importanceScore ?? row.importance_score ?? 0,
    });

    const now = new Date().toISOString();
    const nextPolicy: MemoryPolicy = {
      ...currentPolicy,
      currentScope: scope,
      audience: classifyAudience(scope),
      shared: scope !== 'private',
      reason,
      recommendation: {
        scope,
        reason,
        source: 'manual',
      },
      history: [
        ...currentPolicy.history,
        {
          from: currentPolicy.currentScope,
          to: scope,
          reason,
          at: now,
        },
      ],
      reviewState: scope === 'private' ? 'demoted' : 'promoted',
      lastReviewedAt: now,
    };

    const nextMetadata = annotateMemoryMetadata(currentMetadata, nextPolicy);
    await db.update(schema.memories).set({
      visibilityScope: scope,
      readScope: serializeVisibilityScopes(buildVisibilityScopes(scope, row.userId ? 'user' : 'agent', row.userId ?? row.agentId ?? undefined, teamId).readScope),
      writeScope: serializeVisibilityScopes(buildVisibilityScopes(scope, row.userId ? 'user' : 'agent', row.userId ?? row.agentId ?? undefined, teamId).writeScope),
      metadata: serializeMetadata(nextMetadata),
      updatedAt: new Date(),
    }).where(eq(schema.memories.id, memoryId));

    return {
      memoryId,
      visibilityScope: scope,
      policy: nextPolicy,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to update memory visibility for ${memoryId}`, { error: msg });
    return null;
  }
}

function extractPolicyHistory(input: MemoryPolicyContext): MemoryPolicyHistoryEntry[] {
  const maybeMetadata = input as MemoryPolicyContext & { metadata?: unknown };
  const raw = maybeMetadata.metadata;
  if (!raw || typeof raw !== 'object') return [];
  const policy = (raw as Record<string, unknown>).memoryPolicy;
  if (!policy || typeof policy !== 'object') return [];
  const history = (policy as any).history;
  if (!Array.isArray(history)) return [];
  return history.filter(isPolicyHistoryEntry);
}

function isVisibilityScope(value: unknown): value is VisibilityScope {
  return value === 'private' || value === 'project' || value === 'team' || value === 'global';
}

function isMemoryPolicySource(value: unknown): value is MemoryPolicySource {
  return value === 'explicit' || value === 'heuristic' || value === 'manual';
}

function isMemoryPolicyReviewState(value: unknown): value is MemoryPolicyReviewState {
  return value === 'suggested' || value === 'promoted' || value === 'demoted';
}

function isPolicyHistoryEntry(value: unknown): value is MemoryPolicyHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return isVisibilityScope(entry.from)
    && isVisibilityScope(entry.to)
    && typeof entry.reason === 'string'
    && typeof entry.at === 'string';
}
