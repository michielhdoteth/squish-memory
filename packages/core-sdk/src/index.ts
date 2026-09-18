/**
 * @squish/core-sdk
 *
 * SDK for building on squish-memory's AI memory system.
 * Provides pluggable interfaces for storage, embeddings, LLM, and events.
 */

// ─── Re-export All Types ─────────────────────────────────────────────────────

export type {
  // Core re-exports
  MemoryRecord,
  MemoryType,
  ConfidenceLevel,
  RecallOptions,
  EntityRecord,
  EntityRelation,
  GraphTraversalResult,
  SemanticResult,
  RecallResult,
  // SDK-specific types
  SquishConfig,
  ClientOptions,
  SearchResult,
  RecallAssessment,
  PluginHook,
  PluginHookContext,
  EventType,
  // Event types
  SquishEvent,
  EventBus,
  GraphBuildStats,
  // Storage interface types
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
  // Embedding interface types
  EmbeddingProvider,
  MultimodalInput,
  EmbeddingConfig,
  // LLM interface types
  LLMProvider,
  LLMCallOptions,
  LLMContentPart,
  LLMConfig,
  // New SDK types
  PinOptions,
  SessionOptions,
  MaintenanceOptions,
  ListRecentOptions,
  SchemaHealthResult,
  TrustState,
  SignalResult,
  AssociationResult,
  PlaceRecord,
  SessionRecord,
  ChunkRecord,
} from './types.js';

// ─── Plugin Registry ────────────────────────────────────────────────────────

export { PluginRegistry, type Plugin } from './plugins.js';

// ─── Event System ────────────────────────────────────────────────────────────
export { DefaultEventBus } from './events/event-bus.js';

// ─── Core Module Re-exports ──────────────────────────────────────────────────
// These allow CLI and MCP to import from '@squish/core-sdk' instead of
// using deep relative paths (../../../) into core internals.

// ─── Config ──────────────────────────────────────────────────────────────────
export { config, getDataDir, detectProjectScope } from '../../../config.js';

// ─── Logger ──────────────────────────────────────────────────────────────────
export { logger } from '../../../core/logger.js';

// ─── Database ────────────────────────────────────────────────────────────────
export { getDb } from '../../../db/index.js';
export {
  probeSchemaHealth,
  isSchemaDriftError,
  type SchemaProbeResult,
} from '../../../db/schema-probe.js';
export { fixSchemaIssues } from '../../../db/schema-repair.js';
export { ensureSqliteSchema } from '../../../db/bootstrap.js';

// ─── Runtime ─────────────────────────────────────────────────────────────────
export { getInstallShadowDiagnostic } from '../../../core/runtime/install-diagnostics.js';
export {
  buildHealthState,
  buildStatsState,
  buildContextState,
  buildInspectState,
  resolveProjectScope,
} from '../../../core/runtime/trust-state.js';
export {
  formatHealthReport,
  formatStatsReport,
  formatContextReport,
} from '../../../core/runtime/trust-report.js';

// ─── Memory ──────────────────────────────────────────────────────────────────
export { getMemory } from '../../../core/memory/memories.js';
export { promoteToSturdy } from '../../../core/memory/tiers.js';
export { detectMemorySignals } from '../../../core/memory/trigger-detector.js';
export { migrateMemories, type MigrateResult } from '../../../core/memory/migrate.js';

// ─── Security ────────────────────────────────────────────────────────────────
export { pinMemory, unpinMemory } from '../../../core/security/governance.js';

// ─── Associations ────────────────────────────────────────────────────────────
export { createAssociation, getRelatedMemories } from '../../../core/associations.js';

// ─── Snapshots ───────────────────────────────────────────────────────────────
export { getMemorySnapshot } from '../../../core/snapshots/retrieval.js';

// ─── Ingestion ───────────────────────────────────────────────────────────────
export { shouldReturnRawFallback } from '../../../core/ingestion/signal-engine.js';
export { createLearning } from '../../../core/ingestion/learnings.js';

// ─── Sessions ────────────────────────────────────────────────────────────────
export {
  listSessions,
  getSessionChunks,
  searchChunks,
} from '../../../core/sessions/index.js';
export { allAgentStores } from '../../../core/sessions/agent-stores/registry.js';

// ─── Embeddings ──────────────────────────────────────────────────────────────
export { getQMDClient } from '../../../core/embeddings/qmd-client.js';

// ─── Utilities ───────────────────────────────────────────────────────────────
export { filterByDateRange } from '../../../core/lib/utils.js';

// ─── Error Classes ───────────────────────────────────────────────────────────

export {
  SquishError,
  ConfigError,
  StorageError,
  EmbeddingError,
  LLMError,
  NotFoundError,
} from './errors.js';

// ─── SquishClient & Mapping Helpers ─────────────────────────────────────────

export { SquishClient } from './client.js';
export { coerceTimestamp } from './client.js';

// ─── Dedup / Merge Workflow Types ───────────────────────────────────────────

export type {
  DedupScanInput,
  DedupScanResult,
  MergeProposalListInput,
  MergeProposalSummary,
  MergeListResult,
  MergePreviewResult,
  MergeActionResult,
  MergeReversalResult,
  DedupAutoMergeRecord,
  DedupAutoResult,
} from './client.js';
