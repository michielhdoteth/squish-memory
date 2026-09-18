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
  metadata?: Record<string, unknown>;
}

export interface MemoryRecord {
  id: string;
  content: string;
  type: MemoryType;
  tags: string[];
  importance: number;
  project?: string;
  sessionId?: string;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt?: Date;
  accessCount: number;
  decayScore: number;
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
    createdAt: string;
    updatedAt: string;
  };
  score: number;
  semanticScore?: number;
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
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  limit?: number;
  project?: string;
  user?: string;
  minScore?: number;
  teamId?: string;
}

export interface ListRecentOptions {
  limit?: number;
  project?: string;
  hoursBack?: number;
}

export interface GraphOptions {
  maxDepth?: number;
  limit?: number;
}

export interface ContextOptions {
  project?: string;
  limit?: number;
}

export interface MemoryStats {
  totalMemories: number;
  byType: Record<string, number>;
  totalNotes: number;
  notesByCategory: Record<string, number>;
  totalLearnings: number;
  learningsByType: Record<string, number>;
  totalLinks: number;
  oldestMemory?: string;
  newestMemory?: string;
  projectPath: string;
  mode: string;
}

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

export { getMemory } from '../memory/memories.js';
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
export { allAgentStores } from '../sessions/agent-stores/registry.js';

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
    return new Date(value < 1e12 ? value * 1000 : value);
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
function mapCoreMemoryToSdk(core: any): MemoryRecord {
  const createdAt = coerceTimestamp(core.createdAt);
  const updatedAt = coerceTimestamp(core.updatedAt);
  const resolvedCreatedAt = createdAt ?? updatedAt ?? new Date();
  const resolvedUpdatedAt = updatedAt ?? createdAt ?? new Date();
  return {
    id: core.id,
    content: core.content,
    type: core.type,
    tags: core.tags ?? [],
    importance: core.importance ?? 0,
    project: core.projectId ?? undefined,
    sessionId: core.sessionId ?? undefined,
    createdAt: resolvedCreatedAt,
    updatedAt: resolvedUpdatedAt,
    lastAccessedAt: coerceTimestamp(core.lastAccessedAt) ?? undefined,
    accessCount: core.accessCount ?? 0,
    decayScore: core.decayScore ?? 0,
  };
}

/**
 * Map a core search result to the SDK SearchResult type.
 */
function mapCoreSearchResultToSdk(core: any): SearchResult {
  const memory = mapCoreMemoryToSdk(core);
  return {
    memory: {
      id: memory.id,
      content: memory.content,
      type: memory.type,
      tags: memory.tags,
      importance: memory.importance,
      project: memory.project,
      createdAt: memory.createdAt.toISOString(),
      updatedAt: memory.updatedAt.toISOString(),
    },
    score: core.finalScore ?? core.similarity ?? 0,
    semanticScore: core.semanticScore,
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

      const { storeMemory } = await import('../storage/storage-facade.js');
      const coreMemory = await storeMemory({
        content: content.trim(),
        type: options?.type,
        tags: options?.tags,
        project: options?.project ?? this._activeProject,
        user: options?.user,
        metadata: options?.metadata,
        sessionId: options?.sessionId,
      });

      return mapCoreMemoryToSdk(coreMemory);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to store memory', error as Error);
    }
  }

  async recall(query: string, options?: RecallClientOptions): Promise<RecallResult> {
    try {
      if (!query?.trim()) {
        throw new SquishError('Query cannot be empty', 'VALIDATION_ERROR');
      }

      const { recall } = await import('../storage/storage-facade.js');
      const coreResult = await recall(query.trim(), {
        project: options?.project ?? this._activeProject,
        limit: options?.limit,
        type: options?.type,
        tags: options?.tags,
        strategy: options?.strategy as any,
      });

      return {
        memories: coreResult.memories.map(mapCoreMemoryToSdk),
        graphEntities: coreResult.graphEntities,
        routing: coreResult.routing,
        metadata: coreResult.metadata,
      };
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to recall memories', error as Error);
    }
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    try {
      if (!query?.trim()) {
        throw new SquishError('Query cannot be empty', 'VALIDATION_ERROR');
      }

      const { queryMemories } = await import('../storage/storage-facade.js');
      const coreResults = await queryMemories({
        query: query.trim(),
        limit: options?.limit ?? 10,
        project: options?.project ?? this._activeProject,
        user: options?.user,
        teamId: options?.teamId,
      });

      let results = coreResults.map(mapCoreSearchResultToSdk);

      if (options?.minScore != null && options.minScore > 0) {
        results = results.filter(r => r.score >= options.minScore!);
      }

      return results;
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to search memories', error as Error);
    }
  }

  async feedback(
    targetType: 'memory' | 'belief' | 'strategy',
    id: string,
    signal: 'confirm' | 'contradict' | 'used'
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
      const { applyFeedback } = await import('../memory/reinforcement.js');
      return await applyFeedback({ targetType, id, signal });
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to apply feedback', error as Error);
    }
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    try {
      if (!id?.trim()) {
        throw new SquishError('ID cannot be empty', 'VALIDATION_ERROR');
      }

      const { getMemoryById } = await import('../storage/storage-facade.js');
      const coreMemory = await getMemoryById(id.trim());
      if (!coreMemory) return null;

      return mapCoreMemoryToSdk(coreMemory);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to get memory', error as Error);
    }
  }

  async forget(id: string): Promise<boolean> {
    try {
      if (!id?.trim()) {
        throw new SquishError('ID cannot be empty', 'VALIDATION_ERROR');
      }

      const { deleteMemoryPermanently } = await import('../memory/stale-cleaner.js');
      await deleteMemoryPermanently(id.trim());
      return true;
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to delete memory', error as Error);
    }
  }

  // ─── Graph Operations ────────────────────────────────────────────────────

  async getEntity(
    name: string,
    project?: string
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
      return await getEntity(name.trim(), projectId);
    } catch (error) {
      if (error instanceof SquishError) throw error;
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

      const { traverseGraph } = await import('../storage/graph-ops.js');
      return await traverseGraph(name.trim(), projectId, {
        maxDepth: options?.maxDepth,
        limit: options?.limit,
      }) as any;
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to traverse graph', error as Error);
    }
  }

  // ─── Context & Projects ──────────────────────────────────────────────────

  async getContext(options?: ContextOptions): Promise<MemoryRecord[]> {
    try {
      const project = options?.project ?? this._activeProject;
      const limit = options?.limit ?? 10;

      const { recall } = await import('../storage/storage-facade.js');
      const result = await recall('', {
        project,
        limit,
      });

      return result.memories.map(mapCoreMemoryToSdk);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to get context', error as Error);
    }
  }

  async listProjects(): Promise<ProjectRecord[]> {
    try {
      const { getAllProjects } = await import('../projects.js');
      return await getAllProjects();
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to list projects', error as Error);
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
      const { getMemoryStats } = await import('../memory/stats.js');
      return await getMemoryStats(project ?? this._activeProject);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to get stats', error as Error);
    }
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
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to pin memory', error as Error);
    }
  }

  async unpinMemory(id: string, options?: PinOptions): Promise<void> {
    try {
      const { unpinMemory } = await import('../security/governance.js');
      await unpinMemory(id);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to unpin memory', error as Error);
    }
  }

  async getPinnedMemories(project?: string): Promise<MemoryRecord[]> {
    try {
      const { getPinnedMemories } = await import('../security/governance.js');
      const memories = await getPinnedMemories(project ?? this._activeProject);
      return memories.map(mapCoreMemoryToSdk);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to get pinned memories', error as Error);
    }
  }

  // ─── Memory Tiers ────────────────────────────────────────────────────────

  async promoteToSturdy(id: string): Promise<void> {
    try {
      const { promoteToSturdy } = await import('../memory/tiers.js');
      await promoteToSturdy(id);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to promote memory', error as Error);
    }
  }

  async getTierStats(project?: string): Promise<Record<string, number>> {
    try {
      const { getTierStats } = await import('../memory/tiers.js');
      return await getTierStats(project ?? this._activeProject);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to get tier stats', error as Error);
    }
  }

  // ─── Memory Retrieval ────────────────────────────────────────────────────

  async getRecent(limit?: number, project?: string): Promise<MemoryRecord[]> {
    try {
      const { getRecent } = await import('../memory/memories.js');
      const memories = await getRecent(project ?? this._activeProject!, limit ?? 10);
      return memories.map(mapCoreMemoryToSdk);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to get recent memories', error as Error);
    }
  }

  async listRecent(options?: ListRecentOptions): Promise<MemoryRecord[]> {
    try {
      const { vectorSearch } = await import('../memory/vector-search.js');
      const results = await vectorSearch(
        { query: '', project: options?.project ?? this._activeProject },
        { limit: options?.limit ?? 50 }
      );
      let memories = results.map(mapCoreMemoryToSdk);
      const hoursBack = options?.hoursBack;
      if (hoursBack != null && hoursBack > 0) {
        const cutoffMs = Date.now() - hoursBack * 3_600_000;
        memories = memories.filter((memory) => memory.createdAt.getTime() >= cutoffMs);
      }
      return memories;
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to list recent memories', error as Error);
    }
  }

  async getMemorySnapshot(project?: string): Promise<unknown> {
    try {
      const { getMemorySnapshot } = await import('../snapshots/retrieval.js');
      return await getMemorySnapshot(project ?? this._activeProject!);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to get memory snapshot', error as Error);
    }
  }

  // ─── Associations ────────────────────────────────────────────────────────

  async createAssociation(fromId: string, toId: string, type?: string): Promise<void> {
    try {
      const { createAssociation } = await import('../associations.js');
      await createAssociation(fromId, toId, type as any);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to create association', error as Error);
    }
  }

  async getRelatedMemories(id: string): Promise<MemoryRecord[]> {
    try {
      const { getRelatedMemories } = await import('../associations.js');
      const memories = await getRelatedMemories(id);
      return memories.map(mapCoreMemoryToSdk);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to get related memories', error as Error);
    }
  }

  // ─── Graph Building ──────────────────────────────────────────────────────

  async buildGraph(project?: string): Promise<GraphBuildStats> {
    try {
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
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to build graph', error as Error);
    }
  }

  // ─── Places ──────────────────────────────────────────────────────────────

  async getPlaces(project?: string): Promise<PlaceRecord[]> {
    try {
      const { getProjectPlaces } = await import('../places/places.js');
      const projectId = project ?? this._activeProject;
      const places = await getProjectPlaces(projectId);
      return places.map((p: any) => ({
        id: p.id,
        name: p.name,
        memories: [],
      }));
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to get places', error as Error);
    }
  }

  // ─── Sessions ────────────────────────────────────────────────────────────

  async listSessions(options?: SessionOptions): Promise<SessionRecord[]> {
    try {
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
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to list sessions', error as Error);
    }
  }

  async getSessionChunks(sessionId: string, options?: { source?: SessionSourceOption }): Promise<ChunkRecord[]> {
    try {
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
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to get session chunks', error as Error);
    }
  }

  async searchChunks(query: string, options?: { limit?: number; source?: SessionSourceOption }): Promise<ChunkRecord[]> {
    try {
      const { searchChunks } = await import('../sessions/index.js');
      const results = await searchChunks({ query, limit: options?.limit, source: options?.source ?? 'all' });
      return results.map((r: any) => ({
        id: r.memory_id ?? '',
        sessionId: r.chunk?.session_id ?? '',
        content: r.chunk?.content ?? '',
        type: r.chunk?.type ?? '',
        agent: r.chunk?.agent,
        sessionTitle: r.chunk?.session_title,
        why: r.why,
      }));
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to search chunks', error as Error);
    }
  }

  // ─── Dedup / Merge Workflow ──────────────────────────────────────────────

  async dedupScan(input: DedupScanInput = {}): Promise<DedupScanResult> {
    try {
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
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to scan for duplicates', error as Error);
    }
  }

  async listMergeProposals(input: MergeProposalListInput): Promise<MergeListResult> {
    try {
      const { handleListProposals } = await import('../algorithms/handlers/list-proposals.js');
      return await handleListProposals({
        projectId: input.projectId,
        status: input.status,
        limit: input.limit,
      }) as MergeListResult;
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to list merge proposals', error as Error);
    }
  }

  async previewMerge(proposalId: string): Promise<MergePreviewResult> {
    try {
      const { handlePreviewMerge } = await import('../algorithms/handlers/preview-merge.js');
      return await handlePreviewMerge({ proposalId }) as MergePreviewResult;
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to preview merge', error as Error);
    }
  }

  async approveMerge(input: { proposalId: string; reviewNotes?: string }): Promise<MergeActionResult> {
    try {
      const { handleApproveMerge } = await import('../algorithms/handlers/approve-merge.js');
      return await handleApproveMerge(input) as MergeActionResult;
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to approve merge', error as Error);
    }
  }

  async rejectMerge(input: { proposalId: string; reviewNotes?: string }): Promise<MergeActionResult> {
    try {
      const { handleRejectMerge } = await import('../algorithms/handlers/reject-merge.js');
      return await handleRejectMerge(input) as MergeActionResult;
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to reject merge', error as Error);
    }
  }

  async reverseMerge(input: { mergeHistoryId: string; reason?: string }): Promise<MergeReversalResult> {
    try {
      const { handleReverseMerge } = await import('../algorithms/handlers/reverse-merge.js');
      return await handleReverseMerge(input) as MergeReversalResult;
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to reverse merge', error as Error);
    }
  }

  async dedupAutoMerge(input: { threshold?: number; cap?: number } = {}): Promise<DedupAutoResult> {
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

  async getMemoriesByIds(ids: string[]): Promise<MemoryRecord[]> {
    try {
      if (!ids || ids.length === 0) return [];
      const { getDb } = await import('../../db/index.js');
      const { getSchema } = await import('../../db/schema.js');
      const { createDatabaseClient } = await import('../storage/database.js');
      const { inArray } = await import('drizzle-orm');

      const db = createDatabaseClient(await getDb());
      const schema = await getSchema();
      const rows = await db.select().from(schema.memories).where(inArray(schema.memories.id, ids));
      return rows.map(mapCoreMemoryToSdk);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to fetch memories by IDs', error as Error);
    }
  }

  // ─── Place Memories ──────────────────────────────────────────────────────

  async getPlaceMemories(placeIdOrType: string, limit: number = 50): Promise<string[]> {
    try {
      const { getPlaceMemories } = await import('../places/memory-places.js');
      return await getPlaceMemories(placeIdOrType, limit);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to get place memories', error as Error);
    }
  }

  // ─── Related Sessions ────────────────────────────────────────────────────

  async findRelatedSessions(input: {
    repo_path: string;
    files?: string[];
    limit?: number;
  }): Promise<unknown[]> {
    try {
      const { findRelatedSessions } = await import('../sessions/store.js');
      return await findRelatedSessions(input);
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to find related sessions', error as Error);
    }
  }

  // ─── Consolidation ───────────────────────────────────────────────────────

  async runMaintenance(options?: MaintenanceOptions): Promise<unknown> {
    try {
      const { runFullMaintenance } = await import('../consolidation.js');
      return await runFullMaintenance({
        projectId: options?.project ?? this._activeProject,
        dryRun: options?.dryRun,
        steps: options?.steps as any,
        age: options?.age,
        llmEnabled: options?.llmEnabled,
      });
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to run maintenance', error as Error);
    }
  }

  // ─── Migrations ──────────────────────────────────────────────────────────

  async migrateMemories(sourceDir?: string, targetDir?: string): Promise<unknown> {
    try {
      const { migrateMemories } = await import('../memory/migrate.js');
      const src = sourceDir ?? this._activeProject ?? '.';
      const tgt = targetDir ?? src;
      return await migrateMemories(src, tgt);
    } catch (error) {
      if (error instanceof SquishError) throw error;
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
        issues: result.missingTables.length > 0 || result.missingColumns.length > 0
          ? [result.detail]
          : [],
        fixes: result.remediation ? [result.remediation] : [],
      };
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to probe schema health', error as Error);
    }
  }

  async fixSchemaIssues(): Promise<SchemaHealthResult> {
    try {
      const { fixSchemaIssues } = await import('../../db/schema-repair.js');
      const actions = await fixSchemaIssues();
      return {
        healthy: actions.length === 0,
        issues: actions.map((a: any) => a.detail ?? a.type ?? 'fix'),
        fixes: actions.map((a: any) => a.detail ?? a.type ?? 'fix'),
      };
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to fix schema issues', error as Error);
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
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to build context state', error as Error);
    }
  }

  async buildStatsState(project?: string): Promise<TrustState> {
    try {
      const { buildStatsState } = await import('./trust-state.js');
      const result = await buildStatsState(project ?? this._activeProject);
      return {
        project: result.currentProject,
        mode: 'stats',
        stats: result as unknown as Record<string, unknown>,
        context: {},
      };
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to build stats state', error as Error);
    }
  }

  async resolveProjectScope(project?: string): Promise<string> {
    try {
      const { resolveProjectScope } = await import('./trust-state.js');
      const result = await resolveProjectScope(project ?? this._activeProject);
      return result.currentProject?.path ?? project ?? this._activeProject ?? '';
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to resolve project scope', error as Error);
    }
  }

  // ─── Scheduler ───────────────────────────────────────────────────────────

  async initializeScheduler(): Promise<void> {
    try {
      const { initializeScheduler } = await import('../scheduler/cron-scheduler.js');
      await initializeScheduler();
    } catch (error) {
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to initialize scheduler', error as Error);
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
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to detect memory signals', error as Error);
    }
  }

  // ─── Learnings ───────────────────────────────────────────────────────────

  async createLearning(input: LearningInput): Promise<LearningRecord> {
    try {
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
      if (error instanceof SquishError) throw error;
      throw new StorageError('Failed to create learning', error as Error);
    }
  }

  async close(): Promise<void> {
    // No persistent resources to clean up
  }
}
