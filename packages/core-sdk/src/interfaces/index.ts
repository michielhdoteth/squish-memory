/**
 * Interfaces Barrel Export
 * 
 * Re-exports all interface types for easy importing.
 */

export type { StorageProvider, StorageConfig, StoreMemoryInput, MemoryRecord, MemoryType, MemoryFilter, VectorSearchFilter, VectorSearchResult, FTSResult, EntityInput, EntityRecord, RelationInput, EntityRelation, GraphTraversalResult, GraphNode, GraphEdge, TraversalPath, ProjectRecord, LearningInput, LearningRecord, LearningFilter, SchemaHealth, ConfidenceLevel, RecallOptions, SemanticResult, RecallResult } from './storage.js';

export type { EmbeddingProvider, MultimodalInput, EmbeddingConfig } from './embeddings.js';

export type { LLMProvider, LLMCallOptions, LLMContentPart, LLMConfig } from './llm.js';

export type { EventBus, SquishEvent, GraphBuildStats } from './events.js';

export type { SquishConfig } from './config.js';
