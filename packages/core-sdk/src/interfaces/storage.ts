/**
 * Storage Provider Interface
 *
 * Defines the contract for pluggable storage backends.
 * The default implementation wraps the existing SQLite storage.
 */

/**
 * Valid memory type values
 */
export type MemoryType = 'observation' | 'fact' | 'decision' | 'context' | 'preference' | 'note' | 'task';

/**
 * Confidence level for memory records
 * - certain: High confidence, verified information
 * - speculative: Low confidence, unverified or uncertain
 * - outdated: Information that may no longer be accurate
 */
export type ConfidenceLevel = 'certain' | 'speculative' | 'outdated';

export interface StorageProvider {
  readonly name: string;
  
  // Lifecycle
  initialize(config: StorageConfig): Promise<void>;
  close(): Promise<void>;
  isHealthy(): Promise<boolean>;
  
  // Memory CRUD
  storeMemory(input: StoreMemoryInput): Promise<MemoryRecord>;
  getMemory(id: string, includeEmbedding?: boolean): Promise<MemoryRecord | null>;
  updateMemory(id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord>;
  deleteMemory(id: string): Promise<boolean>;
  queryMemories(filter: MemoryFilter): Promise<MemoryRecord[]>;
  
  // Embeddings
  storeEmbedding(memoryId: string, vector: Float32Array): Promise<void>;
  getEmbedding(memoryId: string): Promise<Float32Array | null>;
  vectorSearch(query: Float32Array, topK: number, filter?: VectorSearchFilter): Promise<VectorSearchResult[]>;
  
  // Full-text search
  ftsSearch(query: string, topK: number, filter?: MemoryFilter): Promise<FTSResult[]>;
  
  // Knowledge graph
  storeEntity(entity: EntityInput): Promise<EntityRecord>;
  storeRelation(relation: RelationInput): Promise<EntityRelation>;
  getEntityNeighborhood(entityId: string, depth?: number): Promise<GraphTraversalResult>;
  findEntityPaths(fromId: string, toId: string, maxDepth?: number): Promise<TraversalPath[]>;
  
  // Projects
  getOrCreateProject(path: string, name?: string): Promise<ProjectRecord>;
  getAllProjects(): Promise<ProjectRecord[]>;
  
  // Learnings
  storeLearning(input: LearningInput): Promise<LearningRecord>;
  getLearnings(filter: LearningFilter): Promise<LearningRecord[]>;
  
  // Schema management
  ensureSchema(): Promise<void>;
  getSchemaHealth(): Promise<SchemaHealth>;
}

export interface StorageConfig {
  dataDir?: string;
  project?: string;
}

export interface StoreMemoryInput {
  content: string;
  type?: MemoryType;
  tags?: string[];
  importance?: number;
  project?: string;
  sessionId?: string;
  embedding?: Float32Array;
}

export interface MemoryRecord {
  id: string;
  content: string;
  type: string;
  tags: string[];
  importance: number;
  project?: string;
  sessionId?: string;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt?: Date;
  accessCount: number;
  decayScore: number;
  embedding?: Float32Array;
}

export interface MemoryFilter {
  types?: string[];
  tags?: string[];
  project?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export interface VectorSearchFilter {
  project?: string;
  types?: string[];
  tags?: string[];
}

export interface VectorSearchResult {
  memoryId: string;
  score: number;
}

export interface FTSResult {
  memoryId: string;
  rank: number;
  snippet?: string;
}

export interface EntityInput {
  name: string;
  type: string;
  description?: string;
  properties?: Record<string, unknown>;
  project?: string;
}

export interface EntityRecord {
  id: string;
  name: string;
  type: string;
  description: string | null;
  properties: Record<string, unknown> | null;
}

export interface RelationInput {
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  weight?: number;
  properties?: Record<string, unknown>;
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

export interface GraphTraversalResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: TraversalPath[];
}

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  weight: number;
  properties?: Record<string, unknown>;
}

export interface TraversalPath {
  nodes: string[];
  edges: string[];
  distance: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface LearningInput {
  type: string;
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
  type: string;
  /** Learning summary/content (core returns 'summary') */
  content?: string;
  /** Summary text (core field name) */
  summary?: string;
  context?: string;
  action?: string;
  target?: string | null;
  createdAt?: string | Date | null;
  project?: string;
  memoryId?: string | null;
}

export interface LearningFilter {
  types?: string[];
  project?: string;
  limit?: number;
}

export interface SchemaHealth {
  healthy: boolean;
  version: string;
  issues: string[];
}

// ─── Recall & Search Types ───────────────────────────────────────────────────

/**
 * Options for recalling memories via the SDK.
 */
export interface RecallOptions {
  /** Project path to scope the recall */
  project?: string;
  /** Maximum number of results */
  limit?: number;
  /** Filter by memory type */
  type?: MemoryType;
  /** Filter by tags */
  tags?: string[];
  /** User identifier */
  user?: string;
  /** Session identifier */
  sessionId?: string;
  /** Whether to include trace/debug info in the result */
  trace?: boolean;
}

/**
 * Result of a semantic search operation.
 */
export interface SemanticResult {
  /** The matching memory record */
  memory: MemoryRecord;
  /** Similarity score (0-1) */
  score: number;
  /** Which retrieval source found this result */
  source: 'vector' | 'graph' | 'hybrid';
}

/**
 * Result of a recall operation.
 */
export interface RecallResult {
  /** Matching memory records */
  memories: MemoryRecord[];
  /** Graph entities related to the query */
  graphEntities?: EntityRecord[];
  /** Routing information showing how the query was processed */
  routing: {
    /** Classified intent of the query */
    intent: string;
    /** Strategy used for retrieval */
    strategy: string;
    /** Confidence in the routing decision */
    confidence: number;
  };
  /** Execution metadata */
  metadata: {
    /** Total number of results found */
    totalResults: number;
    /** Time taken in milliseconds */
    durationMs: number;
    /** Sources that contributed results */
    sources: string[];
  };
}
