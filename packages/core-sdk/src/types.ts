/**
 * @squish/sdk - Public Type Definitions
 *
 * Re-exports core types and defines additional SDK-specific types
 * for building memory-powered applications.
 *
 * All types are defined locally in the SDK interfaces to avoid
 * tight coupling with the core package internals.
 */

// ─── Re-export Core-Mirrored Types ───────────────────────────────────────────

export type {
  MemoryType,
  ConfidenceLevel,
  MemoryRecord,
  EntityRecord,
  EntityRelation,
  GraphTraversalResult,
  RecallOptions,
  SemanticResult,
  RecallResult,
} from './interfaces/storage.js';

// ─── SDK-Specific Types ──────────────────────────────────────────────────────

import type { StorageProvider } from './interfaces/storage.js';
import type { EmbeddingProvider } from './interfaces/embeddings.js';
import type { LLMProvider } from './interfaces/llm.js';
import type { EventBus } from './interfaces/events.js';
import type { SquishConfig } from './interfaces/config.js';

export type { SquishConfig };

/**
 * Client construction options.
 * Simplified subset of SquishConfig for common use cases.
 */
export interface ClientOptions {
  /** Data directory path (default: ~/.local/share/squish) */
  dataDir?: string;
  /** Project path for scoping memories */
  project?: string;
  /** Custom storage provider (default: SQLiteStorageProvider) */
  storage?: StorageProvider;
  /** Custom embedding provider (default: null - no embeddings) */
  embeddings?: EmbeddingProvider;
  /** Custom LLM provider (default: null - no LLM) */
  llm?: LLMProvider;
  /** Custom event bus (default: DefaultEventBus) */
  events?: EventBus;
  /** Enable lifecycle decay scoring */
  lifecycleEnabled?: boolean;
  /** Enable auto-build knowledge graph */
  graphAutoBuild?: boolean;
  /** Enable memory consolidation */
  consolidationEnabled?: boolean;
}

/**
 * Unified search result combining vector, FTS, and graph sources.
 */
export interface SearchResult {
  /** The memory record */
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
  /**
   * Relevance score (0-1). Batch 3: alias of the served finalScore
   * (semantic + itemized boosts, clamped). For honest match quality use
   * semanticScore.
   */
  score: number;
  /** Honest retrieval relevance (cosine / normalized RRF), boost-free. */
  semanticScore?: number;
  /** Sum of additive boosts applied on top of semanticScore. */
  boostScore?: number;
  /** Explicit final score field: clamp01(semanticScore + boostScore). */
  finalScore?: number;
  /**
   * Itemized additive adjustments (graph, place, heuristicRecency,
   * rerankResidual, ...) that compose boostScore.
   */
  scoreBreakdown?: Record<string, number>;
  /**
   * Batch 6a: calibrated, query-conditioned recall confidence in [0,1] -
   * "how likely is this the correct memory to recall", derived from
   * agreement/disagreement of independent evidence signals (semantic,
   * lexical, graph legs + margin + conflict + freshness). NOT finalScore
   * and never used for ranking.
   */
  recallConfidence?: number;
  /** Batch 6a: tier band for recallConfidence. */
  confidenceTier?: 'HIGH' | 'QUALIFIED' | 'LOW';
  /**
   * Batch 6a: itemized evidence behind recallConfidence. Absent signals are
   * null - never fabricated zeros.
   */
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
  /** Source that found this result */
  source: 'vector' | 'fts' | 'graph' | 'hybrid';
  /**
   * Batch 6b: which corpus produced this result.
   * 'memory' = memories table, 'belief' = unified knowledge table
   * (beliefs/constraints/decisions/strategies).
   */
  corpus?: 'memory' | 'belief';
  /** Optional explanation of why this matched */
  explanation?: string;
}

/**
 * Batch 6a: abstention-aware assessment attached at the response level so any
 * agent harness can react to weak memory without parsing per-result scores.
 */
export interface RecallAssessment {
  /** Highest recallConfidence across returned results (0 when none). */
  bestConfidence: number;
  tier: 'HIGH' | 'QUALIFIED' | 'LOW';
  verdict: 'confident' | 'qualified' | 'no_reliable_memory';
  message: string;
}

/**
 * Plugin hook point types for extending SDK behavior.
 */
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

/**
 * Context provided to plugin hooks.
 */
export interface PluginHookContext {
  /** The hook being executed */
  hook: PluginHook;
  /** The SDK config at time of hook */
  config: SquishConfig;
  /** Abort the operation (call to prevent default behavior) */
  abort: () => void;
  /** Whether the operation was aborted */
  aborted: boolean;
  /** Arbitrary metadata for the hook */
  metadata: Record<string, unknown>;
}

/**
 * Event types that can be listened to via the event bus.
 * Matches SquishEvent type discriminants.
 */
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

// ─── Re-export Event Types ───────────────────────────────────────────────────

export type { SquishEvent, EventBus, GraphBuildStats } from './interfaces/events.js';

// ─── Re-export Interface Types ───────────────────────────────────────────────

export type {
  StorageProvider,
  StorageConfig,
  StoreMemoryInput,
  MemoryFilter,
  VectorSearchFilter,
  VectorSearchResult,
  FTSResult,
  EntityInput,
  RelationInput,
  GraphNode,
  GraphEdge,
  TraversalPath,
  ProjectRecord,
  LearningInput,
  LearningRecord,
  LearningFilter,
  SchemaHealth,
} from './interfaces/storage.js';

export type {
  EmbeddingProvider,
  MultimodalInput,
  EmbeddingConfig,
} from './interfaces/embeddings.js';

export type {
  LLMProvider,
  LLMCallOptions,
  LLMContentPart,
  LLMConfig,
} from './interfaces/llm.js';

// ─── SquishClient Method Types ───────────────────────────────────────────────

import type { MemoryType } from './interfaces/storage.js';

/**
 * Options for the `remember()` method.
 */
export interface RememberOptions {
  /** Memory type (observation, fact, decision, etc.) */
  type?: MemoryType;
  /** Tags for categorization */
  tags?: string[];
  /** Importance score (0-100) */
  importance?: number;
  /** Project path to scope the memory */
  project?: string;
  /** User identifier */
  user?: string;
  /** Session identifier */
  sessionId?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for the `search()` method.
 */
export interface SearchOptions {
  /** Maximum number of results */
  limit?: number;
  /** Project path to scope the search */
  project?: string;
  /** Acting user for ACL read-gate visibility checks */
  user?: string;
  /** Minimum similarity score (0-1) */
  minScore?: number;
}

/**
 * Options for the `listRecent()` method.
 */
export interface ListRecentOptions {
  /** Maximum number of memories to return (default 50) */
  limit?: number;
  /** Project path to scope the listing (uses active project if omitted) */
  project?: string;
  /** Only return memories created within the last N hours (time filter) */
  hoursBack?: number;
}

/**
 * Options for the `traverseGraph()` method.
 */
export interface GraphOptions {
  /** Maximum traversal depth */
  maxDepth?: number;
  /** Maximum number of results */
  limit?: number;
}

/**
 * Options for the `getContext()` method.
 */
export interface ContextOptions {
  /** Project path to scope the context */
  project?: string;
  /** Maximum number of memories to return */
  limit?: number;
}

/**
 * Memory statistics.
 */
export interface MemoryStats {
  /** Total number of memories */
  totalMemories: number;
  /** Breakdown by memory type */
  byType: Record<string, number>;
  /** Total number of notes/learnings */
  totalNotes: number;
  /** Notes breakdown by category */
  notesByCategory: Record<string, number>;
  /** Total number of learnings */
  totalLearnings: number;
  /** Learnings breakdown by type */
  learningsByType: Record<string, number>;
  /** Total number of links/associations */
  totalLinks: number;
  /** Oldest memory timestamp */
  oldestMemory?: string;
  /** Newest memory timestamp */
  newestMemory?: string;
  /** Project path */
  projectPath: string;
  /** Operating mode */
  mode: string;
}

/**
 * Health check result.
 */
export interface HealthResult {
  /** Overall status */
  status: string;
  /** Per-component health */
  components: Record<string, string>;
}

/**
 * Options for the `recall()` method.
 */
export interface RecallClientOptions {
  /** Maximum number of results */
  limit?: number;
  /** Project path to scope the recall */
  project?: string;
  /** Filter by memory type */
  type?: MemoryType;
  /** Filter by tags */
  tags?: string[];
  /** Strategy override (hybrid_search, entity_aware, etc.) */
  strategy?: string;
}

// ─── Governance Types ────────────────────────────────────────────────────────

/**
 * Options for pinning/unpinning memories.
 */
export interface PinOptions {
  /** Project path to scope the operation */
  project?: string;
}

/**
 * Options for listing sessions.
 */
export interface SessionOptions {
  /** Project path to scope the operation */
  project?: string;
  /** Maximum number of sessions to return */
  limit?: number;
  /**
   * Harness source filter: 'opencode' | 'claude-code' | 'codex' |
   * 'gemini' | 'all' (default 'all'). Batch 7.
   */
  source?: string;
}

/**
 * Options for maintenance operations.
 */
export interface MaintenanceOptions {
  /** Project path to scope the operation */
  project?: string;
  /** Dry run without making changes */
  dryRun?: boolean;
  /** Specific maintenance steps to run */
  steps?: ('dedup' | 'stale' | 'consolidate' | 'inbox')[];
  /** Age threshold in days */
  age?: number;
  /** Whether to use LLM for enhanced steps */
  llmEnabled?: boolean;
}

/**
 * Result of a schema health check.
 */
export interface SchemaHealthResult {
  /** Whether the schema is healthy */
  healthy: boolean;
  /** List of detected issues */
  issues: string[];
  /** List of applied or available fixes */
  fixes: string[];
}

/**
 * Trust state for a project's runtime context.
 */
export interface TrustState {
  /** Project path */
  project: string;
  /** Current mode (e.g. 'local', 'server') */
  mode: string;
  /** Aggregate statistics */
  stats: Record<string, unknown>;
  /** Runtime context data */
  context: Record<string, unknown>;
}

/**
 * Result of memory signal detection.
 */
export interface SignalResult {
  /** Detected signal labels */
  signals: string[];
  /** Whether any signal was detected */
  hasSignal: boolean;
}

/**
 * An association between two memories.
 */
export interface AssociationResult {
  /** Association ID */
  id: string;
  /** Source memory ID */
  fromId: string;
  /** Target memory ID */
  toId: string;
  /** Association type label */
  type: string;
}

/**
 * A memory place record.
 */
export interface PlaceRecord {
  /** Place ID */
  id: string;
  /** Place name */
  name: string;
  /** Memory IDs linked to this place */
  memories: string[];
}

/**
 * A session record.
 */
export interface SessionRecord {
  /** Session ID */
  id: string;
  /** Session title */
  title?: string;
  /** Project path */
  project?: string;
  /** Git branch */
  branch?: string;
  /** Agent identifier */
  agent: string;
  /** ISO timestamp when the session started */
  startedAt: string;
  /** ISO timestamp when the session ended */
  endedAt?: string;
  /** Session status */
  status?: string;
  /** Number of chunks in the session */
  chunkCount: number;
  /** Number of memories created in the session (alias for chunkCount) */
  memoryCount: number;
}

/**
 * A session chunk record.
 */
export interface ChunkRecord {
  /** Chunk ID */
  id: string;
  /** Session ID this chunk belongs to */
  sessionId: string;
  /** Chunk content */
  content: string;
  /** Chunk type */
  type?: string;
  /** ISO timestamp of the chunk */
  timestamp?: string;
  /** Harness origin of the chunk (Batch 7) */
  agent?: string;
  /** Title of the session the chunk came from (Batch 7) */
  sessionTitle?: string;
  /** Why this chunk matched (search results only, Batch 7) */
  why?: string;
}
