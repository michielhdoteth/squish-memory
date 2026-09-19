/**
 * Knowledge Module — Unified Knowledge Layer
 * 
 * Single source of truth for all knowledge kinds:
 * memories, beliefs, and strategies — stored in one table.
 * Graph entities and places connect via knowledge_edges.
 * 
 * Usage:
 *   import { Knowledge, KnowledgeKind } from './knowledge/index.js';
 */

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  // Knowledge kinds and types
  KnowledgeKind,
  MemoryKnowledgeType,
  BeliefKnowledgeType,
  StrategyKnowledgeType,
  KnowledgeType,

  // Graph and place types
  EntityType,
  PlaceType,

  // Status
  KnowledgeStatus,
  ConfidenceLevel,

  // Edge types
  EdgeNodeKind,
  KnowledgeEdgeType,

  // Core interfaces
  Knowledge,
  CreateKnowledgeInput,
  EntityRecord,
  CreateEntityInput,
  PlaceRecord,
  KnowledgeEdge,
  CreateKnowledgeEdgeInput,

  // Recall types
  RecallOptions,
  RecallResult,

  // Extraction types
  StoredBelief,
  ExtractedBelief,
  ExtractedStrategy,
} from './types.js';

// ─── Store ───────────────────────────────────────────────────────────────────
export {
  ensureKnowledgeTables,
  createKnowledge,
  getKnowledgeById,
  updateKnowledge,
  deleteKnowledge,
  searchKnowledge,
  listKnowledgeByKind,
  createKnowledgeEdge,
  getEdgesFrom,
  getEdgesTo,
  getEdgesForNode,
  deleteKnowledgeEdge,
  deleteEdgesForNode,
  getConnectedEntities,
  getConnectedPlaces,
  // Belief adapters (bridge old beliefs/ API to unified table)
  upsertBeliefsForMemory,
  getBeliefsForMemory,
  getActiveConstraints,
  getActiveDecisions,
  getRecentFailures,
  searchBeliefs,
  getAllBeliefs,
  getRelevantBeliefs,
} from './store.js';

// ─── Extractor ───────────────────────────────────────────────────────────────
export {
  extractBeliefs,
  extractConversationStrats,
  extractLearningStrats,
  extractBeliefStrats,
  knowledgeFromMemory,
  knowledgeFromLearning,
} from './extractor.js';
export type { ExtractionOptions, ExtractedKnowledge } from './extractor.js';

// ─── Decay ───────────────────────────────────────────────────────────────────
export {
  decayKnowledgeConfidence,
  decayAllKnowledge,
  boostConfidence,
  confirmBelief,
  recordStrategyUsage,
  runDecayCycle,
} from './decay.js';

// ─── Dedup ───────────────────────────────────────────────────────────────────
export {
  findSimilarKnowledge,
  deduplicateKnowledge,
  runDeduplicationCycle,
} from './deduplicator.js';
