/**
 * SquishRuntime — flattened single-file runtime extracted from @squish/core-sdk.
 *
 * Contains the SquishRuntime class (renamed from SquishClient) plus all
 * re-exports that CLI and MCP consume: types, error classes, config,
 * logger, database helpers, plugin registry, and event bus.
 *
 * All imports use relative paths within core/ — no workspace package
 * references.
 */

import { logger } from '../logger.js';
import { EPOCH_MS_LADDER_THRESHOLD } from '../lib/timestamps.js';
import type { StrictCorrectionHistory } from '../snapshots/retrieval.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';
import { decrypt } from '../security/encrypt.js';
import { allAgentStores as listAgentStores } from '../sessions/agent-stores/registry.js';
import type { Chunk } from '../sessions/types.js';
import { buildRecallResponse, type RecallResponse } from '../retrieval/recall-response.js';

// ─── Types (inlined from core-sdk interfaces) ────────────────────────────────

/** Valid memory type values */
export type MemoryType =
  | 'observation'
  | 'fact'
  | 'decision'
  | 'context'
  | 'preference'
  | 'note'
  | 'task';

/** Confidence level for memory records */
export type ConfidenceLevel = 'certain' | 'speculative' | 'outdated';

/** Storage Provider Interface */
export interface StorageProvider {
  readonly name: string;
  initialize(config: StorageConfig): Promise<void>;
  close(): Promise<void>;
  isHealthy(): Promise<boolean>;
  storeMemory(input: StoreMemoryInput): Promise<MemoryRecord>;
  getMemory(id: string, includeEmbedding?: boolean): Promise<MemoryRecord | null>;
  updateMemory(id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord>;
  deleteMemory(id: string): Promise<boolean>;
  queryMemories(filter: MemoryFilter): Promise<MemoryRecord[]>;
  storeEmbedding(memoryId: string, vector: Float32Array): Promise<void>;
  getEmbedding(memoryId: string): Promise<Float32Array | null>;
  vectorSearch(query: Float32Array, topK: number, filter?: VectorSearchFilter): Promise<VectorSearchResult[]>;
  ftsSearch(query: string, topK: number, filter?: MemoryFilter): Promise<FTSResult[]>;
  storeEntity(entity: EntityInput): Promise<EntityRecord>;
  storeRelation(relation: RelationInput): Promise<EntityRelation>;
  getEntityNeighborhood(entityId: string, depth?: number): Promise<GraphTraversalResult>;
  findEntityPaths(fromId: string, toId: string, maxDepth?: number): Promise<TraversalPath[]>;
}

export interface StorageConfig {
  dataDir: string;
  project?: string;
}

export interface StoreMemoryInput {
  content: string;
  type?: MemoryType;
  tags?: string[];
  importance?: number;
  project?: string;
  user?: string;
  sessionId?: string;
  captureKey?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryRecord {
  id: string;
  content: string;
  type: MemoryType;
  tags: string[];
  metadata?: Record<string, unknown> | null;
  projectId?: string | null;
  visibilityScope?: 'private' | 'project' | 'team' | null;
  validFrom?: string | null;
  validTo?: string | null;
  recordedAt?: string | null;
  importance: number;
  project?: string;
  sessionId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  lastAccessedAt?: Date;
  accessCount: number;
  decayScore: number;
  /** Confidence assigned by the current recall pass, when available. */
  recallConfidence?: number;
}

export interface MemoryFilter {
  project?: string;
  type?: MemoryType;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface VectorSearchFilter {
  project?: string;
  type?: MemoryType;
  tags?: string[];
}

export interface VectorSearchResult {
  memoryId: string;
  similarity: number;
  memory: MemoryRecord;
}

export interface FTSResult {
  memoryId: string;
  rank: number;
  snippet?: string;
  memory: MemoryRecord;
}

export interface EntityInput {
  name: string;
  type: string;
  projectId: string;
  mentionCount?: number;
}

export interface RelationInput {
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  weight?: number;
  properties?: Record<string, unknown>;
}

export interface EntityRecord {
  id: string;
  name: string;
  type: string;
  description: string | null;
  properties: Record<string, unknown> | null;
}

export interface EntityRelation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  fromEntityName: string;
  toEntityName: string;
  relationType: string;
  weight: number;
  properties: Record<string, unknown> | null;
}

export interface GraphNode {
  id: string;
  name: string;
  type: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
}

export interface GraphTraversalResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: TraversalPath[];
}

export interface TraversalPath {
  from: string;
  to: string;
  edges: GraphEdge[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  metadata?: Record<string, unknown> | null;
}

export interface LearningInput {
  type: 'success' | 'failure' | 'fix' | 'insight';
  content: string;
  context?: string;
  action?: string;
  target?: string;
  project?: string;
  memoryId?: string;
  autoLink?: boolean;
}

export interface LearningRecord {
  id: string;
  projectId?: string | null;
  conversationId?: string | null;
  type: 'success' | 'failure' | 'fix' | 'insight';
  action: string;
  target?: string | null;
  summary: string;
  details?: Record<string, unknown> | null;
  memoryId?: string | null;
  isImported?: boolean;
  createdAt?: string | null;
}

export interface LearningFilter {
  project?: string;
  type?: string;
  limit?: number;
}

export interface SchemaHealth {
  status: 'ok' | 'drifted' | 'unavailable';
  missingTables: string[];
  missingColumns: string[];
}

/** Edit proposal record (edit workflow, see core/memory/edit-workflow.ts) */
export interface EditProposalRecord {
  id: string;
  memoryId: string;
  currentContent: string;
  proposedContent: string;
  reason: string;
  conflictWarnings: string[];
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  version: number;
  createdAt: Date;
  reviewedAt?: Date;
  reviewNotes?: string;
}

/** Result of approve/reject/correct on an edit proposal */
export interface EditProposalActionResult {
  ok: boolean;
  error?: 'not_found' | 'not_pending' | 'stale_content' | 'database_unavailable' | 'invalid_provenance' | 'provenance_signing_unavailable' | 'generated_context' | 'encrypted_memory_unsupported';
  detail?: string;
  proposal?: EditProposalRecord;
  priorContent?: string;
  snapshotId?: string;
}

/** Read-only staleness report (see core/memory/staleness-report.ts) */
export interface StalenessReportResult {
  generatedAt: string;
  groups: Array<{
    group: string;
    count: number;
    items: Array<{ memoryId: string; suggestedAction: 'review' | 'update' | 'forget' | 'pin' }>;
    digest: string;
  }>;
}

/** Embedding Provider Interface */
export interface EmbeddingProvider {
  readonly name: string;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  isAvailable(): Promise<boolean>;
  getDimension(): number;
}

export interface MultimodalInput {
  text?: string;
  imageUrl?: string;
  audioData?: Buffer;
}

export interface EmbeddingConfig {
  provider: string;
  model?: string;
  dimension?: number;
}

/** LLM Provider Interface */
export interface LLMProvider {
  readonly name: string;
  complete(options: LLMCallOptions): Promise<string>;
  isAvailable(): Promise<boolean>;
}

export interface LLMCallOptions {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  contentParts?: LLMContentPart[];
}

export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LLMConfig {
  provider: string;
  model?: string;
  apiKey?: string;
}

/** Event System Types */
export interface GraphBuildStats {
  memoriesProcessed: number;
  entitiesCreated: number;
  relationsCreated: number;
  entitiesDeduplicated: number;
  errors: number;
  durationMs: number;
}

export type SquishEvent =
  | { type: 'memory:stored'; payload: { memoryId: string; content: string; type: string; project?: string } }
  | { type: 'memory:updated'; payload: { memoryId: string; changes: Record<string, unknown> } }
  | { type: 'memory:deleted'; payload: { memoryId: string } }
  | { type: 'memory:searched'; payload: { query: string; resultCount: number; project?: string } }
  | { type: 'learning:stored'; payload: { learningId: string; type: string; content: string } }
  | { type: 'graph:entity:created'; payload: { entityId: string; name: string; type: string } }
  | { type: 'graph:relation:created'; payload: { fromId: string; toId: string; type: string } }
  | { type: 'graph:rebuilt'; payload: { project: string; stats: GraphBuildStats } }
  | { type: 'decay:applied'; payload: { affectedCount: number; project?: string } }
  | { type: 'consolidation:started'; payload: { project?: string } }
  | { type: 'consolidation:completed'; payload: { project?: string; merged: number; split: number } }
  | { type: 'session:created'; payload: { sessionId: string } }
  | { type: 'session:ended'; payload: { sessionId: string; duration: number } }
  | { type: 'schema:migration:started'; payload: { fromVersion: string; toVersion: string } }
  | { type: 'schema:migration:completed'; payload: { fromVersion: string; toVersion: string; success: boolean } }
  | { type: 'health:check'; payload: { status: 'ok' | 'degraded' | 'error'; detail: string } };

export interface EventBus {
  emit(event: SquishEvent): void;
  on<T extends SquishEvent['type']>(
    eventType: T,
    handler: (event: Extract<SquishEvent, { type: T }>) => void | Promise<void>,
  ): () => void;
  off<T extends SquishEvent['type']>(
    eventType: T,
    handler: (event: Extract<SquishEvent, { type: T }>) => void | Promise<void>,
  ): void;
}

// ─── SDK-Specific Types ──────────────────────────────────────────────────────

/** SDK Configuration */
export interface SquishConfig {
  dataDir?: string;
  project?: string;
  storage?: StorageProvider;
  embeddings?: EmbeddingProvider;
  llm?: LLMProvider;
  events?: EventBus;
  lifecycleEnabled?: boolean;
  graphAutoBuild?: boolean;
  consolidationEnabled?: boolean;
}

/** Client construction options */
export interface ClientOptions {
  dataDir?: string;
  project?: string;
  storage?: StorageProvider;
  embeddings?: EmbeddingProvider;
  llm?: LLMProvider;
  events?: EventBus;
  lifecycleEnabled?: boolean;
  graphAutoBuild?: boolean;
  consolidationEnabled?: boolean;
}

/** Unified search result */
export interface SearchResult {
  memory: {
    id: string;
    content: string;
    type: string;
    tags: string[];
    importance: number;
    project?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  score: number;
  semanticScore?: number;
  preFusionSemanticScore?: number | null;
  boostScore?: number;
  finalScore?: number;
  scoreBreakdown?: Record<string, number>;
  recallConfidence?: number;
  confidenceTier?: 'HIGH' | 'QUALIFIED' | 'LOW';
  evidence?: {
    semantic: number | null;
    lexical: { rank: number | null; score: number | null };
    graph: number | null;
    temporal: { stale: boolean | null; supersededBy: string | null };
    conflictPenalty: number | null;
    memoryConfidence: 'certain' | 'speculative' | 'outdated' | null;
    supportingCount: number;
    contradictingCount: number;
    freshness: number | null;
    rerankAgreement?: number | null;
  };
  source: 'vector' | 'fts' | 'graph' | 'hybrid';
  corpus?: 'memory' | 'belief';
  explanation?: string;
}

/** Recall assessment */
export interface RecallAssessment {
  bestConfidence: number;
  tier: 'HIGH' | 'QUALIFIED' | 'LOW';
  verdict: 'confident' | 'qualified' | 'no_reliable_memory';
  message: string;
}

/** Plugin hook types */
export type PluginHook =
  | 'before:store'
  | 'after:store'
  | 'before:search'
  | 'after:search'
  | 'before:delete'
  | 'after:delete'
  | 'before:consolidate'
  | 'after:consolidate'
  | 'before:graph:build'
  | 'after:graph:build';

export interface PluginHookContext {
  hook: PluginHook;
  config: SquishConfig;
  abort: () => void;
  aborted: boolean;
  metadata: Record<string, unknown>;
}

/** Event type discriminants */
export type EventType =
  | 'memory:stored'
  | 'memory:updated'
  | 'memory:deleted'
  | 'memory:searched'
  | 'learning:stored'
  | 'graph:entity:created'
  | 'graph:relation:created'
  | 'graph:rebuilt'
  | 'decay:applied'
  | 'consolidation:started'
  | 'consolidation:completed'
  | 'session:created'
  | 'session:ended'
  | 'schema:migration:started'
  | 'schema:migration:completed'
  | 'health:check';

// ─── Method Option Types ─────────────────────────────────────────────────────

export interface RememberOptions {
  type?: MemoryType;
  tags?: string[];
  importance?: number;
  project?: string;
  user?: string;
  sessionId?: string;
  captureKey?: string;
  occurredAt?: string | Date;
  /** IANA zone used to interpret calendar language in the source content. */
  timeZone?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  limit?: number;
  /** Select the lexical-only FTS ranking path for diagnostics and controlled comparisons. */
  retrievalMode?: 'hybrid' | 'lexical';
  project?: string;
  user?: string;
  minScore?: number;
  teamId?: string;
  referenceDate?: string | Date;
  /** IANA zone used to resolve relative past query phrases. */
  timeZone?: string;
  latestOnly?: boolean;
  validTimeFrom?: string | Date;
  validTimeTo?: string | Date;
}

export interface ListRecentOptions {
  limit?: number;
  project?: string;
  hoursBack?: number;
}

export interface GraphOptions {
  maxDepth?: number;
  limit?: number;
  userId?: string;
  teamIds?: string[];
}

export interface ContextOptions {
  project?: string;
  limit?: number;
  user?: string;
  teamId?: string;
}

/**
 * Memory statistics shape. Declared once in core/memory/stats.ts, which is what
 * `stats()` delegates to; a second, narrower copy used to live here and had
 * already drifted out of date, which hid real fields from the CLI's type.
 */
export type { MemoryStats } from '../memory/stats.js';
import type { MemoryStats } from '../memory/stats.js';

export interface HealthResult {
  status: string;
  components: Record<string, string>;
}

export interface RecallClientOptions {
  limit?: number;
  project?: string;
  type?: MemoryType;
  tags?: string[];
  strategy?: string;
  user?: string;
  teamId?: string;
  referenceDate?: string | Date;
  /** IANA zone used to resolve relative past query phrases. */
  timeZone?: string;
  latestOnly?: boolean;
  validTimeFrom?: string | Date;
  validTimeTo?: string | Date;
}

export interface CompactRecallOptions extends RecallClientOptions {
  /** Maximum estimated tokens in the serialized compact response (128–20,000). */
  maxTokens?: number;
}

export interface RecallOptions {}

export interface RecallResult {
  memories: MemoryRecord[];
  graphEntities?: EntityRecord[];
  routing: {
    intent: string;
    strategy: string;
    confidence: number;
  };
  metadata: {
    totalResults: number;
    durationMs: number;
    sources: string[];
  };
}
export interface SemanticResult {}

// ─── Governance Types ────────────────────────────────────────────────────────

export interface PinOptions {
  project?: string;
}

export interface SessionOptions {
  project?: string;
  limit?: number;
  source?: string;
}

export interface MaintenanceOptions {
  project?: string;
  dryRun?: boolean;
  steps?: ('dedup' | 'stale' | 'consolidate' | 'inbox')[];
  age?: number;
  llmEnabled?: boolean;
}

export interface SchemaHealthResult {
  healthy: boolean;
  issues: string[];
  fixes: string[];
}

export interface TrustState {
  project: string;
  mode: string;
  stats: Record<string, unknown>;
  context: Record<string, unknown>;
}

export interface SignalResult {
  signals: string[];
  hasSignal: boolean;
}

export interface AssociationResult {
  id: string;
  fromId: string;
  toId: string;
  type: string;
}

export interface PlaceRecord {
  id: string;
  name: string;
  memories: string[];
}

export interface SessionRecord {
  id: string;
  title?: string;
  project?: string;
  branch?: string;
  agent: string;
  startedAt: string;
  endedAt?: string;
  status?: string;
  chunkCount: number;
  memoryCount: number;
}

export interface ChunkRecord {
  id: string;
  sessionId: string;
  content: string;
  type?: string;
  timestamp?: string;
  agent?: string;
  sessionTitle?: string;
  why?: string;
}

// ─── Dedup / Merge Workflow Types ───────────────────────────────────────────

export interface DedupScanInput {
  projectId?: string;
  threshold?: number;
  memoryType?: string;
  limit?: number;
  autoCreateProposals?: boolean;
}

export interface DedupScanResult {
  ok: boolean;
  message: string;
  data?: {
    projectId: string;
    duplicateCount: number;
    proposalsCreated: number;
    proposalIds: string[];
    statistics: {
      totalMemories: number;
      scannedMemories: number;
      candidatesFound: number;
      estimatedTokensSaved: number;
    };
    timing: {
      stage1Ms: number;
      stage2Ms: number;
      totalMs: number;
    };
    [key: string]: unknown;
  };
  error?: string;
}

export interface MergeProposalListInput {
  projectId: string;
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
  limit?: number;
}

export interface MergeProposalSummary {
  id: string;
  projectId: string;
  sourceMemoryIds: string[];
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  confidenceLevel: string;
  similarityScore: number;
  mergeReason: string;
  createdAt: string;
  conflictWarnings: string[];
}

export interface MergeListResult {
  ok: boolean;
  message: string;
  data?: {
    projectId: string;
    count: number;
    proposals: MergeProposalSummary[];
    byStatus: { pending: number; approved: number; rejected: number; expired: number };
  };
  error?: string;
}

export interface MergePreviewResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface MergeActionResult {
  ok: boolean;
  message: string;
  data?: {
    proposalId: string;
    canonicalMemoryId?: string;
    mergedMemoryIds?: string[];
    tokensSaved?: number;
    mergedAt?: string;
    mergeHistoryId?: string;
    [key: string]: unknown;
  };
  error?: string;
}

export interface MergeReversalResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface DedupAutoMergeRecord {
  proposalId: string;
  canonicalMemoryId: string;
  mergedMemoryIds: string[];
  mergeHistoryId: string | null;
  tokensSaved: number | undefined;
}

export interface DedupAutoResult {
  ok: boolean;
  gated: boolean;
  approved: number;
  merges: DedupAutoMergeRecord[];
  message?: string;
}

// ─── Error Classes ───────────────────────────────────────────────────────────

export class SquishError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'SquishError';
  }
}

function isTrustBoundaryError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TrustBoundaryError';
}

async function resolveSdkReadCaller(caller?: { userId?: string; teamIds?: string[] }): Promise<{ userId?: string; teamIds?: string[] }> {
  const { resolveTrustedCallerId } = await import('../acl/trust-policy.js');
  return {
    userId: resolveTrustedCallerId(caller?.userId) ?? undefined,
    teamIds: caller?.teamIds,
  };
}

async function resolveRuntimeProjectId(project?: string): Promise<string> {
  if (!project) {
    const { ensureGlobalProject } = await import('../places/places.js');
    return (await ensureGlobalProject()).id;
  }

  const { getProjectById, getProjectByPath } = await import('../projects.js');
  const record = await getProjectById(project) ?? await getProjectByPath(project);
  if (!record) throw new SquishError(`Project not found: ${project}`, 'PROJECT_NOT_FOUND');
  return record.id;
}

export class ConfigError extends SquishError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFIG_ERROR', cause);
    this.name = 'ConfigError';
  }
}

export class StorageError extends SquishError {
  constructor(message: string, cause?: Error) {
    super(message, 'STORAGE_ERROR', cause);
    this.name = 'StorageError';
  }
}

export class EmbeddingError extends SquishError {
  constructor(message: string, cause?: Error) {
    super(message, 'EMBEDDING_ERROR', cause);
    this.name = 'EmbeddingError';
  }
}

export class LLMError extends SquishError {
  constructor(message: string, cause?: Error) {
    super(message, 'LLM_ERROR', cause);
    this.name = 'LLMError';
  }
}

export class NotFoundError extends SquishError {
  constructor(resource: string, id: string) {
    super(`${resource} with id '${id}' not found`, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

/**
 * Render an id for a log context without throwing.
 *
 * Used from catch blocks, where calling `id.trim()` on a non-string input
 * would replace the real failure with a TypeError about the id.
 */
function describeId(id: unknown): string {
  return typeof id === 'string' ? id : String(id);
}

/**
 * Log an error and wrap it in a StorageError that names the cause.
 *
 * Roughly fifty methods used to do `throw new StorageError('<generic
 * message>', error)`, parking the real error in `.cause`. Nothing on the MCP
 * path read `.cause` or logged it, so a genuine
 * `ProjectNotFoundError: Project not found: <path>` reached the operator as
 * the useless string `Failed to recall memories`. This helper keeps the cause
 * reachable and visible:
 *
 *  - logs through core/logger.ts, whose `logger.error` prints `error.stack`, so
 *    the error class and origin reach stderr even when the thrown message is
 *    only read by a client;
 *  - appends `cause.message` to the thrown message;
 *  - preserves the cause on the error, so structured inspection still works.
 *
 * A message that already contains the detail is left alone rather than
 * repeated. A non-Error throw is normalised to an Error so `.stack` and
 * `.message` always exist downstream.
 */
export function wrapStorageError(
  message: string,
  error: unknown,
  context?: Record<string, unknown>,
): StorageError {
  const cause = error instanceof Error ? error : new Error(String(error));
  logger.error(message, cause, context);
  const detail = cause.message;
  const combined = detail && !message.includes(detail) ? `${message}: ${detail}` : message;
  return new StorageError(combined, cause);
}

// ─── Plugin Registry ────────────────────────────────────────────────────────

export interface Plugin {
  name: string;
  hooks: Partial<Record<PluginHook, (ctx: PluginHookContext) => Promise<void> | void>>;
}

export class PluginRegistry {
  private plugins: Plugin[] = [];

  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  async executeHook(hook: PluginHook, ctx: PluginHookContext): Promise<void> {
    for (const plugin of this.plugins) {
      const handler = plugin.hooks[hook];
      if (handler) {
        await handler(ctx);
      }
    }
  }
}

// ─── Event Bus ───────────────────────────────────────────────────────────────

type EventHandler = (event: SquishEvent) => void | Promise<void>;

export class DefaultEventBus implements EventBus {
  private listeners = new Map<string, Set<EventHandler>>();
  private onceListeners = new Map<string, Set<EventHandler>>();

  emit(event: SquishEvent): void {
    const handlers = this.listeners.get(event.type);
    const onceHandlers = this.onceListeners.get(event.type);

    if (handlers) {
      for (const handler of handlers) {
        this.invoke(handler, event);
      }
    }

    if (onceHandlers) {
      for (const handler of onceHandlers) {
        this.invoke(handler, event);
      }
      onceHandlers.clear();
    }
  }

  on<T extends SquishEvent['type']>(
    eventType: T,
    handler: (event: Extract<SquishEvent, { type: T }>) => void | Promise<void>,
  ): () => void {
    const key = eventType as string;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(handler as EventHandler);

    return () => this.off(eventType, handler);
  }

  off<T extends SquishEvent['type']>(
    eventType: T,
    handler: (event: Extract<SquishEvent, { type: T }>) => void | Promise<void>,
  ): void {
    const key = eventType as string;
    this.listeners.get(key)?.delete(handler as EventHandler);
  }

  once<T extends SquishEvent['type']>(
    eventType: T,
    handler: (event: Extract<SquishEvent, { type: T }>) => void | Promise<void>,
  ): () => void {
    const key = eventType as string;
    if (!this.onceListeners.has(key)) {
      this.onceListeners.set(key, new Set());
    }
    this.onceListeners.get(key)!.add(handler as EventHandler);

    return () => this.onceListeners.get(key)?.delete(handler as EventHandler);
  }

  clear(): void {
    this.listeners.clear();
    this.onceListeners.clear();
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    for (const set of this.onceListeners.values()) count += set.size;
    return count;
  }

  private invoke(handler: EventHandler, event: SquishEvent): void {
    try {
      const result = handler(event);
      if (result && typeof result === 'object' && 'catch' in result) {
        (result as Promise<void>).catch((err) => {
          console.error(`[event-bus] handler error for ${event.type}:`, err);
        });
      }
    } catch (err) {
      console.error(`[event-bus] handler error for ${event.type}:`, err);
    }
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

export { config, getDataDir, detectProjectScope } from '../../config.js';

// ─── Logger ──────────────────────────────────────────────────────────────────

export { logger } from '../logger.js';

// ─── Database ────────────────────────────────────────────────────────────────

export { getDb } from '../../db/index.js';
export {
  probeSchemaHealth,
  isSchemaDriftError,
  type SchemaProbeResult,
} from '../../db/schema-probe.js';
export { fixSchemaIssues } from '../../db/schema-repair.js';
export { ensureSqliteSchema } from '../../db/bootstrap.js';

// ─── Runtime Helpers ─────────────────────────────────────────────────────────

export { installDiagnostic } from './install-diagnostics.js';
export {
  buildHealthState,
  buildStatsState,
  buildContextState,
  buildInspectState,
  resolveProjectScope,
} from './trust-state.js';
export {
  formatHealthReport,
  formatStatsReport,
  formatContextReport,
} from './trust-report.js';

// ─── Memory ──────────────────────────────────────────────────────────────────

export async function getMemory(id: string, incrementAccess: boolean = true) {
  const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
  if (isStrictTrustPolicy()) {
    throw new TrustBoundaryError('Unscoped raw memory reads are disabled under strict trust');
  }
  const { getMemory: readMemory } = await import('../memory/memories.js');
  return readMemory(id, incrementAccess);
}
export { promoteToSturdy } from '../memory/tiers.js';
export { detectMemorySignals } from '../memory/trigger-detector.js';
export { migrateMemories, type MigrateResult } from '../memory/migrate.js';

// ─── Security ────────────────────────────────────────────────────────────────

export { pinMemory, unpinMemory } from '../security/governance.js';

// ─── Associations ────────────────────────────────────────────────────────────

export { createAssociation, getRelatedMemories } from '../associations.js';

// ─── Snapshots ───────────────────────────────────────────────────────────────

export { getMemorySnapshot } from '../snapshots/retrieval.js';

// ─── Ingestion ───────────────────────────────────────────────────────────────

export { shouldReturnRawFallback } from '../ingestion/signal-engine.js';
export { createLearning } from '../ingestion/learnings.js';

// ─── Sessions ────────────────────────────────────────────────────────────────

export {
  listSessions,
  getSessionChunks,
  searchChunks,
} from '../sessions/index.js';
export function allAgentStores() {
  if (isStrictTrustPolicy()) {
    resolveTrustedCallerId();
    throw new TrustBoundaryError('Raw agent session stores are unavailable under strict trust; use caller-scoped adapter APIs');
  }
  return listAgentStores();
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

export { getQMDClient } from '../embeddings/qmd-client.js';

// ─── Utilities ───────────────────────────────────────────────────────────────

export { filterByDateRange } from '../lib/utils.js';

// ─── Mapping Helpers ────────────────────────────────────────────────────────

/**
 * Coerce a raw temporal column value into a valid Date.
 */
export function coerceTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds-or-milliseconds ladder; threshold shared with the other readers.
    return new Date(value < EPOCH_MS_LADDER_THRESHOLD ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return coerceTimestamp(asNumber);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Map a core MemoryRecord to the SDK MemoryRecord type.
 */
function mapCoreMemoryToSdk(core: any, omitUnverifiedTimestamps = false): MemoryRecord {
  const createdAt = coerceTimestamp(core.createdAt);
  const updatedAt = coerceTimestamp(core.updatedAt);
  const resolvedCreatedAt = omitUnverifiedTimestamps ? undefined : createdAt ?? updatedAt ?? new Date();
  const resolvedUpdatedAt = omitUnverifiedTimestamps ? undefined : updatedAt ?? createdAt ?? new Date();
  return {
    id: core.id,
    content: core.content,
    type: core.type,
    tags: core.tags ?? [],
    metadata: core.metadata ?? null,
    projectId: core.projectId ?? null,
    visibilityScope: core.visibilityScope ?? null,
    validFrom: core.validFrom ?? null,
    validTo: core.validTo ?? null,
    recordedAt: core.recordedAt ?? null,
    importance: core.importance ?? 0,
    project: core.projectId ?? undefined,
    sessionId: core.sessionId ?? undefined,
    ...(resolvedCreatedAt ? { createdAt: resolvedCreatedAt } : {}),
    ...(resolvedUpdatedAt ? { updatedAt: resolvedUpdatedAt } : {}),
    lastAccessedAt: coerceTimestamp(core.lastAccessedAt) ?? undefined,
    accessCount: core.accessCount ?? 0,
    decayScore: core.decayScore ?? 0,
    ...(typeof core.recallConfidence === 'number' ? { recallConfidence: core.recallConfidence } : {}),
  };
}

/**
 * Map a core search result to the SDK SearchResult type.
 */
function mapCoreSearchResultToSdk(core: any, omitUnverifiedTimestamps = false): SearchResult {
  const memory = mapCoreMemoryToSdk(core, omitUnverifiedTimestamps);
  return {
    memory: {
      id: memory.id,
      content: memory.content,
      type: memory.type,
      tags: memory.tags,
      importance: memory.importance,
      project: memory.project,
      ...(memory.createdAt ? { createdAt: memory.createdAt.toISOString() } : {}),
      ...(memory.updatedAt ? { updatedAt: memory.updatedAt.toISOString() } : {}),
    },
    score: core.finalScore ?? core.similarity ?? 0,
    semanticScore: core.semanticScore,
    preFusionSemanticScore: core.preFusionSemanticScore ?? null,
    boostScore: core.boostScore,
    finalScore: core.finalScore,
    scoreBreakdown: core.scoreBreakdown,
    recallConfidence: core.recallConfidence,
    confidenceTier: core.confidenceTier,
    evidence: core.evidence,
    corpus: core.corpus,
    source: 'hybrid',
  };
}

// ─── SquishRuntime ──────────────────────────────────────────────────────────

type SessionSourceOption = 'opencode' | 'claude-code' | 'codex' | 'gemini' | 'all';

/**
 * Main runtime for interacting with the squish memory system.
 *
 * Wraps the core engine and provides a clean typed API for all major
 * memory operations: storing, recalling, searching, and graph traversal.
 *
 * @example
 * ```ts
 * import { SquishRuntime } from '../core/runtime/squish-runtime.js';
 *
 * const runtime = new SquishRuntime({
 *   dataDir: '~/.local/share/squish',
 *   project: '/path/to/project',
 * });
 *
 * await runtime.remember('Important design decision: use event-driven architecture');
 * const results = await runtime.recall('architecture decisions');
 * await runtime.close();
 * ```
 */
export class SquishRuntime {
  private readonly config: SquishConfig;
  private _activeProject: string | undefined;

  constructor(options: ClientOptions = {}) {
    this.config = {
      dataDir: options.dataDir,
      project: options.project,
      storage: options.storage,
      embeddings: options.embeddings,
      llm: options.llm,
      events: options.events,
      lifecycleEnabled: options.lifecycleEnabled,
      graphAutoBuild: options.graphAutoBuild,
      consolidationEnabled: options.consolidationEnabled,
    };
    this._activeProject = options.project;
  }

  getConfig(): Readonly<SquishConfig> {
    return Object.freeze({ ...this.config });
  }

  // ─── Storage Operations ──────────────────────────────────────────────────

  async remember(content: string, options?: RememberOptions): Promise<MemoryRecord> {
    try {
      if (!content?.trim()) {
        throw new SquishError('Content cannot be empty', 'VALIDATION_ERROR');
      }

      const { isStrictTrustPolicy, resolveTrustedCallerId } = await import('../acl/trust-policy.js');
      const strictTrust = isStrictTrustPolicy();
      const callerId = strictTrust ? resolveTrustedCallerId(options?.user) : options?.user;

      const { storeMemory } = await import('../storage/storage-facade.js');
      const coreMemory = await storeMemory({
        content: content.trim(),
        type: options?.type,
        tags: options?.tags,
        project: options?.project ?? this._activeProject,
        user: callerId ?? undefined,
        metadata: options?.metadata,
        sessionId: options?.sessionId,
        captureKey: options?.captureKey,
        occurredAt: options?.occurredAt,
        timeZone: options?.timeZone,
      });

      return mapCoreMemoryToSdk(coreMemory, strictTrust);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to store memory', error, {
        contentLength: typeof content === 'string' ? content.length : 0,
        project: options?.project ?? this._activeProject,
      });
    }
  }

  async recall(query: string, options?: RecallClientOptions): Promise<RecallResult> {
    try {
      if (!query?.trim()) {
        throw new SquishError('Query cannot be empty', 'VALIDATION_ERROR');
      }

      const { isStrictTrustPolicy, resolveTrustedCallerId } = await import('../acl/trust-policy.js');
      const strictTrust = isStrictTrustPolicy();
      const callerId = strictTrust ? resolveTrustedCallerId(options?.user) : options?.user;
      const { recall } = await import('../storage/storage-facade.js');
      const coreResult = await recall(query.trim(), {
        project: options?.project ?? this._activeProject,
        limit: options?.limit,
        type: options?.type,
        tags: options?.tags,
        user: callerId ?? undefined,
        strategy: options?.strategy as any,
        referenceDate: options?.referenceDate,
        timeZone: options?.timeZone,
        latestOnly: options?.latestOnly,
        validTimeFrom: options?.validTimeFrom,
        validTimeTo: options?.validTimeTo,
      });
      const { applyAclReadGate, buildAutoAclContext } = await import('../acl/read-gate.js');
      const acl = await buildAutoAclContext(callerId, options?.teamId ? [options.teamId] : undefined);
      const visibleMemories = await applyAclReadGate(coreResult.memories, acl);

      return {
        memories: visibleMemories.map((memory) => mapCoreMemoryToSdk(memory, strictTrust)),
        graphEntities: strictTrust ? [] : coreResult.graphEntities,
        routing: coreResult.routing,
        metadata: coreResult.metadata,
      };
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to recall memories', error, {
        query,
        project: options?.project ?? this._activeProject,
      });
    }
  }

  /** Return bounded, machine-readable recall evidence without changing recall()'s legacy shape. */
  async recallCompact(query: string, options?: CompactRecallOptions): Promise<RecallResponse> {
    const result = await this.recall(query, options);
    return buildRecallResponse(query, result.memories, { maxTokens: options?.maxTokens });
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    try {
      if (!query?.trim()) {
        throw new SquishError('Query cannot be empty', 'VALIDATION_ERROR');
      }

      const { isStrictTrustPolicy, resolveTrustedCallerId } = await import('../acl/trust-policy.js');
      const strictTrust = isStrictTrustPolicy();
      const callerId = strictTrust ? resolveTrustedCallerId(options?.user) : options?.user;
      const { queryMemories } = await import('../storage/storage-facade.js');
      const coreResults = await queryMemories({
        query: query.trim(),
        retrievalMode: options?.retrievalMode,
        limit: options?.limit ?? 10,
        project: options?.project ?? this._activeProject,
        user: callerId ?? undefined,
        teamId: options?.teamId,
        referenceDate: options?.referenceDate,
        timeZone: options?.timeZone,
        latestOnly: options?.latestOnly,
        validTimeFrom: options?.validTimeFrom,
        validTimeTo: options?.validTimeTo,
      });

      const authorizedResults = strictTrust
        ? await (async () => {
            const { applyAclReadGate, buildAutoAclContext } = await import('../acl/read-gate.js');
            const acl = await buildAutoAclContext(callerId, options?.teamId ? [options.teamId] : undefined);
            return applyAclReadGate(
              coreResults,
              acl,
              (result) => ((result as { corpus?: string }).corpus === 'belief' ? 'knowledge' : 'memory')
            );
          })()
        : coreResults;
      let results = authorizedResults.map((result) => mapCoreSearchResultToSdk(result, strictTrust));

      if (options?.minScore != null && options.minScore > 0) {
        results = results.filter(r => r.score >= options.minScore!);
      }

      return results;
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      // Surface the real failure. The generic 'Failed to search memories' with
      // the cause parked in `.cause` told an operator nothing, and nothing on
      // the MCP path ever logged it. logger.error prints error.stack.
      throw wrapStorageError('Failed to search memories', error, {
        query,
        project: options?.project ?? this._activeProject,
      });
    }
  }

  async feedback(
    targetType: 'memory' | 'belief' | 'strategy',
    id: string,
    signal: 'confirm' | 'contradict' | 'used',
    options?: { userId?: string }
  ): Promise<{
    ok: boolean;
    applied: boolean;
    targetType: string;
    id: string;
    signal: string;
    confidence?: number;
    detail?: string;
  }> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError, resolveTrustedCallerId } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        const callerId = resolveTrustedCallerId(options?.userId);
        if (!callerId) throw new TrustBoundaryError('Strict feedback requires a bound caller');
        if (targetType === 'strategy') {
          const { writeTrustAudit } = await import('../acl/trust-audit.js');
          try {
            await writeTrustAudit({
              actorId: callerId,
              resourceId: id,
              assetType: 'knowledge',
              decision: 'deny',
              reason: 'strict_surface',
            });
          } catch {
            throw new TrustBoundaryError('Strict strategy feedback is denied and its audit record could not be persisted');
          }
          throw new TrustBoundaryError('Strict strategy feedback requires signed single-source lineage');
        }
        const { applyStrictMemoryFeedback } = await import('../memory/strict-memory-feedback.js');
        return await applyStrictMemoryFeedback({ id, targetType, signal, callerId: callerId! });
      }
      const { applyFeedback } = await import('../memory/reinforcement.js');
      return await applyFeedback({ targetType, id, signal });
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to apply feedback', error, {
        targetType,
        id: describeId(id),
        signal,
      });
    }
  }

  // ─── Edit Proposal Workflow ──────────────────────────────────────────────

  async createEditProposal(input: {
    memoryId: string;
    proposedContent: string;
    reason: string;
    userId?: string;
  }): Promise<EditProposalRecord> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Edit proposals are disabled under strict trust until each action has caller, ACL, and provenance gates');
      if (!input?.memoryId?.trim() || !input?.proposedContent?.trim() || !input?.reason?.trim()) {
        throw new SquishError('memoryId, proposedContent, and reason are required', 'VALIDATION_ERROR');
      }
      const { createEditProposal } = await import('../memory/edit-workflow.js');
      return await createEditProposal(input.memoryId.trim(), input.proposedContent, input.reason, input.userId);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to create edit proposal', error, {
        memoryId: describeId(input?.memoryId),
      });
    }
  }

  async listEditProposals(filters: {
    memoryId?: string;
    status?: 'pending' | 'approved' | 'rejected' | 'expired';
    limit?: number;
  } = {}): Promise<EditProposalRecord[]> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Edit proposals are disabled under strict trust until each action has caller, ACL, and provenance gates');
      const { getEditProposals } = await import('../memory/edit-workflow.js');
      return await getEditProposals(filters);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to list edit proposals', error, {
        memoryId: describeId(filters?.memoryId),
        status: filters?.status,
      });
    }
  }

  async previewEditProposal(proposalId: string): Promise<{
    proposal: EditProposalRecord;
    diff: { removed: string[]; added: string[] };
  } | null> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Edit proposals are disabled under strict trust until each action has caller, ACL, and provenance gates');
      if (!proposalId?.trim()) {
        throw new SquishError('proposalId cannot be empty', 'VALIDATION_ERROR');
      }
      const { getEditProposalById, diffProposalContent } = await import('../memory/edit-workflow.js');
      const proposal = await getEditProposalById(proposalId.trim());
      if (!proposal) return null;
      return { proposal, diff: diffProposalContent(proposal) };
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to preview edit proposal', error, {
        proposalId: describeId(proposalId),
      });
    }
  }

  async approveEditProposal(proposalId: string, reviewNotes?: string): Promise<EditProposalActionResult> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Edit proposals are disabled under strict trust until each action has caller, ACL, and provenance gates');
      if (!proposalId?.trim()) {
        throw new SquishError('proposalId cannot be empty', 'VALIDATION_ERROR');
      }
      const { approveEditProposal } = await import('../memory/edit-workflow.js');
      return await approveEditProposal(proposalId.trim(), reviewNotes);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to approve edit proposal', error, {
        proposalId: describeId(proposalId),
      });
    }
  }

  async rejectEditProposal(proposalId: string, reviewNotes?: string): Promise<EditProposalActionResult> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Edit proposals are disabled under strict trust until each action has caller, ACL, and provenance gates');
      if (!proposalId?.trim()) {
        throw new SquishError('proposalId cannot be empty', 'VALIDATION_ERROR');
      }
      const { rejectEditProposal } = await import('../memory/edit-workflow.js');
      return await rejectEditProposal(proposalId.trim(), reviewNotes);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to reject edit proposal', error, {
        proposalId: describeId(proposalId),
      });
    }
  }

  async correctMemory(memoryId: string, content: string, reason: string): Promise<EditProposalActionResult> {
    try {
      // Core correction resolves and audits the authenticated caller itself.
      if (!memoryId?.trim() || !content?.trim() || !reason?.trim()) {
        throw new SquishError('memoryId, content, and reason are required', 'VALIDATION_ERROR');
      }
      const { correctMemory } = await import('../memory/edit-workflow.js');
      return await correctMemory(memoryId.trim(), content, reason);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to apply correction', error, {
        memoryId: describeId(memoryId),
      });
    }
  }

  async stalenessReport(options?: {
    projectId?: string;
    olderThanDays?: number;
    minImportance?: number;
    limit?: number;
  }): Promise<StalenessReportResult> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Staleness reports are disabled under strict trust until report rows are filtered by caller and provenance');
      const { buildStalenessReport } = await import('../memory/staleness-report.js');
      return await buildStalenessReport(options);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      if (error instanceof Error && error.name === 'TrustBoundaryError') throw error;
      throw new StorageError('Failed to build staleness report', error as Error);
    }
  }

  async getById(id: string, caller?: { userId?: string; teamIds?: string[] }): Promise<MemoryRecord | null> {
    try {
      if (!id?.trim()) {
        throw new SquishError('ID cannot be empty', 'VALIDATION_ERROR');
      }

      const strict = isStrictTrustPolicy();
      const trustedCaller = await resolveSdkReadCaller(caller);
      let coreMemory: import('../memory/memory-types.js').MemoryRecord | null;
      let strictAccessCount: number | null = null;
      if (strict) {
        const { getDb } = await import('../../db/index.js');
        const { getSchema } = await import('../../db/schema.js');
        const { createDatabaseClient } = await import('../storage/database.js');
        const { eq } = await import('drizzle-orm');
        const { normalizeMemoryRecord } = await import('../memory/memory-crud.js');
        const rawDatabase = await getDb();
        const db = createDatabaseClient(rawDatabase);
        const schema = await getSchema();
        const rows = await db.select().from(schema.memories).where(eq(schema.memories.id, id.trim())).limit(1);
        const row = rows[0];
        if (!row) {
          coreMemory = null;
        } else if (Boolean(row.isEncrypted ?? row.is_encrypted)) {
          const { preauthorizeStrictMemoryReadBeforeDecrypt } = await import('../acl/read-gate.js');
          if (!await preauthorizeStrictMemoryReadBeforeDecrypt(id.trim(), trustedCaller.userId!)) {
            coreMemory = null;
          } else {
            const ciphertext = row.encryptedContent ?? row.encrypted_content;
            const nonce = row.encryptionNonce ?? row.encryption_nonce;
            if (!ciphertext || !nonce) throw new TrustBoundaryError('Strict encrypted memory is missing ciphertext metadata');
            coreMemory = normalizeMemoryRecord({ ...row, content: decrypt(ciphertext, nonce) });
          }
        } else {
          coreMemory = normalizeMemoryRecord(row);
        }
        strictAccessCount = rows[0]?.accessCount ?? 0;
      } else {
        const { getMemoryById } = await import('../storage/storage-facade.js');
        coreMemory = await getMemoryById(id.trim());
      }
      if (!coreMemory) return null;

      const { applyAclReadGate, buildAutoAclContext } = await import('../acl/read-gate.js');
      const acl = await buildAutoAclContext(trustedCaller.userId, trustedCaller.teamIds);
      const visible = await applyAclReadGate([coreMemory], acl);
      if (visible.length === 0) return null;

      if (strict) {
        const { getDb } = await import('../../db/index.js');
        const { getSchema } = await import('../../db/schema.js');
        const { createDatabaseClient } = await import('../storage/database.js');
        const { eq } = await import('drizzle-orm');
        const db = createDatabaseClient(await getDb());
        const schema = await getSchema();
        await db.update(schema.memories)
          .set({ accessCount: (strictAccessCount ?? 0) + 1, lastAccessedAt: new Date() })
          .where(eq(schema.memories.id, coreMemory.id));
      }

      return mapCoreMemoryToSdk(coreMemory, strict);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get memory', error, { id: describeId(id) });
    }
  }

  async forget(
    id: string,
    caller?: { userId?: string; teamIds?: string[]; expectedProjectId?: string | null },
  ): Promise<boolean> {
    try {
      if (!id?.trim()) {
        throw new SquishError('ID cannot be empty', 'VALIDATION_ERROR');
      }

      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      const { deleteMemoryPermanently, deleteMemoryPermanentlyWithScopeFence } = await import('../memory/stale-cleaner.js');
      let trustedCaller: { userId?: string; teamIds?: string[]; expectedProjectId?: string | null } | undefined;
      if (isStrictTrustPolicy()) {
        trustedCaller = {
          ...await resolveSdkReadCaller(caller),
          ...(caller?.expectedProjectId !== undefined ? { expectedProjectId: caller.expectedProjectId } : {}),
        };
      } else if (caller?.expectedProjectId !== undefined) {
        trustedCaller = { expectedProjectId: caller.expectedProjectId };
      }
      if (caller?.expectedProjectId !== undefined) {
        return await deleteMemoryPermanentlyWithScopeFence(id.trim(), caller.expectedProjectId, trustedCaller);
      }
      await deleteMemoryPermanently(id.trim(), trustedCaller);
      return true;
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to delete memory', error, { id: describeId(id) });
    }
  }

  // ─── Graph Operations ────────────────────────────────────────────────────

  async getEntity(
    name: string,
    project?: string,
    caller?: { userId?: string; teamIds?: string[] },
  ): Promise<{ entity: EntityRecord | null; relations: EntityRelation[]; mentionCount: number } | null> {
    try {
      if (!name?.trim()) {
        throw new SquishError('Entity name cannot be empty', 'VALIDATION_ERROR');
      }

      const projectId = project ?? this._activeProject;
      if (!projectId) {
        throw new SquishError('Project is required for getEntity', 'VALIDATION_ERROR');
      }

      const { getEntity } = await import('../storage/entity-ops.js');
      const { isStrictTrustPolicy } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        const { buildAutoAclContext } = await import('../acl/read-gate.js');
        await buildAutoAclContext(caller?.userId, caller?.teamIds);
        throw new SquishError('Raw graph entity reads are disabled under strict trust until edge provenance is enforced', 'TRUST_BOUNDARY_ERROR');
      }
      return await getEntity(name.trim(), projectId);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw new StorageError('Failed to get entity', error as Error);
    }
  }

  async traverseGraph(
    name: string,
    project?: string,
    options?: GraphOptions
  ): Promise<GraphTraversalResult> {
    try {
      if (!name?.trim()) {
        throw new SquishError('Entity name cannot be empty', 'VALIDATION_ERROR');
      }

      const projectId = project ?? this._activeProject;
      if (!projectId) {
        throw new SquishError('Project is required for traverseGraph', 'VALIDATION_ERROR');
      }

      const { isStrictTrustPolicy } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        const { buildAutoAclContext } = await import('../acl/read-gate.js');
        await buildAutoAclContext(options?.userId, options?.teamIds);
        throw new SquishError('Raw graph traversal is disabled under strict trust until edge provenance is enforced', 'TRUST_BOUNDARY_ERROR');
      }

      const { traverseGraph } = await import('../storage/graph-ops.js');
      return await traverseGraph(name.trim(), projectId, {
        maxDepth: options?.maxDepth,
        limit: options?.limit,
      }) as any;
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw new StorageError('Failed to traverse graph', error as Error);
    }
  }

  // ─── Context & Projects ──────────────────────────────────────────────────

  async getContext(options?: ContextOptions): Promise<MemoryRecord[]> {
    try {
      const project = options?.project ?? this._activeProject;
      const limit = options?.limit ?? 10;

      const { isStrictTrustPolicy } = await import('../acl/trust-policy.js');
      const strict = isStrictTrustPolicy();
      const trustedCaller = await resolveSdkReadCaller({ userId: options?.user });
      const { recall } = await import('../storage/storage-facade.js');
      const result = await recall('', {
        project,
        limit,
        user: trustedCaller.userId,
      });
      const { applyAclReadGate, buildAutoAclContext } = await import('../acl/read-gate.js');
      const acl = await buildAutoAclContext(trustedCaller.userId, options?.teamId ? [options.teamId] : undefined);
      const visible = await applyAclReadGate(result.memories, acl);
      return visible.map((memory) => mapCoreMemoryToSdk(memory, strict));
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get context', error, {
        project: options?.project ?? this._activeProject,
      });
    }
  }

  async listProjects(): Promise<ProjectRecord[]> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Project listing is disabled under strict trust until projects have owner-scoped visibility');
      const { getAllProjects } = await import('../projects.js');
      return await getAllProjects();
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to list projects', error, {
        project: this._activeProject,
      });
    }
  }

  async deleteProject(projectId: string): Promise<boolean> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Project deletion is disabled under strict trust until caller role and project ownership are enforced');
      const { deleteProject, getProjectById } = await import('../projects.js');
      const project = await getProjectById(projectId);
      const deleted = await deleteProject(projectId);
      if (deleted && project && this._activeProject === project.path) {
        this._activeProject = undefined;
      }
      return deleted;
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to delete project', error, { project: this._activeProject });
    }
  }

  setProject(project: string): void {
    if (!project?.trim()) {
      throw new SquishError('Project path cannot be empty', 'VALIDATION_ERROR');
    }
    this._activeProject = project.trim();
  }

  // ─── Stats & Health ──────────────────────────────────────────────────────

  async stats(project?: string): Promise<MemoryStats> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        throw new TrustBoundaryError('Aggregate memory statistics are disabled under strict trust until aggregate provenance is enforced');
      }
      const { getMemoryStats } = await import('../memory/stats.js');
      return await getMemoryStats(project ?? this._activeProject);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get stats', error, {
        project: project ?? this._activeProject,
      });
    }
  }

  /** CLI alias for stats() — the status command calls getStats(). */
  async getStats(project?: string): Promise<MemoryStats> {
    return this.stats(project);
  }

  async health(): Promise<HealthResult> {
    const components: Record<string, string> = {};

    try {
      const { getDb } = await import('../../db/index.js');
      const db = await getDb();
      if (db) {
        components['database'] = 'ok';
      } else {
        components['database'] = 'error: no connection';
      }
    } catch (error) {
      components['database'] = `error: ${error instanceof Error ? error.message : 'unknown'}`;
    }

    try {
      const { getEmbedding } = await import('../embeddings.js');
      await getEmbedding('health check');
      components['embeddings'] = 'ok';
    } catch (error) {
      components['embeddings'] = `degraded: ${error instanceof Error ? error.message : 'unknown'}`;
    }

    const hasErrors = Object.values(components).some(v => v.startsWith('error'));
    const hasDegraded = Object.values(components).some(v => v.startsWith('degraded'));

    return {
      status: hasErrors ? 'error' : hasDegraded ? 'degraded' : 'ok',
      components,
    };
  }

  // ─── Governance ──────────────────────────────────────────────────────────

  async pinMemory(id: string, options?: PinOptions): Promise<void> {
    try {
      const { pinMemory } = await import('../security/governance.js');
      await pinMemory(id);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to pin memory', error, { id: describeId(id) });
    }
  }

  async unpinMemory(id: string, options?: PinOptions): Promise<void> {
    try {
      const { unpinMemory } = await import('../security/governance.js');
      await unpinMemory(id);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to unpin memory', error, { id: describeId(id) });
    }
  }

  async getPinnedMemories(project?: string): Promise<MemoryRecord[]> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        throw new TrustBoundaryError('Pinned-memory listing is disabled under strict trust until the listing is identity and provenance gated');
      }
      const { getPinnedMemories } = await import('../security/governance.js');
      const memories = await getPinnedMemories(project ?? this._activeProject);
      return memories.map((memory) => mapCoreMemoryToSdk(memory));
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get pinned memories', error, {
        project: project ?? this._activeProject,
      });
    }
  }

  // ─── Memory Tiers ────────────────────────────────────────────────────────

  async promoteToSturdy(id: string): Promise<void> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Memory tier promotion is disabled under strict trust until caller, ACL, and provenance checks cover the mutation');
      const { promoteToSturdy } = await import('../memory/tiers.js');
      await promoteToSturdy(id);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to promote memory', error, { id: describeId(id) });
    }
  }

  async getTierStats(project?: string): Promise<Record<string, number>> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        throw new TrustBoundaryError('Aggregate tier statistics are disabled under strict trust until aggregate provenance is enforced');
      }
      const { getTierStats } = await import('../memory/tiers.js');
      return await getTierStats(project ?? this._activeProject);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get tier stats', error, {
        project: project ?? this._activeProject,
      });
    }
  }

  // ─── Memory Retrieval ────────────────────────────────────────────────────

  async getRecent(limit?: number, project?: string): Promise<MemoryRecord[]> {
    try {
      const { applyAclReadGate, buildAutoAclContext } = await import('../acl/read-gate.js');
      const strict = isStrictTrustPolicy();
      let acl: Awaited<ReturnType<typeof buildAutoAclContext>> = null;
      if (strict) await resolveSdkReadCaller();
      else {
        const trustedCaller = await resolveSdkReadCaller();
        acl = await buildAutoAclContext(trustedCaller.userId);
      }
      const { getRecent } = await import('../memory/memories.js');
      const requestedLimit = limit ?? 10;
      const memories = await getRecent(project ?? this._activeProject!, strict
        ? Math.min(500, Math.max(1, Math.floor(requestedLimit)) * 10)
        : requestedLimit);
      const visible = strict
        ? memories.slice(0, Math.max(0, Math.floor(requestedLimit)))
        : await applyAclReadGate(memories, acl);
      return visible.map((memory) => mapCoreMemoryToSdk(memory, strict));
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get recent memories', error, {
        limit,
        project: project ?? this._activeProject,
      });
    }
  }

  async listRecent(options?: ListRecentOptions): Promise<MemoryRecord[]> {
    try {
      const { applyAclReadGate, buildAutoAclContext, buildStrictMemoryCandidateFilter } = await import('../acl/read-gate.js');
      const { isStrictTrustPolicy } = await import('../acl/trust-policy.js');
      const trustedCaller = await resolveSdkReadCaller();
      const acl = await buildAutoAclContext(trustedCaller.userId);
      const { vectorSearch } = await import('../memory/vector-search.js');
      const candidateFilter = isStrictTrustPolicy()
        ? await buildStrictMemoryCandidateFilter({ userId: trustedCaller.userId! })
        : undefined;
      const results = await vectorSearch(
        { query: '', project: options?.project ?? this._activeProject },
        { limit: options?.limit ?? 50, ...(candidateFilter ? { candidateFilter } : {}) }
      );
      const strict = isStrictTrustPolicy();
      const visibleResults = await applyAclReadGate(results, acl);
      let memories = visibleResults.map((memory) => mapCoreMemoryToSdk(memory, strict));
      const hoursBack = options?.hoursBack;
      if (hoursBack != null && hoursBack > 0) {
        const cutoffMs = Date.now() - hoursBack * 3_600_000;
        memories = memories.filter((memory) => memory.createdAt !== undefined && memory.createdAt.getTime() >= cutoffMs);
      }
      return memories;
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to list recent memories', error, {
        project: options?.project ?? this._activeProject,
      });
    }
  }

  async getMemorySnapshot(project?: string): Promise<unknown> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        throw new TrustBoundaryError('Raw memory snapshots are disabled under strict trust until snapshot provenance is enforced');
      }
      const { getMemorySnapshot } = await import('../snapshots/retrieval.js');
      return await getMemorySnapshot(project ?? this._activeProject!);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get memory snapshot', error, {
        project: project ?? this._activeProject,
      });
    }
  }

  async getCorrectionHistory(memoryId: string, userId?: string): Promise<StrictCorrectionHistory | unknown[]> {
    try {
      const { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        const callerId = resolveTrustedCallerId(userId);
        if (!callerId) throw new TrustBoundaryError('Correction history requires an authenticated caller');
        const { getStrictCorrectionHistory } = await import('../snapshots/retrieval.js');
        return await getStrictCorrectionHistory(memoryId, callerId);
      }
      const { getMemoryHistory } = await import('../snapshots/retrieval.js');
      return (await getMemoryHistory(memoryId)).filter((snapshot: { snapshotType?: string }) => snapshot.snapshotType === 'correction');
    } catch (error) {
      const { TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (error instanceof SquishError || error instanceof TrustBoundaryError) throw error;
      throw wrapStorageError('Failed to get correction history', error, { memoryId });
    }
  }

  // ─── Associations ────────────────────────────────────────────────────────

  async createAssociation(fromId: string, toId: string, type?: string): Promise<void> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Association writes are disabled under strict trust until caller, ACL, and edge provenance checks are available');
      const { createAssociation } = await import('../associations.js');
      await createAssociation(fromId, toId, type as any);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to create association', error, {
        fromId: describeId(fromId),
        toId: describeId(toId),
      });
    }
  }

  async getRelatedMemories(id: string, caller?: { userId?: string; teamIds?: string[] }): Promise<MemoryRecord[]> {
    try {
      const seed = await this.getById(id, caller);
      if (!seed) return [];
      const { getRelatedMemories } = await import('../associations.js');
      const memories = await getRelatedMemories(id);
      const { isStrictTrustPolicy } = await import('../acl/trust-policy.js');
      const { applyAclReadGate, buildAutoAclContext } = await import('../acl/read-gate.js');
      const trustedCaller = await resolveSdkReadCaller(caller);
      const strict = isStrictTrustPolicy();
      const acl = await buildAutoAclContext(trustedCaller.userId, trustedCaller.teamIds);
      const visible = await applyAclReadGate(memories, acl);
      return visible.map((memory) => mapCoreMemoryToSdk(memory, strict));
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get related memories', error, { id: describeId(id) });
    }
  }

  // ─── Graph Building ──────────────────────────────────────────────────────

  async buildGraph(project?: string): Promise<GraphBuildStats> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Graph building is disabled under strict trust until source ownership and edge provenance are enforced');
      const { buildGraphForProject } = await import('../graph/graph-builder.js');
      const stats = await buildGraphForProject(project ?? this._activeProject!);
      return {
        memoriesProcessed: stats.memoriesProcessed,
        entitiesCreated: stats.entitiesCreated,
        relationsCreated: stats.relationsCreated,
        entitiesDeduplicated: stats.entitiesDeduplicated,
        errors: stats.errors,
        durationMs: stats.durationMs,
      };
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to build graph', error, {
        project: project ?? this._activeProject,
      });
    }
  }

  // ─── Places ──────────────────────────────────────────────────────────────

  async getPlaces(project?: string): Promise<PlaceRecord[]> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Place listing is disabled under strict trust until place metadata has caller-scoped ACL and provenance');
      const { getProjectPlaces } = await import('../places/places.js');
      const projectId = await resolveRuntimeProjectId(project ?? this._activeProject);
      const places = await getProjectPlaces(projectId);
      return places.map((p: any) => ({
        id: p.id,
        name: p.name,
        memories: [],
      }));
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get places', error, {
        project: project ?? this._activeProject,
      });
    }
  }

  // ─── Sessions ────────────────────────────────────────────────────────────

  async listSessions(options?: SessionOptions): Promise<SessionRecord[]> {
    try {
      const { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        resolveTrustedCallerId();
        throw new TrustBoundaryError('Raw external session history is disabled under strict trust until source ACL and provenance are enforced');
      }
      const { listSessions } = await import('../sessions/index.js');
      const result = await listSessions({
        project: options?.project ?? this._activeProject,
        limit: options?.limit,
        source: (options as { source?: import('../sessions/agent-stores/types.js').SessionSource } | undefined)?.source,
      });
      return result.sessions.map((s: any) => ({
        id: s.session_id,
        title: s.title,
        project: s.project,
        branch: s.branch,
        agent: s.agent,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        status: s.status,
        chunkCount: s.chunk_count,
        memoryCount: s.chunk_count,
      }));
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to list sessions', error, {
        project: options?.project ?? this._activeProject,
      });
    }
  }

  async getSessionChunks(sessionId: string, options?: { source?: SessionSourceOption }): Promise<ChunkRecord[]> {
    try {
      const { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        resolveTrustedCallerId();
        throw new TrustBoundaryError('Raw external session history is disabled under strict trust until source ACL and provenance are enforced');
      }
      const { getSessionChunks } = await import('../sessions/index.js');
      const result = await getSessionChunks(sessionId, { source: options?.source ?? 'all' });
      if (!result?.chunks) return [];
      return result.chunks.map((c: any) => ({
        id: c.id,
        sessionId: c.session_id,
        content: c.content,
        type: c.chunk_type ?? c.type,
        agent: c.agent,
        sessionTitle: c.session_title,
        timestamp: c.timestamp,
      }));
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get session chunks', error, {
        sessionId: describeId(sessionId),
      });
    }
  }

  /** Get a single session by ID — used by the CLI inspect command. */
  async getSession(sessionId: string): Promise<{ id: string; chunks: ChunkRecord[]; summary?: string } | null> {
    try {
      const { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        resolveTrustedCallerId();
        throw new TrustBoundaryError('Raw external session history is disabled under strict trust until source ACL and provenance are enforced');
      }
      const { getSessionChunks } = await import('../sessions/index.js');
      const session = await getSessionChunks(sessionId);
      if (!session) return null;
      const chunks = await this.getSessionChunks(sessionId);
      return {
        id: session.session_id,
        chunks,
        summary: session.title,
      };
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get session', error, {
        sessionId: describeId(sessionId),
      });
    }
  }

  async searchChunksDetailed(query: string, options?: { limit?: number; source?: SessionSourceOption; project?: string; scanBudgetSessions?: number; scanTimeoutMs?: number }) {
    try {
      const { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        resolveTrustedCallerId();
        throw new TrustBoundaryError('Raw external session history is disabled under strict trust until source ACL and provenance are enforced');
      }
      const { searchChunksDetailed } = await import('../sessions/index.js');
      const detailed = await searchChunksDetailed({
        query,
        limit: options?.limit,
        source: options?.source ?? 'all',
        project: options?.project,
        scan_budget_sessions: options?.scanBudgetSessions,
        scan_timeout_ms: options?.scanTimeoutMs,
      });
      return {
        results: detailed.results.map((r: any) => ({
        id: r.memory_id ?? '',
        sessionId: r.chunk?.session_id ?? '',
        content: r.chunk?.content ?? '',
        type: r.chunk?.type ?? '',
        agent: r.chunk?.agent,
        sessionTitle: r.chunk?.session_title,
        why: r.why,
        })),
        diagnostics: detailed.diagnostics,
      };
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to search chunks', error, {
        query,
        limit: options?.limit,
      });
    }
  }

  async searchChunks(query: string, options?: { limit?: number; source?: SessionSourceOption; project?: string }): Promise<ChunkRecord[]> {
    const detailed = await this.searchChunksDetailed(query, options);
    return detailed.results;
  }

  async recoverCapturedSession(input: {
    sessionId: string;
    query?: string;
    project?: string;
    user?: string;
    teamId?: string;
    budgetTokens?: number;
    limit?: number;
    progressiveTree?: boolean;
    includeProjectContext?: boolean;
    expandNodeId?: string;
  }) {
    try {
      const { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } = await import('../acl/trust-policy.js');
      const strict = isStrictTrustPolicy();
      if (strict && !input.user?.trim()) {
        throw new TrustBoundaryError('Strict session recovery requires an explicitly authenticated caller identity');
      }
      const callerId = strict ? resolveTrustedCallerId(input.user) : input.user;
      const { recoverCapturedSession } = await import('../sessions/store.js');
      return await recoverCapturedSession({
        ...input,
        user: callerId ?? undefined,
        readTaggedMemories: (ids) => this.getMemoriesByIds(ids, {
          userId: callerId ?? undefined,
          teamIds: input.teamId ? [input.teamId] : undefined,
        }),
      });
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to recover captured session context', error, {
        sessionId: describeId(input.sessionId),
      });
    }
  }

  /** Capture validated session chunks as episodic memories through the core runtime. */
  async captureSessionChunks(
    chunks: Chunk[],
    options?: { project?: string; user?: string },
  ): Promise<string[]> {
    try {
      const { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } = await import('../acl/trust-policy.js');
      const callerId = isStrictTrustPolicy()
        ? resolveTrustedCallerId(options?.user)
        : options?.user;
      if (isStrictTrustPolicy() && !callerId) {
        throw new TrustBoundaryError('Capturing session memories requires an authenticated caller');
      }
      const { captureChunks } = await import('../sessions/store.js');
      return await captureChunks(chunks, {
        project: options?.project ?? this._activeProject,
        user: callerId ?? undefined,
      });
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to capture session chunks', error, {
        chunkCount: Array.isArray(chunks) ? chunks.length : 0,
        project: options?.project ?? this._activeProject,
      });
    }
  }

  /** Capture Codex user/assistant turns from the local host store by session ID. */
  async captureHostSession(
    agent: 'codex' | 'claude-code' | 'opencode' | 'gemini',
    sessionId: string,
    options?: { user?: string },
  ): Promise<string[]> {
    try {
      const { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } = await import('../acl/trust-policy.js');
      const callerId = isStrictTrustPolicy()
        ? resolveTrustedCallerId(options?.user)
        : options?.user;
      if (isStrictTrustPolicy() && !callerId) {
        throw new TrustBoundaryError('Capturing a host session requires an authenticated caller');
      }
      const { captureHostSession } = await import('../sessions/store.js');
      return await captureHostSession(agent, sessionId, { user: callerId ?? undefined });
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to capture host session', error, {
        sessionId: describeId(sessionId),
      });
    }
  }

  async captureCodexSession(sessionId: string, options?: { user?: string }): Promise<string[]> {
    return this.captureHostSession('codex', sessionId, options);
  }

  /** Permanently remove captured episodic chunks for one source session. */
  async forgetCapturedSession(
    sessionId: string,
    options?: { project?: string; user?: string; teamId?: string },
  ): Promise<{ deleted: number }> {
    try {
      const { isStrictTrustPolicy, resolveTrustedCallerId } = await import('../acl/trust-policy.js');
      const callerId = isStrictTrustPolicy()
        ? resolveTrustedCallerId(options?.user) ?? undefined
        : options?.user;
      const { forgetCapturedSession } = await import('../sessions/store.js');
      return await forgetCapturedSession({
        sessionId,
        project: options?.project ?? this._activeProject,
        user: callerId,
        teamIds: options?.teamId ? [options.teamId] : undefined,
        readTaggedMemories: (ids) => this.getMemoriesByIds(ids, {
          userId: callerId,
          teamIds: options?.teamId ? [options.teamId] : undefined,
        }),
      });
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to forget captured session memories', error, {
        sessionId: describeId(sessionId),
        project: options?.project ?? this._activeProject,
      });
    }
  }

  // ─── Dedup / Merge Workflow ──────────────────────────────────────────────

  async dedupScan(input: DedupScanInput = {}): Promise<DedupScanResult> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Deduplication is disabled under strict trust until proposals and source mutations are caller and provenance gated');
      const { handleDetectDuplicates } = await import('../algorithms/handlers/detect-duplicates.js');
      const result = await handleDetectDuplicates({
        projectId: input.projectId,
        threshold: input.threshold,
        memoryType: input.memoryType as any,
        limit: input.limit,
        autoCreateProposals: input.autoCreateProposals ?? true,
      });

      if (result.ok && result.data && result.data.proposalIds.length > 0) {
        const distribution = await this.getMergeConfidenceDistribution(result.data.proposalIds);
        (result.data as Record<string, unknown>).confidenceDistribution = distribution;
      }

      return result as DedupScanResult;
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to scan for duplicates', error, {
        projectId: input.projectId,
        threshold: input.threshold,
      });
    }
  }

  async listMergeProposals(input: MergeProposalListInput): Promise<MergeListResult> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Deduplication is disabled under strict trust until proposals and source mutations are caller and provenance gated');
      const { handleListProposals } = await import('../algorithms/handlers/list-proposals.js');
      return await handleListProposals({
        projectId: input.projectId,
        status: input.status,
        limit: input.limit,
      }) as MergeListResult;
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to list merge proposals', error, {
        projectId: input.projectId,
        status: input.status,
      });
    }
  }

  async previewMerge(proposalId: string): Promise<MergePreviewResult> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Deduplication is disabled under strict trust until proposals and source mutations are caller and provenance gated');
      const { handlePreviewMerge } = await import('../algorithms/handlers/preview-merge.js');
      return await handlePreviewMerge({ proposalId }) as MergePreviewResult;
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to preview merge', error, {
        proposalId: describeId(proposalId),
      });
    }
  }

  async approveMerge(input: { proposalId: string; reviewNotes?: string }): Promise<MergeActionResult> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Deduplication is disabled under strict trust until proposals and source mutations are caller and provenance gated');
      const { handleApproveMerge } = await import('../algorithms/handlers/approve-merge.js');
      return await handleApproveMerge(input) as MergeActionResult;
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to approve merge', error, {
        proposalId: describeId(input.proposalId),
      });
    }
  }

  async rejectMerge(input: { proposalId: string; reviewNotes?: string }): Promise<MergeActionResult> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Deduplication is disabled under strict trust until proposals and source mutations are caller and provenance gated');
      const { handleRejectMerge } = await import('../algorithms/handlers/reject-merge.js');
      return await handleRejectMerge(input) as MergeActionResult;
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to reject merge', error, {
        proposalId: describeId(input.proposalId),
      });
    }
  }

  async reverseMerge(input: { mergeHistoryId: string; reason?: string }): Promise<MergeReversalResult> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Deduplication is disabled under strict trust until proposals and source mutations are caller and provenance gated');
      const { handleReverseMerge } = await import('../algorithms/handlers/reverse-merge.js');
      return await handleReverseMerge(input) as MergeReversalResult;
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to reverse merge', error, {
        mergeHistoryId: describeId(input.mergeHistoryId),
      });
    }
  }

  async dedupAutoMerge(input: { threshold?: number; cap?: number } = {}): Promise<DedupAutoResult> {
    const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
    if (isStrictTrustPolicy()) throw new TrustBoundaryError('Deduplication is disabled under strict trust until proposals and source mutations are caller and provenance gated');
    if (process.env.SQUISH_DEDUP_AUTO !== 'true') {
      return {
        ok: false,
        gated: true,
        approved: 0,
        merges: [],
        message:
          'Auto-merge is disabled by default. Set environment variable SQUISH_DEDUP_AUTO=true to enable, then re-run.',
      };
    }

    const threshold = input.threshold ?? 0.95;
    const cap = Math.max(1, input.cap ?? 25);

    const projects = await this.listProjects();
    const merges: DedupAutoMergeRecord[] = [];

    for (const project of projects) {
      if (merges.length >= cap) break;

      const listing = await this.listMergeProposals({ projectId: project.id, status: 'pending', limit: cap * 2 });
      if (!listing.ok || !listing.data) continue;

      const eligible = listing.data.proposals
        .filter((p) => p.similarityScore >= threshold)
        .sort((a, b) => b.similarityScore - a.similarityScore);

      for (const proposal of eligible) {
        if (merges.length >= cap) break;
        const result = await this.approveMerge({
          proposalId: proposal.id,
          reviewNotes: `auto-merge: similarity=${proposal.similarityScore.toFixed(3)} >= ${threshold}`,
        });
        const data = result.data;
        if (result.ok && data?.proposalId && data.canonicalMemoryId && data.mergedMemoryIds) {
          merges.push({
            proposalId: data.proposalId,
            canonicalMemoryId: data.canonicalMemoryId,
            mergedMemoryIds: data.mergedMemoryIds,
            mergeHistoryId: data.mergeHistoryId ?? null,
            tokensSaved: data.tokensSaved,
          });
        }
      }
    }

    return { ok: true, gated: false, approved: merges.length, merges };
  }

  private async getMergeConfidenceDistribution(proposalIds: string[]): Promise<Record<string, number>> {
    const distribution: Record<string, number> = { high: 0, medium: 0, low: 0 };
    try {
      const { getDb } = await import('../../db/index.js');
      const { getSchema } = await import('../../db/schema.js');
      const { createDatabaseClient } = await import('../storage/database.js');
      const { inArray } = await import('drizzle-orm');

      const db = createDatabaseClient(await getDb());
      const schema = await getSchema();
      const rows = await db
        .select()
        .from(schema.memoryMergeProposals)
        .where(inArray(schema.memoryMergeProposals.id, proposalIds));

      for (const row of rows) {
        const level = (row.confidenceLevel as string) || 'low';
        distribution[level] = (distribution[level] || 0) + 1;
      }
    } catch {
      // Distribution is best-effort enrichment
    }
    return distribution;
  }

  // ─── Batch Memory Fetch ──────────────────────────────────────────────────

  async getMemoriesByIds(ids: string[], caller?: { userId?: string; teamIds?: string[] }): Promise<MemoryRecord[]> {
    try {
      if (!ids || ids.length === 0) return [];
      const { getDb } = await import('../../db/index.js');
      const { getSchema } = await import('../../db/schema.js');
      const { createDatabaseClient } = await import('../storage/database.js');
      const { inArray } = await import('drizzle-orm');
      const { normalizeMemoryRecord } = await import('../memory/memory-crud.js');

      const db = createDatabaseClient(await getDb());
      const schema = await getSchema();
      const rows = await db.select().from(schema.memories).where(inArray(schema.memories.id, ids));
      const { applyAclReadGate, buildAutoAclContext } = await import('../acl/read-gate.js');
      const trustedCaller = await resolveSdkReadCaller(caller);
      const acl = await buildAutoAclContext(trustedCaller.userId, trustedCaller.teamIds);
      const strict = (await import('../acl/trust-policy.js')).isStrictTrustPolicy();
      const normalized: import('../memory/memory-types.js').MemoryRecord[] = [];
      for (const row of rows) {
        if (Boolean(row.isEncrypted ?? row.is_encrypted)) {
          if (strict) {
            const { preauthorizeStrictMemoryReadBeforeDecrypt } = await import('../acl/read-gate.js');
            if (!trustedCaller.userId || !await preauthorizeStrictMemoryReadBeforeDecrypt(row.id, trustedCaller.userId)) continue;
          }
          const ciphertext = row.encryptedContent ?? row.encrypted_content;
          const nonce = row.encryptionNonce ?? row.encryption_nonce;
          if (!ciphertext || !nonce) {
            if (strict) throw new TrustBoundaryError('Strict encrypted memory is missing ciphertext metadata');
            throw new Error('Encrypted memory is missing ciphertext metadata');
          }
          normalized.push(normalizeMemoryRecord({ ...row, content: decrypt(ciphertext, nonce) }));
        } else {
          normalized.push(normalizeMemoryRecord(row));
        }
      }
      const visible = await applyAclReadGate(normalized, acl);
      return visible.map((memory) => mapCoreMemoryToSdk(memory, strict));
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to fetch memories by IDs', error, {
        count: Array.isArray(ids) ? ids.length : 0,
      });
    }
  }

  // ─── Place Memories ──────────────────────────────────────────────────────

  async getPlaceMemories(placeIdOrType: string, limit: number = 50, caller?: { userId?: string; teamIds?: string[]; project?: string }): Promise<string[]> {
    try {
      const { getPlaceMemories } = await import('../places/memory-places.js');
      const { isStrictTrustPolicy } = await import('../acl/trust-policy.js');
      const strict = isStrictTrustPolicy();
      const requestedLimit = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 50)));
      if (!strict) {
        const projectId = await resolveRuntimeProjectId(caller?.project ?? this._activeProject);
        const ids = await getPlaceMemories(placeIdOrType, requestedLimit, 0, projectId);
        const memories = await this.getMemoriesByIds(ids, caller);
        return memories.map((memory) => memory.id);
      }

      // Place edges are not yet backed by a signed source or caller-scoped
      // authorization contract, so filtering their IDs after reading them is
      // insufficient to make strict retrieval trustworthy.
      const { denyUnscopedPlaceOperation } = await import('../places/strict-gates.js');
      return await denyUnscopedPlaceOperation('list_members', placeIdOrType);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to get place memories', error, {
        placeIdOrType: describeId(placeIdOrType),
        limit,
      });
    }
  }

  // ─── Related Sessions ────────────────────────────────────────────────────

  async findRelatedSessions(input: {
    repo_path: string;
    files?: string[];
    limit?: number;
  }): Promise<unknown[]> {
    try {
      const { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) {
        resolveTrustedCallerId();
        throw new TrustBoundaryError('Raw external session history is disabled under strict trust until source ACL and provenance are enforced');
      }
      const { findRelatedSessions } = await import('../sessions/store.js');
      return await findRelatedSessions(input);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to find related sessions', error, {
        repoPath: input.repo_path,
      });
    }
  }

  // ─── Consolidation ───────────────────────────────────────────────────────

  async runMaintenance(options?: MaintenanceOptions): Promise<unknown> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Maintenance is disabled under strict trust until each mutation is caller and provenance gated');
      const { runFullMaintenance } = await import('../consolidation.js');
      return await runFullMaintenance({
        projectId: options?.project ?? this._activeProject,
        dryRun: options?.dryRun,
        steps: options?.steps as any,
        age: options?.age,
        llmEnabled: options?.llmEnabled,
      });
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to run maintenance', error, {
        project: options?.project ?? this._activeProject,
        steps: options?.steps,
      });
    }
  }

  // ─── Migrations ──────────────────────────────────────────────────────────

  async migrateMemories(sourceDir?: string, targetDir?: string): Promise<unknown> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Memory migration is disabled under strict trust until imported rows can be owner-attested');
      const { migrateMemories } = await import('../memory/migrate.js');
      const src = sourceDir ?? this._activeProject ?? '.';
      const tgt = targetDir ?? src;
      return await migrateMemories(src, tgt);
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw new StorageError('Failed to migrate memories', error as Error);
    }
  }

  // ─── Schema Health ───────────────────────────────────────────────────────

  async probeSchemaHealth(): Promise<SchemaHealthResult> {
    try {
      const { probeSchemaHealth } = await import('../../db/schema-probe.js');
      const result = await probeSchemaHealth();
      return {
        healthy: result.status === 'ok',
        issues: result.missingTables.length > 0 || result.missingColumns.length > 0 || result.indexIssues.length > 0
          ? [result.detail]
          : [],
        fixes: result.remediation ? [result.remediation] : [],
      };
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw new StorageError('Failed to probe schema health', error as Error);
    }
  }

  async fixSchemaIssues(): Promise<SchemaHealthResult> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Schema repair is disabled under strict trust until operator authorization is enforced');
      const { fixSchemaIssues } = await import('../../db/schema-repair.js');
      const actions = await fixSchemaIssues();
      return {
        healthy: actions.length === 0,
        issues: actions.map((a: any) => a.detail ?? a.type ?? 'fix'),
        fixes: actions.map((a: any) => a.detail ?? a.type ?? 'fix'),
      };
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to fix schema issues', error);
    }
  }

  // ─── Trust State ─────────────────────────────────────────────────────────

  async buildContextState(project?: string): Promise<TrustState> {
    try {
      const { buildContextState } = await import('./trust-state.js');
      const result = await buildContextState(project ?? this._activeProject);
      return {
        project: result.currentProject.path,
        mode: result.currentProject.resolution,
        stats: {},
        context: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to build context state', error, {
        project: project ?? this._activeProject,
      });
    }
  }

  async buildStatsState(project?: string): Promise<TrustState> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Aggregate project statistics are disabled under strict trust until owner-scoped aggregation is available');
      const { buildStatsState } = await import('./trust-state.js');
      const result = await buildStatsState(project ?? this._activeProject);
      return {
        project: result.currentProject,
        mode: 'stats',
        stats: result as unknown as Record<string, unknown>,
        context: {},
      };
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to build stats state', error, {
        project: project ?? this._activeProject,
      });
    }
  }

  async resolveProjectScope(project?: string): Promise<string> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Project scope diagnostics are disabled under strict trust until project ownership visibility is available');
      const { resolveProjectScope } = await import('./trust-state.js');
      const result = await resolveProjectScope(project ?? this._activeProject);
      return result.currentProject?.path ?? project ?? this._activeProject ?? '';
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to resolve project scope', error, {
        project: project ?? this._activeProject,
      });
    }
  }

  // ─── Scheduler ───────────────────────────────────────────────────────────

  async initializeScheduler(): Promise<void> {
    try {
      const { isStrictTrustPolicy } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) return;
      const { initializeScheduler } = await import('../scheduler/cron-scheduler.js');
      await initializeScheduler();
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw wrapStorageError('Failed to initialize scheduler', error);
    }
  }

  // ─── Signals ─────────────────────────────────────────────────────────────

  async detectMemorySignals(content: string): Promise<SignalResult> {
    try {
      const { detectMemorySignals } = await import('../memory/trigger-detector.js');
      const result = detectMemorySignals(content);
      const hasSignal = result.explicitTriggers.length > 0 ||
        Object.values(result.implicit).some(v => v === true);
      return {
        signals: result.explicitTriggers,
        hasSignal,
      };
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw new StorageError('Failed to detect memory signals', error as Error);
    }
  }

  // ─── Learnings ───────────────────────────────────────────────────────────

  async createLearning(input: LearningInput): Promise<LearningRecord> {
    try {
      const { isStrictTrustPolicy, TrustBoundaryError } = await import('../acl/trust-policy.js');
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Unscoped learning writes are disabled under strict trust; capture through signed owner-bound memory instead');
      const { createLearning } = await import('../ingestion/learnings.js');
      const validTypes = ['success', 'failure', 'fix', 'insight'];
      const learningType = validTypes.includes(input.type) ? input.type : 'insight';
      return await createLearning({
        type: learningType as 'success' | 'failure' | 'fix' | 'insight',
        content: input.content,
        context: input.context,
        action: input.action,
        target: input.target,
        project: input.project ?? this._activeProject,
        memoryId: input.memoryId,
      });
    } catch (error) {
      if (error instanceof SquishError || isTrustBoundaryError(error)) throw error;
      throw new StorageError('Failed to create learning', error as Error);
    }
  }

  async close(): Promise<void> {
    const { closeEmbeddingProvider } = await import('../embeddings/embeddings.js');
    await closeEmbeddingProvider();
  }
}
