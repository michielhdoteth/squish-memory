import { resolve, join } from 'node:path';
import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { closeAllDbs, getDb } from '../../db/index.js';
import { getDbClient } from '../lib/db-client.js';
import { probeSchemaHealth, type SchemaProbeResult } from '../../db/schema-probe.js';
import { config, getDataDir } from '../../config.js';
import type { SearchResult } from '../memory/memory-types.js';

/**
 * Stable request/response boundary for desktop hosts that bootstrap the local
 * database through the installed Squish runtime instead of owning its schema.
 * Increment only when the request or response contract changes incompatibly.
 */
export const DESKTOP_BOOTSTRAP_CONTRACT_VERSION = 1 as const;

export type DesktopBootstrapErrorCode =
  | 'unsupported_contract_version'
  | 'local_sqlite_required'
  | 'schema_not_ready'
  | 'invalid_request';

export class DesktopBootstrapError extends Error {
  constructor(
    readonly code: DesktopBootstrapErrorCode,
    message: string,
    readonly supportedContractVersions: readonly number[] = [DESKTOP_BOOTSTRAP_CONTRACT_VERSION],
  ) {
    super(message);
    this.name = 'DesktopBootstrapError';
  }
}

export interface DesktopBootstrapRequest {
  contractVersion: number;
}

export interface DesktopBootstrapResult {
  ok: true;
  contractVersion: typeof DESKTOP_BOOTSTRAP_CONTRACT_VERSION;
  backend: 'sqlite';
  schemaReady: true;
  dataDir: string;
  databasePath: string;
}

export interface DesktopReviewedCompactionRequest {
  contractVersion: number;
  sourceMemoryId: string;
  compactedContent: string;
  modelId: string;
  promptVersion: string;
}

export interface DesktopRecallRequest {
  contractVersion: number;
  query: string;
  limit?: number;
}

export type DesktopWorkspaceRequest =
  | { contractVersion: number; action: 'list' }
  | { contractVersion: number; action: 'graph'; limit?: number }
  | { contractVersion: number; action: 'create-profile'; projectId: string; title: string; description?: string }
  | { contractVersion: number; action: 'update-profile'; id: string; title?: string; description?: string; content?: string }
  | { contractVersion: number; action: 'delete-profile'; id: string }
  | { contractVersion: number; action: 'prepare-profile-refresh'; id: string }
  | { contractVersion: number; action: 'apply-profile-refresh'; id: string; content: string; sources: Array<{ id: string; content: string }> };

/** Local desktop workspace operations backed by Squish's canonical core services. */
export async function operateDesktopWorkspace(request: DesktopWorkspaceRequest) {
  if (request.contractVersion !== DESKTOP_BOOTSTRAP_CONTRACT_VERSION) {
    throw new DesktopBootstrapError('unsupported_contract_version', `Unsupported desktop runtime contract version ${String(request.contractVersion)}.`);
  }
  if (!config.isLocalMode) throw new DesktopBootstrapError('local_sqlite_required', 'Desktop workspace operations support the local SQLite runtime only.');

  if (request.action === 'graph') {
    const limit = Number.isInteger(request.limit) ? Math.max(1, Math.min(5000, request.limit!)) : 2000;
    try {
      const { db, schema, raw } = await getDbClient();
      const [memoryRowsRaw, entityRowsRaw, projectRowsRaw, knowledgeRowsRaw] = await Promise.all([
        db.select().from(schema.memories)
          .where(eq(schema.memories.isActive, true))
          .orderBy(desc(schema.memories.importanceScore))
          .limit(limit),
        db.select().from(schema.entities)
          .orderBy(desc(schema.entities.mentionCount))
          .limit(5000),
        db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects),
        db.select({ id: schema.knowledge.id, metadata: schema.knowledge.metadata })
          .from(schema.knowledge)
          .where(and(
            eq(schema.knowledge.knowledgeKind, 'memory'),
            eq(schema.knowledge.isActive, true),
            eq(schema.knowledge.status, 'active'),
          ))
          .limit(10_000),
      ]);
      const memoryRows = memoryRowsRaw as Array<typeof schema.memories.$inferSelect>;
      const entityRows = entityRowsRaw as Array<typeof schema.entities.$inferSelect>;
      const projectRows = projectRowsRaw as Array<{ id: string; name: string }>;
      const knowledgeRows = knowledgeRowsRaw as Array<{ id: string; metadata: unknown }>;
      const projectNames = new Map(projectRows.map((project) => [project.id, safeProjectDisplayName(project.name)]));
      const memoriesById = new Map(memoryRows.map((memory) => [memory.id, memory]));
      const nodes: Array<{
        id: string;
        label: string;
        type: 'memory' | 'entity';
        memoryType?: string;
        entityType?: string;
        sector?: string | null;
        tags?: string[];
        projectId: string | null;
        projectName: string | null;
        val: number;
        color: string;
      }> = memoryRows.map((memory) => ({
        id: memory.id,
        label: memory.summary?.trim() || memory.content.slice(0, 100),
        type: 'memory' as const,
        memoryType: memory.type,
        sector: memory.sector ?? null,
        tags: graphTags(memory.tags),
        projectId: memory.projectId ?? null,
        projectName: memory.projectId ? projectNames.get(memory.projectId) ?? 'Project' : null,
        val: Math.max((memory.importanceScore ?? 50) / 20, 2),
        color: graphMemoryColor(memory.type),
      }));
      const memoryIds = new Set(memoryRows.map((memory) => memory.id));
      const memoryByImportKey = new Map<string, string>();
      for (const memory of memoryRows) {
        const importKey = parseGraphMetadata(memory.metadata)?.workspaceMemoryImport;
        if (importKey && typeof importKey === 'object' && 'sourceKey' in importKey
          && typeof importKey.sourceKey === 'string' && importKey.sourceKey.trim()) {
          memoryByImportKey.set(importKey.sourceKey, memory.id);
        }
      }
      const memoryIdByKnowledgeId = new Map<string, string>();
      for (const knowledge of knowledgeRows) {
        if (memoryIds.has(knowledge.id)) {
          memoryIdByKnowledgeId.set(knowledge.id, knowledge.id);
          continue;
        }
        const metadata = parseGraphMetadata(knowledge.metadata);
        if (typeof metadata?.sourceMemoryId === 'string' && memoryIds.has(metadata.sourceMemoryId)) {
          memoryIdByKnowledgeId.set(knowledge.id, metadata.sourceMemoryId);
          continue;
        }
        const importKey = metadata?.workspaceMemoryImport;
        if (importKey && typeof importKey === 'object' && 'sourceKey' in importKey
          && typeof importKey.sourceKey === 'string') {
          const memoryId = memoryByImportKey.get(importKey.sourceKey);
          if (memoryId) memoryIdByKnowledgeId.set(knowledge.id, memoryId);
        }
      }
      const entitiesByName = new Map<string, typeof entityRows>();
      const entitiesById = new Map(entityRows.map((entity) => [entity.id, entity]));
      for (const entity of entityRows) {
        const key = entity.name.trim().toLocaleLowerCase();
        const matchingEntities = entitiesByName.get(key);
        if (matchingEntities) matchingEntities.push(entity);
        else entitiesByName.set(key, [entity]);
      }
      const linkedEntityIds = new Set<string>();
      const links: Array<{ source: string; target: string; label: string; weight: number }> = [];
      const memoryEntityLinkKeys = new Set<string>();
      const addMemoryEntityLink = (source: string, target: string, label: string, weight: number) => {
        const key = `${source}\u0000${target}\u0000${label}`;
        if (memoryEntityLinkKeys.has(key)) return;
        memoryEntityLinkKeys.add(key);
        linkedEntityIds.add(target);
        links.push({ source, target, label, weight });
      };
      for (const memory of memoryRows) {
        const metadata = parseGraphMetadata(memory.metadata);
        const names = Array.isArray(metadata?.entities) ? metadata.entities : [];
        for (const name of names) {
          if (typeof name !== 'string') continue;
          const matches = entitiesByName.get(name.trim().toLocaleLowerCase()) ?? [];
          const entity = matches.find((candidate) => candidate.projectId === memory.projectId);
          if (!entity) continue;
          addMemoryEntityLink(memory.id, entity.id, 'mentions', 1.5);
        }
      }

      const sqlite = (raw as { $client?: { prepare?: (sql: string) => { all: (...params: unknown[]) => Array<Record<string, unknown>> } } }).$client;
      if (sqlite?.prepare && memoryRows.length > 0) {
        try {
          const associations = sqlite.prepare(`
            SELECT association.from_memory_id AS source, association.to_memory_id AS target,
                   association.association_type AS label, association.weight
            FROM memory_associations AS association
            JOIN memories AS source_memory ON source_memory.id = association.from_memory_id AND source_memory.is_active = 1
            JOIN memories AS target_memory ON target_memory.id = association.to_memory_id AND target_memory.is_active = 1
            ORDER BY association.weight DESC, association.last_coactivated_at DESC LIMIT 1500
          `).all();
          for (const association of associations) {
            if (typeof association.source === 'string' && typeof association.target === 'string'
              && memoryIds.has(association.source) && memoryIds.has(association.target)) {
              links.push({
                source: association.source,
                target: association.target,
                label: typeof association.label === 'string' ? association.label : 'related',
                weight: typeof association.weight === 'number' ? association.weight : 1,
              });
            }
          }
        } catch {
          // Older local databases may not include the legacy association table.
        }
      }

      const now = new Date();
      const relationEdges = await db.select().from(schema.knowledgeEdges).where(and(
        eq(schema.knowledgeEdges.fromKind, 'entity'),
        eq(schema.knowledgeEdges.toKind, 'entity'),
        or(isNull(schema.knowledgeEdges.validFrom), lte(schema.knowledgeEdges.validFrom, now)),
        or(isNull(schema.knowledgeEdges.validTo), gt(schema.knowledgeEdges.validTo, now)),
        lte(schema.knowledgeEdges.recordedAt, now),
        or(isNull(schema.knowledgeEdges.recordedTo), gt(schema.knowledgeEdges.recordedTo, now)),
      )).orderBy(desc(schema.knowledgeEdges.weight)).limit(5000);
      for (const edge of relationEdges) {
        const fromEntity = entitiesById.get(edge.fromId);
        const toEntity = entitiesById.get(edge.toId);
        if (!fromEntity || !toEntity || fromEntity.projectId !== toEntity.projectId) continue;
        linkedEntityIds.add(edge.fromId);
        linkedEntityIds.add(edge.toId);
        if (edge.edgeType !== 'mentioned_before') {
          links.push({ source: edge.fromId, target: edge.toId, label: edge.edgeType, weight: edge.weight ?? 1 });
        }
        const sourceMemoryIds = parseGraphMetadata(edge.metadata)?.sourceMemoryIds;
        if (!Array.isArray(sourceMemoryIds)) continue;
        for (const sourceMemoryId of sourceMemoryIds) {
          if (typeof sourceMemoryId !== 'string') continue;
          const memory = memoriesById.get(sourceMemoryId);
          if (!memory || memory.projectId !== fromEntity.projectId) continue;
          addMemoryEntityLink(memory.id, fromEntity.id, 'mentions', 1.5);
          addMemoryEntityLink(memory.id, toEntity.id, 'mentions', 1.5);
        }
      }
      const knowledgeEntityEdges = await db.select().from(schema.knowledgeEdges).where(and(
        or(
          and(eq(schema.knowledgeEdges.fromKind, 'knowledge'), eq(schema.knowledgeEdges.toKind, 'entity')),
          and(eq(schema.knowledgeEdges.fromKind, 'entity'), eq(schema.knowledgeEdges.toKind, 'knowledge')),
        ),
        or(isNull(schema.knowledgeEdges.validFrom), lte(schema.knowledgeEdges.validFrom, now)),
        or(isNull(schema.knowledgeEdges.validTo), gt(schema.knowledgeEdges.validTo, now)),
        lte(schema.knowledgeEdges.recordedAt, now),
        or(isNull(schema.knowledgeEdges.recordedTo), gt(schema.knowledgeEdges.recordedTo, now)),
      )).orderBy(desc(schema.knowledgeEdges.weight)).limit(10_000);
      for (const edge of knowledgeEntityEdges) {
        const entityId = edge.fromKind === 'entity' ? edge.fromId : edge.toId;
        const knowledgeId = edge.fromKind === 'knowledge' ? edge.fromId : edge.toId;
        const memoryId = memoryIdByKnowledgeId.get(knowledgeId);
        const memory = memoryId ? memoriesById.get(memoryId) : undefined;
        const entity = entitiesById.get(entityId);
        if (!memory || !entity || memory.projectId !== entity.projectId) continue;
        addMemoryEntityLink(memory.id, entityId, edge.edgeType, edge.weight ?? 1);
      }
      for (const entity of entityRows) {
        if (!linkedEntityIds.has(entity.id)) continue;
        nodes.push({
          id: entity.id,
          label: entity.name,
          type: 'entity',
          entityType: entity.type,
          projectId: entity.projectId ?? null,
          projectName: entity.projectId ? projectNames.get(entity.projectId) ?? 'Project' : null,
          val: Math.max((entity.mentionCount ?? 1) * 2, 2),
          color: '#6366F1',
        });
      }
      return { ok: true as const, contractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION, operation: 'desktop-workspace' as const, nodes, links };
    } finally {
      await closeAllDbs();
    }
  }

  if (request.action === 'list') {
    const { getAllProjects } = await import('../projects.js');
    const { listMentalModels } = await import('../knowledge/mental-models.js');
    const { searchKnowledge } = await import('../knowledge/knowledge-crud.js');
    const projects = (await getAllProjects()).slice(0, 250);
    const profiles = [];
    const knowledge = [];
    for (const project of projects) {
      if (profiles.length < 100) profiles.push(...(await listMentalModels(project.id)).slice(0, 100 - profiles.length));
      if (knowledge.length < 250) knowledge.push(...await searchKnowledge({ projectId: project.id, limit: Math.min(50, 250 - knowledge.length) }));
    }
    return {
      ok: true as const,
      contractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION,
      operation: 'desktop-workspace' as const,
      projects: projects.map(({ id, name, path, description, metadata }) => ({ id, name, path, description, metadata })),
      profiles: profiles.map((profile) => ({ ...profile, content: profile.content.slice(0, 8000) })),
      knowledge: knowledge.map((record) => ({
        ...record,
        content: record.content.slice(0, 2500),
        summary: record.summary?.slice(0, 800) ?? null,
      })),
    };
  }

  const { createMentalModel, updateMentalModel, deleteMentalModel } = await import('../knowledge/mental-models.js');
  if (request.action === 'prepare-profile-refresh') {
    if (typeof request.id !== 'string' || !request.id) throw new DesktopBootstrapError('invalid_request', 'A profile id is required.');
    const { prepareMentalModelRefresh } = await import('../knowledge/mental-models.js');
    const prepared = await prepareMentalModelRefresh(request.id);
    return { ok: true as const, contractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION, operation: 'desktop-workspace' as const, prepared };
  }
  if (request.action === 'apply-profile-refresh') {
    if (typeof request.id !== 'string' || !request.id || typeof request.content !== 'string' || request.content.length > 16_000
      || !Array.isArray(request.sources) || request.sources.length > 40
      || request.sources.some((source) => !source || typeof source.id !== 'string' || typeof source.content !== 'string')) {
      throw new DesktopBootstrapError('invalid_request', 'The prepared profile update is invalid.');
    }
    const { applyPreparedMentalModelRefresh } = await import('../knowledge/mental-models.js');
    const profile = await applyPreparedMentalModelRefresh(request.id, request.content, request.sources);
    return { ok: true as const, contractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION, operation: 'desktop-workspace' as const, profile };
  }
  if (request.action === 'create-profile') {
    const projectId = typeof request.projectId === 'string' ? request.projectId.trim() : '';
    const title = typeof request.title === 'string' ? request.title.trim() : '';
    const description = request.description ?? '';
    if (!projectId || !title || title.length > 160 || typeof description !== 'string' || description.length > 1000) {
      throw new DesktopBootstrapError('invalid_request', 'A project and profile title (up to 160 characters) are required.');
    }
    const profile = await createMentalModel({ projectId, title, description });
    return { ok: true as const, contractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION, operation: 'desktop-workspace' as const, profile };
  }
  if (request.action === 'update-profile') {
    if (typeof request.id !== 'string' || !request.id
      || (request.title !== undefined && (typeof request.title !== 'string' || !request.title.trim() || request.title.length > 160))
      || (request.description !== undefined && (typeof request.description !== 'string' || request.description.length > 1000))
      || (request.content !== undefined && (typeof request.content !== 'string' || request.content.length > 8000))) {
      throw new DesktopBootstrapError('invalid_request', 'The profile update is invalid or too large.');
    }
    const profile = await updateMentalModel(request.id, {
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.content !== undefined ? { content: request.content } : {}),
    });
    return { ok: true as const, contractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION, operation: 'desktop-workspace' as const, profile };
  }
  if (request.action === 'delete-profile') {
    if (typeof request.id !== 'string' || !request.id) throw new DesktopBootstrapError('invalid_request', 'A profile id is required.');
    const deleted = await deleteMentalModel(request.id);
    return { ok: true as const, contractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION, operation: 'desktop-workspace' as const, deleted };
  }
  throw new DesktopBootstrapError('invalid_request', 'Unknown desktop workspace operation.');
}

function graphTags(value: unknown): string[] {
  let tags = value;
  for (let depth = 0; depth < 3 && typeof tags === 'string'; depth += 1) {
    try { tags = JSON.parse(tags); } catch { tags = [tags]; break; }
  }
  const values: unknown[] = Array.isArray(tags) ? tags.flat(Infinity) as unknown[] : typeof tags === 'string' ? tags.split(',') : [];
  const seen = new Set<string>();
  return values
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter((tag) => {
      const key = tag.toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function safeProjectDisplayName(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]+/).filter(Boolean).at(-1) || 'Project';
}

function parseGraphMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'string') return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function graphMemoryColor(type: string): string {
  const colors: Record<string, string> = {
    observation: '#60A5FA', fact: '#34D399', decision: '#FBBF24',
    context: '#A78BFA', preference: '#F472B6', note: '#94A3B8',
  };
  return colors[type] ?? '#6B7280';
}

export async function recallDesktopMemories(request: DesktopRecallRequest) {
  if (request.contractVersion !== DESKTOP_BOOTSTRAP_CONTRACT_VERSION) {
    throw new DesktopBootstrapError('unsupported_contract_version', `Unsupported desktop runtime contract version ${String(request.contractVersion)}.`);
  }
  if (!config.isLocalMode) {
    throw new DesktopBootstrapError('local_sqlite_required', 'Desktop memory recall supports the local SQLite runtime only.');
  }
  const query = typeof request.query === 'string' ? request.query.trim() : '';
  if (!query || query.length > 2000) {
    throw new DesktopBootstrapError('invalid_request', 'Recall query must contain 1 to 2,000 characters.');
  }
  const limit = Number.isInteger(request.limit) ? Math.max(1, Math.min(100, request.limit!)) : 8;
  try {
    const { search } = await import('../memory/memory-search.js');
    const results: SearchResult[] = await search({ query, limit });
    return {
      ok: true as const,
      contractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION,
      operation: 'memory-recall' as const,
      results: results.map((memory) => ({
        id: memory.id,
        type: memory.type,
        content: memory.content,
        summary: memory.summary ?? null,
        tags: memory.tags ?? [],
        createdAt: memory.createdAt ?? null,
        projectId: memory.projectId ?? null,
        similarity: memory.similarity ?? null,
        recallConfidence: memory.recallConfidence ?? null,
      })),
    };
  } finally {
    await closeAllDbs();
  }
}

function describeProbeFailure(probe: SchemaProbeResult): string {
  return [
    probe.detail,
    ...probe.missingTables.map((table) => `missing table ${table}`),
    ...probe.missingColumns.map(({ table, column }) => `missing column ${table}.${column}`),
    ...probe.indexIssues.map(({ name, reason }) => `${reason} index ${name}`),
  ].join('; ');
}

/**
 * Explicitly initialize or migrate Squish's local SQLite database through the
 * core storage adapter, then close the handle before returning to the host.
 * This function is intended to run in a dedicated bootstrap process.
 */
export async function bootstrapDesktopRuntime(
  request: DesktopBootstrapRequest,
): Promise<DesktopBootstrapResult> {
  if (request.contractVersion !== DESKTOP_BOOTSTRAP_CONTRACT_VERSION) {
    throw new DesktopBootstrapError(
      'unsupported_contract_version',
      `Unsupported desktop bootstrap contract version ${String(request.contractVersion)}.`,
    );
  }

  if (!config.isLocalMode) {
    throw new DesktopBootstrapError(
      'local_sqlite_required',
      'Desktop bootstrap supports the local SQLite runtime only; team database mode is not supported.',
    );
  }

  const dataDir = resolve(getDataDir());
  const databasePath = join(dataDir, 'squish.db');

  try {
    // getDb delegates schema creation and forward migrations to the canonical
    // SQLite adapter. This API intentionally does not copy or duplicate DDL.
    await getDb();
    const probe = await probeSchemaHealth();
    if (probe.status !== 'ok') {
      throw new DesktopBootstrapError(
        'schema_not_ready',
        `Squish could not prepare a usable local database: ${describeProbeFailure(probe)}`,
      );
    }

    return {
      ok: true,
      contractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION,
      backend: 'sqlite',
      schemaReady: true,
      dataDir,
      databasePath,
    };
  } finally {
    await closeAllDbs();
  }
}

/** Persist an explicitly reviewed compaction through the canonical memory writer. */
export async function applyDesktopReviewedCompaction(
  request: DesktopReviewedCompactionRequest,
) {
  if (request.contractVersion !== DESKTOP_BOOTSTRAP_CONTRACT_VERSION) {
    throw new DesktopBootstrapError(
      'unsupported_contract_version',
      `Unsupported desktop runtime contract version ${String(request.contractVersion)}.`,
    );
  }
  if (!config.isLocalMode) {
    throw new DesktopBootstrapError(
      'local_sqlite_required',
      'Desktop memory compaction supports the local SQLite runtime only.',
    );
  }

  try {
    const { applyReviewedMemoryCompaction } = await import('../memory/consolidation.js');
    const result = await applyReviewedMemoryCompaction(request);
    return {
      ok: true as const,
      contractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION,
      operation: 'reviewed-compaction' as const,
      ...result,
    };
  } finally {
    await closeAllDbs();
  }
}
