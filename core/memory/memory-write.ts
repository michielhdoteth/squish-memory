/**
 * Memory write operations.
 *
 * Handles the complex rememberMemory flow: embedding, importance scoring,
 * belief extraction, graph sync, contradiction resolution, place assignment,
 * and post-capture geometry checks.
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { logger } from '../logger.js';
import { getOrCreateProject } from '../../core/projects.js';
import { getEmbedding, activeEmbeddingModel } from '../../core/embeddings.js';
import { enrichContent } from '../retrieval/contextual-enrichment.js';
import { normalizeTags, serializeTags, serializeMetadata } from '../../core/memory/serialization.js';
import { prepareEmbedding } from '../lib/utils.js';
import { validateUuid } from '../lib/validation.js';
import { detectMemorySignals } from './trigger-detector.js';
import { applySupersession, resolveContradictions } from './contradiction-resolver.js';
import { encrypt } from '../security/encrypt.js';
import { estimateTokens } from '../context/context-window.js';
import { getDbClient } from '../lib/db-client.js';
import { extractBeliefs } from '../knowledge/extractor.js';
import { upsertBeliefsForMemory, createKnowledge, createKnowledgeEdge } from '../knowledge/store.js';
import { extractConversationStrats } from '../knowledge/extractor.js';
import type { CreateKnowledgeInput } from '../knowledge/types.js';
import { buildMemoryPolicy, buildVisibilityScopes, serializeVisibilityScopes, recommendMemoryScope } from './policy.js';
import { onMemoryStored } from '../graph/incremental-sync.js';
import { parseEmbedding } from '../lib/parse-embedding.js';
import { findOrCreateCluster, updateClusterStats } from '../clustering/cluster-engine.js';
import { evaluateCluster } from '../clustering/consolidation-check.js';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { withBusyRetry } from '../../db/busy-retry.js';
import { computeInitialImportance } from './importance.js';
import { normalizeMemoryRecord, getOrCreateUser } from './memory-crud.js';
import { emit } from '../event-bus.js';
// Batch 7: every durable write feeds the session working set so wake-up
// summaries reflect real project activity.
import { recordSessionSignal } from '../session/working-set.js';
// Batch 6b: signals-based sector classification (episodic|semantic|procedural|reflective).
import { routeSector } from './sector-router.js';
import type { RememberInput, MemoryRecord, VisibilityScope } from './memory-types.js';

// ---------------------------------------------------------------------------
// rememberMemory — the main write path
// ---------------------------------------------------------------------------

export async function rememberMemory(input: RememberInput): Promise<MemoryRecord> {
  const { db, schema } = await getDbClient();
  const tags = normalizeTags(input.tags);
  const project = input.project ? await getOrCreateProject(input.project) : null;
  const accessUser = input.user;
  // Enrich content for embedding when contextual retrieval is enabled
  // The database stores original content; enriched version is only for embedding
  const enriched = enrichContent(input.content, {
    type: input.type,
    project: input.project,
    tags: tags,
  });
  const embedding = await getEmbedding(enriched.enriched);
  const id = randomUUID();
  const signals = detectMemorySignals(input.content);
  const type = input.type ?? signals.suggestedType;
  // Batch 6b: route sector once from signals (type + tags + content + provenance).
  // An explicit input.sector override wins; default episodic.
  const now = new Date();
  const sector = routeSector(
    {
      type,
      tags,
      content: input.content,
      knowledgeKind: 'memory',
      source: (input.metadata?.source as string | undefined) ?? input.source ?? null,
    },
    (input as { sector?: string | null }).sector ?? null
  );
  // Batch 6b: bi-temporal fields - validFrom defaults to write time unless
  // explicitly provided; recordedAt is always the write time.
  const validFromDate = input.validFrom ? new Date(input.validFrom) : now;
  // Team-scoped memories use 'team' scope; everything else defaults to 'project'
  const visibilityScope: VisibilityScope = input.teamId ? 'team' : 'project';
  const policyRecommendation = recommendMemoryScope({
    content: input.content,
    type,
    tags,
    visibilityScope,
    importanceScore: 0,
    accessCount: 0,
    usageCount: 0,
    isPinned: false,
    signals,
    teamId: input.teamId,
  });
  const memoryPolicy = buildMemoryPolicy({
    content: input.content,
    type,
    tags,
    visibilityScope,
    importanceScore: 0,
    accessCount: 0,
    usageCount: 0,
    isPinned: false,
    signals,
    teamId: input.teamId,
  });
  memoryPolicy.recommendation = policyRecommendation;
  const readWriteScopes = buildVisibilityScopes(visibilityScope, 'user', accessUser, input.teamId);
  const serializedReadScope = serializeVisibilityScopes(readWriteScopes.readScope);
  const serializedWriteScope = serializeVisibilityScopes(readWriteScopes.writeScope);

  const baseValues = {
    id,
    projectId: project?.id ?? null,
    type,
    content: input.content,
    source: input.source ?? 'mcp',
    visibilityScope,
  };

  // Calculate initial importance score (3-factor pipeline)
  const importance = computeInitialImportance({
    content: input.content,
    type,
    createdAt: new Date().toISOString(),
    accessCount: 0,
    usageCount: 0,
    isPinned: false,
    isProtected: false,
    isImmutable: false,
  });

  // Batch 4: L2-normalized float32 blob (primary) + JSON compat + model stamp
  const embeddingValues = prepareEmbedding(embedding, { model: activeEmbeddingModel() });

  const tokensEstimate = estimateTokens(input.content);

  let tagsValue = serializeTags(tags);
  const enrichedMetadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    // Rich context fields (Agent 4 feedback)
    reasoning: input.reasoning,
    memoryContext: input.memoryContext,
    examples: input.examples,
    exceptions: input.exceptions,
    memorySignals: {
      explicitTriggers: signals.explicitTriggers,
      implicit: signals.implicit,
      priority: signals.priority,
      requiresConflictCheck: signals.implicit.correction,
    },
    // Session metadata for temporal queries (Task 1)
    sessionMetadata: {
      sessionId: input.sessionId,
      sessionStartTime: input.sessionStartTime,
      toolName: input.toolName,
    },
  };
  enrichedMetadata.memoryPolicy = memoryPolicy;
  let metadataValue = serializeMetadata(enrichedMetadata);

  // Prepare fields for insertion, handling optional encryption
  let insertValues: any = {
    ...baseValues,
    tags: tagsValue,
    metadata: metadataValue,
    ...embeddingValues,
    importanceScore: importance.score,
    lastImportanceRecalc: new Date(),
    tokensEstimate,
    createdAt: new Date(),
    status: 'active',
    visibilityScope,
    readScope: serializedReadScope,
    writeScope: serializedWriteScope,
    // Batch 6b: routed sector + bi-temporal fields on every new memory.
    sector,
    validFrom: validFromDate,
    recordedAt: now,
    // Batch 6b: explicit working tier at birth - the column DEFAULT 'hot'
    // made fresh rows permanently decay-exempt until the first tier
    // maintenance pass. Young memories are working-tier by definition;
    // recalculateTiers promotes/demotes from there.
    tier: 'working',
    // Team memory: link to team if provided
    ...(input.teamId ? { teamId: input.teamId } : {}),
  };

  // Add namespace if specified
  if (input.namespaceId) {
    insertValues.namespaceId = input.namespaceId;
  }

  // Add user if specified
  if (accessUser && schema.users) {
    try {
      const userRecord = await getOrCreateUser(accessUser, db, schema);
      if (userRecord) {
        insertValues.userId = userRecord.id;
      }
    } catch (e: any) {
      logger.warn('[User] Failed to attach user:', e);
    }
  }

  if (config.clientEncryptionEnabled) {
    const { ciphertext, nonce } = encrypt(input.content);
    insertValues.encrypted_content = ciphertext;
    insertValues.encryption_nonce = nonce;
    insertValues.is_encrypted = true;
    // Store empty placeholder for plain content
    insertValues.content = '';
  } else {
    insertValues.content = input.content;
    insertValues.is_encrypted = false;
  }

  await withBusyRetry(() => db.insert(schema.memories).values(insertValues), {
    label: 'rememberMemory.insert',
  });

  let knowledgeRecordId: string | null = null;

  if (project?.id) {
    try {
      const beliefs = extractBeliefs({
        memoryId: id,
        content: input.content,
        type,
        metadata: enrichedMetadata,
      });
      if (beliefs.length > 0) {
        await upsertBeliefsForMemory({
          projectId: project.id,
          memoryId: id,
          beliefs,
        });
      }
    } catch (beliefError) {
      logger.warn(`[Beliefs] Failed to derive beliefs for memory ${id}: ${beliefError}`);
    }

    // Extract strategies from memory content into unified knowledge table
    try {
      const extractedStrategies = await extractConversationStrats(input.content, {
        projectId: project.id,
        sourceType: 'memory',
        sourceId: id,
      });
      for (const extracted of extractedStrategies) {
        try {
          await createKnowledge({
            projectId: project.id,
            knowledgeKind: 'strategy',
            knowledgeType: extracted.strategyType,
            content: extracted.description,
            title: extracted.title,
            description: extracted.description,
            steps: extracted.steps,
            successCriteria: extracted.successCriteria,
            failureIndicators: extracted.failureIndicators,
            confidence: extracted.confidence / 100,
            tags: ['auto-extracted', 'realtime'],
          });
        } catch (strategyCreateError) {
          logger.debug(`[Strategy] Failed to create strategy from memory ${id}: ${strategyCreateError}`);
        }
      }
    } catch (strategyError) {
      logger.debug(`[Strategy] Extraction failed for memory ${id}: ${strategyError}`);
    }

    // Store memory in unified knowledge table
    try {
      const knowledgeInput: CreateKnowledgeInput = {
        projectId: project.id,
        userId: insertValues.userId ?? undefined,
        sessionId: input.sessionId ?? undefined,
        knowledgeKind: 'memory',
        knowledgeType: type,
        content: input.content,
        summary: undefined,
        confidence: importance.score / 100,
        tags: tags,
        metadata: enrichedMetadata,
        // Batch 6b: mirror the routed sector instead of hardcoding episodic.
        sector,
        tier: importance.score >= 70 ? 'hot' : 'cold',
      };
      const knowledgeRecord = await createKnowledge(knowledgeInput);
      knowledgeRecordId = knowledgeRecord.id;
      logger.debug(`[Knowledge] Stored memory ${id} in knowledge table`);
    } catch (knowledgeError) {
      logger.debug(`[Knowledge] Failed to store memory in knowledge table: ${knowledgeError}`);
    }
  }

   // Build graph for this memory (auto-build if enabled)
   // Uses incremental sync which tracks entity counts and runs periodic dedup
   if (config.graphAutoBuild && project?.id) {
     try {
       const syncResult = await onMemoryStored(id, {
         project: input.project,
       });
       if (syncResult.entitiesCreated > 0 || syncResult.relationsCreated > 0) {
         logger.debug(`[Graph] Synced memory ${id}: ${syncResult.entitiesCreated} entities, ${syncResult.relationsCreated} relations${syncResult.dedupRan ? ' (dedup ran)' : ''}`);
       }

       // Create knowledge_edges from knowledge record to extracted entities
       // This bridges the knowledge table with the entity graph so that
       // getConnectedEntities() can traverse cross-system relationships.
       if (knowledgeRecordId && (syncResult.entitiesCreated > 0 || syncResult.relationsCreated > 0)) {
         try {
           const { raw } = await getDbClient();
           const sqlite = (raw as any).$client;
           const updatedRow = sqlite.prepare('SELECT metadata FROM memories WHERE id = ?').get(id);
           if (updatedRow?.metadata) {
             const meta = typeof updatedRow.metadata === 'string'
               ? JSON.parse(updatedRow.metadata)
               : updatedRow.metadata;
             const entityNames: string[] = meta.entities || [];
             if (entityNames.length > 0) {
               const placeholders = entityNames.map(() => '?').join(',');
               const entities = sqlite.prepare(
                 `SELECT id, name FROM entities WHERE project_id = ? AND name IN (${placeholders})`
               ).all(project.id, ...entityNames);

               for (const entity of entities) {
                 try {
                    await createKnowledgeEdge({
                      fromId: knowledgeRecordId,
                      fromKind: 'knowledge',
                      toId: entity.id,
                      toKind: 'entity',
                      edgeType: 'references',
                    });
                 } catch { /* edge may already exist */ }
               }
             }
           }
         } catch (edgeError) {
           logger.debug(`[Knowledge] Failed to create entity edges: ${edgeError}`);
         }
       }
     } catch (graphError) {
       logger.debug(`[Graph] Failed to sync memory ${id}: ${graphError}`);
     }
   }

   // Resolve contradictions and supersede old memories (async, non-blocking)
   // Benchmarks can skip this expensive path by setting SQUISH_SKIP_CONTRADICTION=true
    if (process.env.SQUISH_SKIP_CONTRADICTION !== 'true') {
        resolveContradictions(input.content, type, project?.id ?? undefined, id, insertValues.createdAt as string)
       .then(async (result) => {
          if (result.supersededIds.length > 0) {
            await applySupersession(id, result.supersededIds, result.confidence, result.associationType);
           // Update metadata with contradiction resolution info
           const updatedMetadata: Record<string, unknown> = {
             ...enrichedMetadata,
             contradictionResolution: {
               supersededCount: result.supersededIds.length,
               confidence: result.confidence,
               reason: result.reason,
             },
           };
           metadataValue = serializeMetadata(updatedMetadata);
          }
       })
       .catch((error) => {
         import('../logger.js').then(({ logger }) => {
           logger?.debug?.(`Contradiction resolution failed: ${error}`);
         });
       });
   }

  // Sync to QMD if enabled (async, don't block)

  // Auto-assign to Inbox place by default (or specified placeType)
  await assignMemoryToDefaultPlace(id, project?.id, input.placeType || null, {
    tags: input.tags,
    content: input.content,
    toolName: input.toolName,
    memoryType: type,
  });

  // Create knowledge_edge from knowledge record to primary place
  // This bridges the knowledge table with the place system so that
  // getConnectedPlaces() can traverse cross-system relationships.
  if (knowledgeRecordId) {
    try {
      const { raw } = await getDbClient();
      const sqlite = (raw as any).$client;
      const memoryRow = sqlite.prepare('SELECT place_id FROM memories WHERE id = ?').get(id);
      if (memoryRow?.place_id) {
        await createKnowledgeEdge({
          fromId: knowledgeRecordId,
          fromKind: 'knowledge',
          toId: memoryRow.place_id,
          toKind: 'place',
          edgeType: 'located_in',
        });
      }
    } catch (placeEdgeError) {
      logger.debug(`[Knowledge] Failed to create place edge: ${placeEdgeError}`);
    }
  }

  // Store tags in memory_tags indexed table (v1.5.0)
  if (tags.length > 0) {
    try {
      const { storeMemoryTags } = await import('../places/memory-places.js');
      await storeMemoryTags(id, tags, 'heuristic');
    } catch (tagErr) {
      logger.debug(`Failed to store memory tags: ${tagErr}`);
    }
  }

  // Post-capture geometry check (non-blocking, fire-and-forget)
  // Evaluates whether the new memory's cluster is safe to consolidate
  const embeddingForGeo = parseEmbedding(embedding);
  if (config.consolidationGeometryAutoConsolidate && embeddingForGeo && embeddingForGeo.length > 0) {
    evaluateAndConsolidate(id, embeddingForGeo).catch((err: Error) =>
      logger.debug('Post-capture geometry check failed', err)
    );
  }

  const memoryRecord: MemoryRecord = {
  id,
  projectId: project?.id ?? null,
  type,
  content: input.content,
  tags,
  metadata: enrichedMetadata,
  visibilityScope,
  importance: importance.score as number,
};

  // Batch 7: every squish_remember write is project activity - feed the
  // session working set so wake-up summaries reflect real usage. Awaited
  // (not fire-and-forget) because short-lived CLI processes exit before
  // dangling promises resolve; best-effort, never fails the write.
  // Batch 7 review (M-2): these signals land in the dedicated
  // `memory-write:<project>` pseudo-session and are tagged kind='memory-
  // write' so harness-parsed sessions win wake-up selection.
  if (input.project) {
    try {
      await recordSessionSignal({
        sessionId: input.sessionId ?? `memory-write:${input.project}`,
        projectPath: input.project,
        classification: 'durable-distilled',
        distilledContent: input.content.slice(0, 200),
        toolName: 'squish_remember',
        metadata: {
          activeFiles: extractFilePathSignals(input.content).slice(0, 4),
          kind: input.sessionId ? undefined : 'memory-write',
        },
      });
    } catch {
      /* working-set is best effort */
    }
  }

  emit({
    type: 'memory:stored',
    payload: {
      memoryId: id,
      content: input.content,
      type: type ?? 'note',
      project: input.project,
    },
  });

  return memoryRecord;
}

// ---------------------------------------------------------------------------
// Internal helpers — place assignment & geometry
// ---------------------------------------------------------------------------

/**
 * Extract file path signals from free-form text.
 * Only matches realistic file paths (min 2 segments, each >=2 chars, with extension or common dir patterns).
 * Used by remember-writes to contribute "files touched" signals to the working set.
 */
function extractFilePathSignals(text: string): string[] {
  if (!text) return [];
  // Require: segment/segment with optional subdirectories
  // Each segment: min 2 chars, alphanumeric + hyphens + dots + underscores
  // Optional file extension at end
  const matches = text.match(
    /(?:^|[\s`'"@(,;]|^)([A-Za-z][A-Za-z0-9_-]{1,30}(?:\/[A-Za-z][A-Za-z0-9_._-]{1,30}){1,5}(?:\.[a-zA-Z]{1,10})?)(?:[\s`'"@),;]|$)/g
  );
  if (!matches) return [];
  const seen = new Set<string>();
  for (const m of matches) {
    // Trim whitespace and surrounding chars
    const cleaned = m.replace(/^[\s`'"@(,;]+|[\s`'"@),;]+$/g, '').trim();
    if (cleaned && cleaned.length >= 4) {
      seen.add(cleaned);
      if (seen.size >= 8) break;
    }
  }
  return [...seen];
}

/**
 * Post-capture geometry check and auto-consolidation.
 *
 * Non-blocking fire-and-forget function called after a new memory is stored.
 * Adds the memory to its nearest cluster, updates cluster stats, and
 * evaluates whether the cluster is safe to consolidate.
 *
 * If safe and autoConsolidate is enabled: triggers consolidation.
 * If unsafe and autoSplit is enabled: logs a split recommendation.
 *
 * @param memoryId - ID of the newly created memory
 * @param embedding - Embedding vector of the new memory
 */
async function evaluateAndConsolidate(
  memoryId: string,
  embedding: number[]
): Promise<void> {
  try {
    // Find or create the nearest cluster for this memory
    const clusterId = await findOrCreateCluster(memoryId, embedding);

    // Update cluster geometry stats (centroid, d_bar, d_eff, etc.)
    await updateClusterStats(clusterId);

    // Evaluate whether the cluster is safe to compress
    const decision = await evaluateCluster(clusterId);

    if (decision.safeToCompress && config.consolidationGeometryAutoConsolidate) {
      logger.debug(`Post-capture: cluster ${clusterId} is safe to consolidate ` +
        `(d_bar=${decision.dBar.toFixed(4)}, d_eff=${decision.dEff.toFixed(2)})`);
      // Note: actual consolidation happens in the consolidation engine run.
      // This check just logs readiness; the engine will pick it up.
    } else if (!decision.safeToCompress && config.consolidationGeometryAutoSplit) {
      logger.debug(`Post-capture: cluster ${clusterId} may need splitting ` +
        `(d_bar=${decision.dBar.toFixed(4)}, d_eff=${decision.dEff.toFixed(2)})`);
    }
  } catch (err) {
    // Non-blocking: never fail the memory write
    logger.debug('evaluateAndConsolidate error', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Auto-assign a memory to the global Inbox place by default.
 * Uses global project scope if no projectId provided.
 */
// Scope-aware place initialization cache keyed by global/project scope.
const _cachedPlaceInit = new Map<string, { inboxId: string }>();

async function ensurePlacesInitialized(projectId?: string | null): Promise<{ inboxId: string } | null> {
  const cacheKey = projectId ?? '__global__';
  const cached = _cachedPlaceInit.get(cacheKey);
  if (cached) {
    try {
      const { getPlace } = await import('../places/places.js');
      const existing = await getPlace(cached.inboxId);
      if (existing) return cached;
      _cachedPlaceInit.delete(cacheKey);
    } catch {
      _cachedPlaceInit.delete(cacheKey);
    }
  }
  try {
    const { initializeDefaultPlaces } = await import('../places/places.js');
    const places = await initializeDefaultPlaces(projectId ?? undefined);
    const inboxPlace = places.find(p => p.placeType === 'inbox');
    if (!inboxPlace) return null;
    const init = { inboxId: inboxPlace.id };
    _cachedPlaceInit.set(cacheKey, init);
    return init;
  } catch {
    return null;
  }
}

async function assignMemoryToDefaultPlace(
  memoryId: string, 
  projectId?: string | null, 
  placeType?: string | null,
  options?: {
    tags?: string[];
    content?: string;
    toolName?: string;
    memoryType?: string;
  }
): Promise<void> {
  try {
    const init = await ensurePlacesInitialized(projectId);
    if (!init) return;

    const { ensureGlobalProject } = await import('../places/places.js');
    const resolvedPlaceProjectId = projectId ?? (await ensureGlobalProject()).id;

    // Use findMatchingPlaces() to get ranked candidates
    const { findMatchingPlaces } = await import('../places/rules.js');
    const candidates = await findMatchingPlaces(projectId ?? undefined, {
      toolName: options?.toolName,
      content: options?.content,
      tags: options?.tags,
      memoryType: options?.memoryType,
    });

    // If placeType was explicitly specified and is not the top candidate,
    // make sure it appears as a candidate
    if (placeType && candidates.length > 0 && candidates[0].type !== placeType) {
      // Add explicit placeType as first candidate
      candidates.unshift({
        type: placeType as any,
        weight: 1.0,
        reason: 'explicitly specified',
        source: 'manual',
      });
    } else if (placeType && candidates.length === 0) {
      candidates.push({
        type: placeType as any,
        weight: 1.0,
        reason: 'explicitly specified',
        source: 'manual',
      });
    }

    // Fallback to inbox if no candidates matched
    if (candidates.length === 0) {
      candidates.push({
        type: 'inbox' as any,
        weight: 1.0,
        reason: 'default fallback',
        source: 'heuristic',
      });
    }

    // Store all candidates in memory_places (1:N)
    const { assignMemoryToPlaces } = await import('../places/memory-places.js');
    await assignMemoryToPlaces(memoryId, candidates, resolvedPlaceProjectId);

    // Set primaryPlace and place_id (legacy alias) on the memory record
    const primaryPlace = candidates[0]?.type ?? placeType ?? 'inbox';
    const client = ((await getDb()) as any).$client || (await getDb());
    try {
      // Resolve placeType to placeId for legacy place_id column
      const { getPlaceByType } = await import('../places/places.js');
      const place = await getPlaceByType(resolvedPlaceProjectId, primaryPlace);
      const placeId = place?.id ?? null;

      if (placeId) {
        const stmt = client.prepare(
          'UPDATE memories SET primary_place = ?, place_id = ? WHERE id = ?'
        );
        await withBusyRetry(() => stmt.run(primaryPlace, placeId, memoryId), {
          label: 'placeAssignment.updateWithPlaceId',
        });
      } else {
        const stmt = client.prepare(
          'UPDATE memories SET primary_place = ? WHERE id = ?'
        );
        await withBusyRetry(() => stmt.run(primaryPlace, memoryId), {
          label: 'placeAssignment.update',
        });
      }
    } catch {
      // Fallback to drizzle
      try {
        const sqliteDb = (await getDb()) as any;
        const schemaModule = await getSchema();
        await sqliteDb.update(schemaModule.memories)
          .set({ primaryPlace })
          .where(eq(schemaModule.memories.id, memoryId));
      } catch {
        // Ignore
      }
    }
  } catch (err) {
    // Non-blocking: never fail the memory write
    logger.debug(`assignMemoryToDefaultPlace error: ${err}`);
  }
}
