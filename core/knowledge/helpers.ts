/**
 * Shared helpers for knowledge modules.
 *
 * Serialization, deserialization, and DB-row → typed-object mappers.
 * These are consumed by knowledge-crud, knowledge-edges, and knowledge-beliefs.
 */

import type {
  Knowledge,
  KnowledgeKind,
  KnowledgeType,
  KnowledgeStatus,
  KnowledgeEdge,
  EdgeNodeKind,
} from './types.js';

// ─── Serialization ───────────────────────────────────────────────────────────

export function serializeJson(obj: Record<string, unknown> | null | undefined): string | null {
  if (!obj) return null;
  return JSON.stringify(obj);
}

export function deserializeJson<T>(str: string | null | undefined): T | null {
  if (!str) return null;
  try { return JSON.parse(str) as T; } catch { return null; }
}

// ─── Row Mappers ─────────────────────────────────────────────────────────────

export function toKnowledge(row: any): Knowledge {
  const value = (snake: string, camel: string) => row[camel] ?? row[snake];
  const metadata = value('metadata', 'metadata');
  const parseMetadata = (v: unknown) => {
    if (v && typeof v === 'object') return v as Record<string, unknown>;
    return deserializeJson<Record<string, unknown>>(v as string | null | undefined);
  };
  const createdAt = value('created_at', 'createdAt');
  const updatedAt = value('updated_at', 'updatedAt');
  return {
    id: row.id,
    projectId: value('project_id', 'projectId') ?? null,
    userId: value('user_id', 'userId') ?? null,
    agentId: value('agent_id', 'agentId') ?? null,
    sessionId: value('session_id', 'sessionId') ?? null,
    knowledgeKind: value('knowledge_kind', 'knowledgeKind') as KnowledgeKind,
    knowledgeType: value('knowledge_type', 'knowledgeType') as KnowledgeType,
    content: row.content,
    summary: row.summary ?? null,
    embeddingJson: value('embedding_json', 'embeddingJson') ?? null,
    embedding: row.embedding ?? null,
    confidence: row.confidence ?? 0.5,
    confidenceLevel: value('confidence_level', 'confidenceLevel') ?? 'certain',
    importanceScore: value('importance_score', 'importanceScore') ?? 0.5,
    importanceDecayRate: value('importance_decay_rate', 'importanceDecayRate') ?? 30,
    lastImportanceRecalc: value('last_importance_recalc', 'lastImportanceRecalc') ?? null,
    normalizedKey: value('normalized_key', 'normalizedKey') ?? null,
    reason: row.reason ?? null,
    evidenceSummary: value('evidence_summary', 'evidenceSummary') ?? null,
    lastConfirmedAt: value('last_confirmed_at', 'lastConfirmedAt') ?? null,
    sourceCount: value('source_count', 'sourceCount') ?? 1,
    title: row.title ?? null,
    description: row.description ?? null,
    steps: row.steps ?? null,
    successCriteria: value('success_criteria', 'successCriteria') ?? null,
    failureIndicators: value('failure_indicators', 'failureIndicators') ?? null,
    usageCount: value('usage_count', 'usageCount') ?? 0,
    successCount: value('success_count', 'successCount') ?? 0,
    failureCount: value('failure_count', 'failureCount') ?? 0,
    lastUsedAt: value('last_used_at', 'lastUsedAt') ?? null,
    lastSuccessAt: value('last_success_at', 'lastSuccessAt') ?? null,
    lastFailureAt: value('last_failure_at', 'lastFailureAt') ?? null,
    status: row.status as KnowledgeStatus ?? 'active',
    supersededBy: value('superseded_by', 'supersededBy') ?? null,
    contradictsId: value('contradicts_id', 'contradictsId') ?? null,
    informedById: value('informed_by_id', 'informedById') ?? null,
    tags: row.tags ?? null,
    metadata: parseMetadata(metadata),
    placeId: value('place_id', 'placeId') ?? null,
    primaryPlace: value('primary_place', 'primaryPlace') ?? null,
    sector: row.sector ?? 'general',
    tier: row.tier ?? 'episodic',
    isActive: value('is_active', 'isActive') ?? 1,
    createdAt: createdAt instanceof Date ? createdAt : new Date(Number(createdAt ?? 0) * 1000),
    updatedAt: updatedAt instanceof Date ? updatedAt : new Date(Number(updatedAt ?? 0) * 1000),
  };
}

export function toKnowledgeEdge(row: any): KnowledgeEdge {
  return {
    id: row.id,
    fromId: row.from_id,
    fromKind: row.from_kind as EdgeNodeKind,
    toId: row.to_id,
    toKind: row.to_kind as EdgeNodeKind,
    edgeType: row.edge_type,
    weight: row.weight ?? 1.0,
    metadata: deserializeJson(row.metadata),
    createdAt: new Date((row.created_at ?? 0) * 1000),
  };
}
