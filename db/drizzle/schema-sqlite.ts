import { sqliteTable, text, integer, real, blob, index, primaryKey, unique } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

// Core Tables - SQLite compatible version
// ============================================================================

/**
 * Users - represents Claude Code users
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  externalId: text('external_id').unique(), // Claude user ID if available
  name: text('name'),
  email: text('email'),
  preferences: text('preferences').$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/**
 * Projects - workspaces that memories are scoped to
 */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  name: text('name').notNull(),
  path: text('path').notNull(),
  description: text('description'),
  metadata: text('metadata').$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('projects_path_idx').on(table.path),
]);

/**
 * Memories - core memory storage
 */
export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey().$default(() => crypto.randomUUID()),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),

    // Content
    type: text('type').notNull().$type<'observation' | 'fact' | 'decision' | 'context' | 'preference' | 'note'>(),
    content: text('content').notNull(),
    summary: text('summary'),

    // Embeddings stored as JSON string (for vector similarity search)
    embeddingJson: text('embedding_json'),

    // v0.2.0: Vector embedding for local search
    embedding: blob('embedding'),

    // Batch 4: primary float32 LE blob storage + model provenance stamps
    embeddingBlob: blob('embedding_blob'),
    embeddingModel: text('embedding_model'),
    embeddingDim: integer('embedding_dim'),

	// Metadata
	source: text('source'),
	confidence: integer('confidence').default(50), // 0-100 confidence score (default: speculative)
	confidenceLevel: text('confidence_level').$type<'certain' | 'speculative' | 'outdated'>().default('speculative'), // Iteration 3: Confidence flags (default: speculative)
	tags: text('tags').$type<string[]>(),
    metadata: text('metadata').$type<Record<string, unknown>>(),

    // v0.2.0: Privacy and relevance
    isPrivate: integer('is_private', { mode: 'boolean' }).default(false),
    hasSecrets: integer('has_secrets', { mode: 'boolean' }).default(false),
    relevanceScore: integer('relevance_score').default(50), // 0-100

    // Lifecycle
    isActive: integer('is_active', { mode: 'boolean' }).default(true),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    accessCount: integer('access_count').default(0),
    lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' }),

    // Merge tracking
    isMerged: integer('is_merged', { mode: 'boolean' }).default(false),
    mergedIntoId: text('merged_into_id').references((): any => (memories as any).id),
    mergedAt: integer('merged_at', { mode: 'timestamp' }),
    isCanonical: integer('is_canonical', { mode: 'boolean' }).default(false),
    mergeSourceIds: text('merge_source_ids').$type<string[]>(),
    isMergeable: integer('is_mergeable', { mode: 'boolean' }).default(true),
    mergeVersion: integer('merge_version').default(1),

    // v0.4.2: Namespace support
    namespaceId: text('namespace_id').references(() => namespaces.id, { onDelete: 'set null' }),
    namespacePath: text('namespace_path'),

    // v1.1.5: Places support (spatial memory organization)
    placeId: text('place_id').references(() => places.id, { onDelete: 'set null' }),
    placeSortOrder: integer('place_sort_order'),

    // v1.5.0: Multi-place routing
    primaryPlace: text('primary_place'),  // primary cognitive place (board/wip/sparks/ref/inbox)
    memoryType: text('memory_type'),      // e.g. user_preference, technical_decision, project_state, etc.

    // v1.6.0: Multimodal support
    mediaType: text('media_type'),        // 'image' | 'audio' | 'video' | 'document' | null (text-only)
    mediaPath: text('media_path'),        // path to original media file
    mediaMetadata: text('media_metadata'), // JSON: dimensions, duration, pages, etc.

    // v0.4.3: Layer support
    hasL0Abstract: integer('has_l0_abstract', { mode: 'boolean' }).default(false),
    hasL1Overview: integer('has_l1_overview', { mode: 'boolean' }).default(false),
    lastLayerUpdate: integer('last_layer_update', { mode: 'timestamp' }),

    // v0.8.0: Importance Scoring
    importanceScore: integer('importance_score').default(50), // 0-100
    importanceDecayRate: integer('importance_decay_rate').default(30), // days half-life
    lastImportanceRecalc: integer('last_importance_recalc', { mode: 'timestamp' }),

    // v0.10.0: Echo/Fizzle Tracking - Retrieval Priority
    retrievalPriority: integer('retrieval_priority').default(50), // 0-100, adjusted by feedback

    // v1.0.x: Token tracking
    tokensEstimate: integer('tokens_estimate').default(0).notNull(),

    // v0.8.0: Consolidation tracking
    consolidatedInto: text('consolidated_into').references((): any => (memories as any).id),
    consolidatedAt: integer('consolidated_at', { mode: 'timestamp' }),
    isConsolidated: integer('is_consolidated', { mode: 'boolean' }).default(false),

// v0.3.0: Memory Lifecycle Management
  sector: text('sector').$type<'episodic' | 'semantic' | 'procedural' | 'autobiographical' | 'working'>().default('episodic'),
  tier: text('tier').default('working'),
  status: text('status').notNull().default('active'),
  encrypted_content: text('encrypted_content'),
  encryption_nonce: text('encryption_nonce'),
  is_encrypted: integer('is_encrypted', { mode: 'boolean' }).default(false),

  // v0.5.0: Context Status - Track whether memory is in active context or archived
  contextStatus: text('context_status').$type<'in-context' | 'out-of-context' | 'archived'>().default('out-of-context'),

  // Per-memory decay rate (integer percentage, e.g., 30 = 30% decay per cycle)
  decayRate: integer('decay_rate').default(30),
    coactivationScore: integer('coactivation_score').default(0),
    lastDecayAt: integer('last_decay_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`),

    // v0.3.0: Agent-Aware Memory
    agentId: text('agent_id'),
    agentRole: text('agent_role'),
    visibilityScope: text('visibility_scope').$type<'private' | 'project' | 'team'>().default('private'),

    // v0.3.0: Memory Governance
    isProtected: integer('is_protected', { mode: 'boolean' }).default(false),
    isPinned: integer('is_pinned', { mode: 'boolean' }).default(false),
    isImmutable: integer('is_immutable', { mode: 'boolean' }).default(false),
    writeScope: text('write_scope').$type<string[]>(),
    readScope: text('read_scope').$type<string[]>(),

    // v0.3.0: Provenance
    triggeredBy: text('triggered_by'),
    captureReason: text('capture_reason'),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    usageCount: integer('usage_count').default(0),

    // v0.3.0: Temporal Facts
    validFrom: integer('valid_from', { mode: 'timestamp' }),
    validTo: integer('valid_to', { mode: 'timestamp' }),
    recordedAt: integer('recorded_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(), // When agent learned/stored the fact
    supersededBy: text('superseded_by').references((): any => (memories as any).id),
    version: integer('version').default(1),

    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table): any => [
    index('memories_project_idx').on(table.projectId),
    index('memories_type_idx').on(table.type),
    index('memories_created_idx').on(table.createdAt),
    index('memories_tags_idx').on(table.tags),
    index('memories_relevance_idx').on(table.relevanceScore),
    index('memories_private_idx').on(table.isPrivate),
    index('memories_merged_idx').on(table.isMerged),
    index('memories_canonical_idx').on(table.isCanonical),
    index('memories_sector_idx').on(table.sector),
    index('memories_tier_idx').on(table.tier),
    index('memories_agent_idx').on(table.agentId),
    index('memories_visibility_idx').on(table.visibilityScope),
    index('memories_protected_idx').on(table.isProtected),
    index('memories_pinned_idx').on(table.isPinned),
    index('memories_valid_from_idx').on(table.validFrom),
    index('memories_valid_to_idx').on(table.validTo),
    index('memories_context_status_idx').on(table.contextStatus),

    // v0.8.0: Importance scoring indexes
    index('memories_importance_idx').on(table.importanceScore),
    index('memories_consolidated_idx').on(table.isConsolidated),
    index('memories_consolidation_query_idx').on(
      table.projectId,
      table.isConsolidated,
      table.importanceScore
    ),

    // v0.5.0: Context status composite index for efficient filtering
    index('memories_context_query_idx').on(
      table.projectId,
      table.contextStatus,
      table.tier
    ),

    // v0.4.2: Composite indexes for performance optimization
    // Duplicate detection query optimization
    index('memories_duplicate_detection_idx').on(
      table.projectId,
      table.isMerged,
      table.isMergeable,
      table.isActive
    ),
    // Eviction query optimization
    index('memories_eviction_idx').on(
      table.projectId,
      table.tier,
      table.relevanceScore,
      table.createdAt
    ),
    // Decay operations optimization
    index('memories_decay_idx').on(
      table.sector,
      table.lastDecayAt,
      table.isProtected
    ),
    // Temporal query optimization
    index('memories_temporal_idx').on(
      table.projectId,
      table.validFrom,
      table.validTo
    ),
    // Agent-aware retrieval optimization
    index('memories_agent_visibility_idx').on(
      table.agentId,
      table.visibilityScope,
      table.isActive
    ),
    // Team memory retrieval optimization
    index('memories_team_idx').on(table.teamId),
  ],
) as any;

/**
 * Conversations - chat session tracking
 */
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

  sessionId: text('session_id').notNull(),
  title: text('title'),
  summary: text('summary'),

  messageCount: integer('message_count').default(0),
  tokenCount: integer('token_count').default(0),

  startedAt: integer('started_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp' }),

  metadata: text('metadata').$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('conversations_project_idx').on(table.projectId),
  index('conversations_session_idx').on(table.sessionId),
  index('conversations_started_idx').on(table.startedAt),
]);

/**
 * Messages - individual messages in conversations
 */
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),

  role: text('role').notNull().$type<'user' | 'assistant'>(),
  content: text('content').notNull(),

  embeddingJson: text('embedding_json'),
  tokenCount: integer('token_count'),
  toolCalls: text('tool_calls').$type<unknown[]>(),
  metadata: text('metadata').$type<Record<string, unknown>>(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('messages_conversation_idx').on(table.conversationId),
  index('messages_role_idx').on(table.role),
  index('messages_created_idx').on(table.createdAt),
]);

/**
 * Learnings - agent learnings: success, failure, fix, insight
 */
export const learnings = sqliteTable('learnings', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),

  // Learning type: success, failure, fix, insight
  type: text('type').notNull().$type<'success' | 'failure' | 'fix' | 'insight'>(),
  action: text('action').notNull(),
  target: text('target'),
  summary: text('summary').notNull(),
  details: text('details').$type<Record<string, unknown>>(),

  // Embeddings
  embeddingJson: text('embedding_json'),
  embedding: blob('embedding'),

  // Optional link to a memory (for bidirectional linking)
  memoryId: text('memory_id').references(() => memories.id, { onDelete: 'set null' }),

  // Folder-scoped
  folderPath: text('folder_path'),
  projectPath: text('project_path'),

  // Privacy and relevance
  isPrivate: integer('is_private', { mode: 'boolean' }).default(false),
  hasSecrets: integer('has_secrets', { mode: 'boolean' }).default(false),
  relevanceScore: integer('relevance_score').default(50),

  category: text('category'),
  importance: integer('importance').default(50),
  metadata: text('metadata').$type<Record<string, unknown>>(),

  // Migration tracking
  isImported: integer('is_imported', { mode: 'boolean' }).default(false),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('learnings_project_idx').on(table.projectId),
  index('learnings_type_idx').on(table.type),
  index('learnings_action_idx').on(table.action),
  index('learnings_created_idx').on(table.createdAt),
  index('learnings_folder_idx').on(table.folderPath),
  index('learnings_relevance_idx').on(table.relevanceScore),
  index('learnings_private_idx').on(table.isPrivate),
  index('learnings_memory_idx').on(table.memoryId),
]);

/**
 * Agent Preferences - learned agent preferences from learnings
 * Enables agents to evolve and remember preferences over time
 */
export const agentPreferences = sqliteTable('agent_preferences', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  
  key: text('key').notNull(),  // e.g., "prefer_bun", "prefer_typescript"
  value: text('value').notNull(),  // e.g., "bun", "true"
  
  sourceMemoryId: text('source_memory_id').references(() => memories.id, { onDelete: 'set null' }),
  confidence: text('confidence').default('0.5'),  // 0.00 to 1.00
  usageCount: integer('usage_count').default(1),
  
  lastUpdated: integer('last_updated', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('agent_preferences_project_idx').on(table.projectId),
  index('agent_preferences_key_idx').on(table.key),
]);

/**
 * Entities - named entities in the codebase
 */
export const entities = sqliteTable('entities', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  type: text('type').notNull(),
  description: text('description'),

  embeddingJson: text('embedding_json'),
  properties: text('properties').$type<Record<string, unknown>>(),
  mentionCount: integer('mention_count').default(0),
  lastMentionedAt: integer('last_mentioned_at'),
  aliases: text('aliases').$type<string[]>(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('entities_project_idx').on(table.projectId),
  index('entities_type_idx').on(table.type),
  index('entities_name_idx').on(table.name),
]);

/**
 * Namespaces - Hierarchical folder-like namespaces for memory organization
 */
export const namespaces: any = sqliteTable('namespaces', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  parentId: text('parent_id').references(() => namespaces.id, { onDelete: 'set null' }),
  type: text('type'),
  description: text('description'),

  path: text('path'),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('namespaces_project_idx').on(table.projectId),
  index('namespaces_parent_idx').on(table.parentId),
]);

/**
 * Places - Spatial memory organization
 */
export const places: any = sqliteTable('places', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  
  name: text('name').notNull(),
  placeType: text('place_type').notNull(),
  parentId: text('parent_id').references(() => places.id, { onDelete: 'set null' }),
  
  sortOrder: integer('sort_order').default(0),
  positionX: integer('position_x').default(0),
  positionY: integer('position_y').default(0),
  description: text('description'),
  purpose: text('purpose'),
  memoryCount: integer('memory_count').default(0),
  
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('places_project_idx').on(table.projectId),
  index('places_type_idx').on(table.placeType),
  index('places_parent_idx').on(table.parentId),
  index('places_sort_order_idx').on(table.projectId, table.sortOrder),
]);

/**
 * Memory-Place assignments (v1.5.0: 1:N multi-place routing)
 */
export const memoryPlaces: any = sqliteTable('memory_places', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  memoryId: text('memory_id').references(() => memories.id, { onDelete: 'cascade' }).notNull(),
  placeType: text('place_type').notNull(),  // 'board' | 'wip' | 'sparks' | 'ref' | 'inbox' | 'sandbox' | 'archive'
  weight: real('weight').default(1.0).notNull(),  // 0.0-1.0, higher = more relevant to this place
  reason: text('reason'),  // why this memory belongs here
  source: text('source').default('heuristic').notNull(),  // 'heuristic' | 'llm' | 'manual' | 'dream' | 'legacy'
  isPrimary: integer('is_primary', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('memory_places_memory_idx').on(table.memoryId),
  index('memory_places_place_type_idx').on(table.placeType),
  index('memory_places_place_weight_idx').on(table.placeType, table.weight),
  index('memory_places_memory_primary_idx').on(table.memoryId, table.isPrimary),
  unique('memory_places_unique').on(table.memoryId, table.placeType, table.source),
]);

/**
 * Memory Tags (v1.5.0: Tag-aware retrieval)
 */
export const memoryTags = sqliteTable('memory_tags', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  memoryId: text('memory_id').references(() => memories.id, { onDelete: 'cascade' }).notNull(),
  tag: text('tag').notNull(),
  source: text('source').default('heuristic').notNull(),  // 'heuristic' | 'llm' | 'manual' | 'dream'
  confidence: real('confidence'),  // nullable, 0.0-1.0
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('memory_tags_tag_idx').on(table.tag),
  index('memory_tags_memory_idx').on(table.memoryId),
  index('memory_tags_tag_memory_idx').on(table.tag, table.memoryId),
  unique('memory_tags_unique').on(table.memoryId, table.tag),
]);

/**
 * Place auto-assignment rules
 */
export const placeRules: any = sqliteTable('place_rules', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  
  name: text('name').notNull(),
  placeType: text('place_type').notNull(),
  
  matchTool: text('match_tool'),
  matchKeyword: text('match_keyword'),
  matchTag: text('match_tag'),
  matchMemoryType: text('match_memory_type'),
  
  priority: integer('priority').default(0),
  enabled: integer('enabled').default(1),
  
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('place_rules_project_idx').on(table.projectId),
  index('place_rules_type_idx').on(table.placeType),
]);

/**
 * Memory Layers - Tiered L0/L1/L2 summaries for token-efficient retrieval
 */
export const memoryLayers = sqliteTable('memory_layers', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  memoryId: text('memory_id').references(() => memories.id, { onDelete: 'cascade' }),

  layerType: text('layer_type').notNull().$type<'l0_abstract' | 'l1_overview' | 'l2_full'>(),
  content: text('content').notNull(),
  tokenCount: integer('token_count').default(0),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('memory_layers_memory_idx').on(table.memoryId),
  index('memory_layers_type_idx').on(table.layerType),
]);

// Progressive Disclosure & Context Paging Tables
// ============================================================================

/**
 * Lightweight memory indices for progressive disclosure - previews and metadata
 * used for quick filtering before loading full memories
 */
export const lightweightMemoryIndices = sqliteTable('lightweight_memory_indices', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  memoryId: text('memory_id').references(() => memories.id, { onDelete: 'cascade' }),
  
  // Hash for quick comparison
  contentHash: text('content_hash').notNull(),
  contentPreview: text('content_preview').notNull(),
  keyTerms: text('key_terms').$type<string[]>(),
  
  // Categorization
  category: text('category').notNull(),
  importanceScore: integer('importance_score').notNull(),
  
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('lightweight_indices_memory_idx').on(table.memoryId),
  index('lightweight_indices_category_idx').on(table.category),
  index('lightweight_indices_importance_idx').on(table.importanceScore),
]);

/**
 * Context paging sessions for tracking loaded/preloaded memories
 * Agent-controlled memory loading system
 */
export const contextPagingSessions = sqliteTable('context_paging_sessions', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  sessionId: text('session_id').notNull().unique(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  
  // Loaded memories (actively in context)
  loadedMemoryIds: text('loaded_memory_ids').$type<string[]>().default([]),
  
  // Preload candidates (ready to load if needed)
  preloadCandidateIds: text('preload_candidate_ids').$type<string[]>().default([]),
  
  // Token tracking
  tokenBudget: integer('token_budget').default(8000).notNull(),
  tokensUsed: integer('tokens_used').default(0).notNull(),
  loadedMemoriesTokens: integer('loaded_memories_tokens').default(0).notNull(),
  
  // Session metadata
  metadata: text('metadata').$type<Record<string, unknown>>(),
  
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('context_paging_session_idx').on(table.sessionId),
  index('context_paging_project_idx').on(table.projectId),
  index('context_paging_created_idx').on(table.createdAt),
]);

// Memory Merging Tables
// ============================================================================

/**
 * Memory Merge Proposals - tracks suggested merges before user approval
 */
export const memoryMergeProposals = sqliteTable('memory_merge_proposals', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

  sourceMemoryIds: text('source_memory_ids').$type<string[]>().notNull(),
  proposedContent: text('proposed_content').notNull(),
  proposedSummary: text('proposed_summary'),
  proposedTags: text('proposed_tags').$type<string[]>(),
  proposedMetadata: text('proposed_metadata').$type<Record<string, unknown>>(),

  detectionMethod: text('detection_method').notNull().$type<'simhash' | 'minhash' | 'embedding'>(),
  similarityScore: text('similarity_score').notNull(),
  confidenceLevel: text('confidence_level').notNull().$type<'high' | 'medium' | 'low'>(),

  mergeReason: text('merge_reason').notNull(),
  conflictWarnings: text('conflict_warnings').$type<string[]>(),

  status: text('status').$type<'pending' | 'approved' | 'rejected' | 'expired'>().default('pending').notNull(),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
  reviewNotes: text('review_notes'),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
}, (table) => [
  index('memory_merge_proposals_project_status_idx').on(table.projectId, table.status),
  index('memory_merge_proposals_created_at_idx').on(table.createdAt),
]);

/**
 * Memory Merge History - audit trail of completed merges
 */
export const memoryMergeHistory = sqliteTable('memory_merge_history', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

  proposalId: text('proposal_id').references(() => memoryMergeProposals.id, { onDelete: 'set null' }),
  sourceMemoryIds: text('source_memory_ids').$type<string[]>().notNull(),
  canonicalMemoryId: text('canonical_memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),

  sourceMemoriesSnapshot: text('source_memories_snapshot').$type<Record<string, unknown>[]>().notNull(),

  mergeStrategy: text('merge_strategy').notNull().$type<'union' | 'latest' | 'voting' | 'custom'>(),
  tokensSaved: integer('tokens_saved'),

  isReversed: integer('is_reversed', { mode: 'boolean' }).default(false),
  reversedAt: integer('reversed_at', { mode: 'timestamp' }),
  reversedBy: text('reversed_by'),

  mergedAt: integer('merged_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/**
 * Memory Hash Cache - cached hash signatures for efficient duplicate detection
 */
export const memoryHashCache = sqliteTable('memory_hash_cache', {
  memoryId: text('memory_id').primaryKey().references(() => memories.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),

  simhash: text('simhash'),
  minhash: text('minhash').$type<number[]>(),

  contentHash: text('content_hash').notNull(),
  lastUpdated: integer('last_updated', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('memory_hash_cache_project_id_idx').on(table.projectId),
  index('memory_hash_cache_simhash_idx').on(table.simhash),
]);

/**
 * Entity Relations - relationships between entities
 */
export const entityRelations = sqliteTable('entity_relations', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  fromEntityId: text('from_entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  toEntityId: text('to_entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),

  type: text('type').notNull(),
  weight: integer('weight').default(1),
  properties: text('properties').$type<Record<string, unknown>>(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('relations_from_idx').on(table.fromEntityId),
  index('relations_to_idx').on(table.toEntityId),
  index('relations_type_idx').on(table.type),
]);

// v0.3.0: Lifecycle Features - Associations, Summarization, Snapshots
// ============================================================================

/**
 * Memory Associations - waypoint graph for co-activation tracking
 */
export const memoryAssociations = sqliteTable('memory_associations', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  fromMemoryId: text('from_memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  toMemoryId: text('to_memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  associationType: text('association_type').notNull().$type<'co_occurred' | 'supersedes' | 'contradicts' | 'supports' | 'relates_to'>(),
  weight: integer('weight').default(1),
  coactivationCount: integer('coactivation_count').default(0),
  metadata: text('metadata').$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  lastCoactivatedAt: integer('last_coactivated_at', { mode: 'timestamp' }),
}, (table) => [
  index('memory_associations_from_idx').on(table.fromMemoryId),
  index('memory_associations_to_idx').on(table.toMemoryId),
  index('memory_associations_type_idx').on(table.associationType),
  index('memory_associations_weight_idx').on(table.weight),
  // v0.4.2: Composite index for graph traversal optimization
  index('memory_associations_graph_traversal_idx').on(
    table.fromMemoryId,
    table.toMemoryId,
    table.weight,
    table.associationType
  ),
]);

/**
 * Session Summaries - incremental and rolling session summaries
 */
export const sessionSummaries = sqliteTable('session_summaries', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  summaryType: text('summary_type').notNull().$type<'incremental' | 'rolling' | 'final'>(),
  content: text('content').notNull(),
  compressedFrom: integer('compressed_from'),
  tokensSaved: integer('tokens_saved'),
  embedding: blob('embedding'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('session_summaries_conversation_idx').on(table.conversationId),
  index('session_summaries_project_idx').on(table.projectId),
  index('session_summaries_type_idx').on(table.summaryType),
  index('session_summaries_created_idx').on(table.createdAt),
]);

/**
 * Memory Snapshots - before/after diffs for auditability
 */
export const memorySnapshots = sqliteTable('memory_snapshots', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  snapshotType: text('snapshot_type').notNull().$type<'before_update' | 'after_update' | 'periodic' | 'correction'>(),
  content: text('content').notNull(),
  metadata: text('metadata').$type<Record<string, unknown>>(),
  diff: text('diff').$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('memory_snapshots_memory_idx').on(table.memoryId),
  index('memory_snapshots_type_idx').on(table.snapshotType),
  index('memory_snapshots_created_idx').on(table.createdAt),
]);

/**
 * Core Memory - Always-in-context memory (Tier 1)
 * Small, persistent, always-visible memory block (< 2KB total)
 */
export const coreMemory = sqliteTable('core_memory', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

   // Core memory sections
   section: text('section').notNull().$type<'persona' | 'user_info' | 'project_context' | 'working_notes'>(),
   content: text('content').notNull().default(''),
   sizeBytes: integer('size_bytes').default(0).notNull(),
   tokensEstimate: integer('tokens_estimate').default(0).notNull(),

   // Version tracking
   version: integer('version').default(1).notNull(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('core_memory_project_idx').on(table.projectId),
  index('core_memory_user_idx').on(table.userId),
  index('core_memory_section_idx').on(table.section),
]);

/**
 * Context Sessions - Track loaded memories and context window usage
 */
export const contextSessions = sqliteTable('context_sessions', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  sessionId: text('session_id').notNull().unique(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

  // Loaded memories (paging system)
  loadedMemoryIds: text('loaded_memory_ids').$type<string[]>().default([]),

  // Token tracking
  tokenBudget: integer('token_budget').default(8000).notNull(),
  tokensUsed: integer('tokens_used').default(0).notNull(),
  coreMemoryTokens: integer('core_memory_tokens').default(0).notNull(),
  loadedMemoriesTokens: integer('loaded_memories_tokens').default(0).notNull(),

  // Session metadata
  metadata: text('metadata').$type<Record<string, unknown>>(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('context_sessions_session_idx').on(table.sessionId),
  index('context_sessions_project_idx').on(table.projectId),
  index('context_sessions_created_idx').on(table.createdAt),
]);

// =============================================================================
// Knowledge System (v2.0.0) — Unified table replacing memories, beliefs, strategies
// =============================================================================

/**
 * Knowledge - single source of truth for all knowledge items.
 * knowledge_kind discriminates: 'memory' | 'belief' | 'strategy'.
 * Fields are nullable based on kind (belief fields only populated for beliefs, etc.).
 */
export const knowledge: any = sqliteTable(
  'knowledge',
  {
    id: text('id').primaryKey().$default(() => crypto.randomUUID()),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    agentId: text('agent_id'),
    sessionId: text('session_id'),

    // Classification
    knowledgeKind: text('knowledge_kind').notNull().$type<'memory' | 'belief' | 'strategy'>(),
    knowledgeType: text('knowledge_type').notNull(),

    // Content
    content: text('content').notNull(),
    summary: text('summary'),

    // Embeddings (multi-model)
    embeddingJson: text('embedding_json'),
    embedding: blob('embedding'),
    embeddingBlob: blob('embedding_blob'),
    embeddingModel: text('embedding_model'),
    embeddingDim: integer('embedding_dim'),

    // Confidence & importance
    confidence: real('confidence').default(0.5),
    confidenceLevel: text('confidence_level').$type<'certain' | 'speculative' | 'outdated'>().default('certain'),
    importanceScore: real('importance_score').default(0.5),
    importanceDecayRate: real('importance_decay_rate').default(30),
    lastImportanceRecalc: integer('last_importance_recalc', { mode: 'timestamp' }),

    // Belief-specific
    normalizedKey: text('normalized_key'),
    reason: text('reason'),
    evidenceSummary: text('evidence_summary'),
    evidence: text('evidence').$type<Record<string, unknown>>(),
    lastConfirmedAt: integer('last_confirmed_at', { mode: 'timestamp' }),
    sourceCount: integer('source_count').default(1),

    // Strategy-specific
    title: text('title'),
    description: text('description'),
    steps: text('steps'),
    successCriteria: text('success_criteria'),
    failureIndicators: text('failure_indicators'),
    usageCount: integer('usage_count').default(0),
    successCount: integer('success_count').default(0),
    failureCount: integer('failure_count').default(0),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    lastSuccessAt: integer('last_success_at', { mode: 'timestamp' }),
    lastFailureAt: integer('last_failure_at', { mode: 'timestamp' }),

    // Status & lifecycle
    status: text('status').default('active'),
    isActive: integer('is_active', { mode: 'boolean' }).default(true),
    sector: text('sector').default('general'),
    tier: text('tier').default('episodic'),
    version: integer('version').default(1),

    // Self-referencing relationships
    supersededBy: text('superseded_by'),
    contradictsId: text('contradicts_id'),
    informedById: text('informed_by_id'),

    // Tags & metadata
    tags: text('tags').$type<string[]>(),
    metadata: text('metadata').$type<Record<string, unknown>>(),

    // Place routing
    placeId: text('place_id'),
    primaryPlace: text('primary_place'),

    // Privacy & governance
    isPrivate: integer('is_private', { mode: 'boolean' }).default(false),
    isProtected: integer('is_protected', { mode: 'boolean' }).default(false),
    isPinned: integer('is_pinned', { mode: 'boolean' }).default(false),
    isImmutable: integer('is_immutable', { mode: 'boolean' }).default(false),
    writeScope: text('write_scope').$type<string[]>(),
    readScope: text('read_scope').$type<string[]>(),

    // Visibility
    scope: text('scope').$type<'company' | 'employee'>().default('company'),
    visibilityScope: text('visibility_scope').$type<'private' | 'project' | 'team'>().default('private'),

    // Provenance
    actorUser: text('actor_user'),
    actorAgent: text('actor_agent'),
    agentRole: text('agent_role'),
    triggeredBy: text('triggered_by'),
    captureReason: text('capture_reason'),

    // Temporal facts
    validFrom: integer('valid_from', { mode: 'timestamp' }),
    validTo: integer('valid_to', { mode: 'timestamp' }),
    recordedAt: integer('recorded_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),

    // Access tracking
    accessCount: integer('access_count').default(0),
    lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' }),

    // Merge tracking
    isMerged: integer('is_merged', { mode: 'boolean' }).default(false),
    mergedIntoId: text('merged_into_id'),
    mergedAt: integer('merged_at', { mode: 'timestamp' }),

    // Consolidation
    consolidatedFrom: text('consolidated_from').$type<string[]>(),
    consolidatedAt: integer('consolidated_at', { mode: 'timestamp' }),
    isConsolidated: integer('is_consolidated', { mode: 'boolean' }).default(false),

    // Encryption
    encryptedContent: text('encrypted_content'),
    encryptionNonce: text('encryption_nonce'),
    isEncrypted: integer('is_encrypted', { mode: 'boolean' }).default(false),

    // Retrieval optimization
    compressionLevel: integer('compression_level'),
    relevanceScore: integer('relevance_score').default(50),
    tokensEstimate: integer('tokens_estimate').default(0),

    // Decay system
    decayRate: integer('decay_rate').default(30),
    coactivationScore: integer('coactivation_score').default(0),
    lastDecayAt: integer('last_decay_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`),

    // Layer tracking
    hasL0Abstract: integer('has_l0_abstract', { mode: 'boolean' }).default(false),
    hasL1Overview: integer('has_l1_overview', { mode: 'boolean' }).default(false),
    lastLayerUpdate: integer('last_layer_update', { mode: 'timestamp' }),

    // Multimodal
    mediaType: text('media_type'),
    mediaPath: text('media_path'),
    mediaMetadata: text('media_metadata'),

    // Organization
    namespaceId: text('namespace_id'),
    namespacePath: text('namespace_path'),

    // Cloud-specific
    employeeId: text('employee_id'),

    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table): any => [
    index('knowledge_project_idx').on(table.projectId),
    index('knowledge_kind_idx').on(table.knowledgeKind),
    index('knowledge_type_idx').on(table.knowledgeType),
    index('knowledge_status_idx').on(table.status),
    index('knowledge_session_idx').on(table.sessionId),
    index('knowledge_user_idx').on(table.userId),
    index('knowledge_agent_idx').on(table.agentId),
    index('knowledge_confidence_idx').on(table.confidence),
    index('knowledge_active_idx').on(table.isActive),
    index('knowledge_created_idx').on(table.createdAt),
    index('knowledge_sector_idx').on(table.sector),
    index('knowledge_tier_idx').on(table.tier),
    index('knowledge_project_kind_idx').on(table.projectId, table.knowledgeKind),
    index('knowledge_project_status_idx').on(table.projectId, table.status),
    index('knowledge_normalized_key_idx').on(table.normalizedKey),
    index('knowledge_duplicate_detection_idx').on(
      table.projectId,
      table.isMerged,
      table.isActive
    ),
    index('knowledge_eviction_idx').on(
      table.projectId,
      table.tier,
      table.relevanceScore,
      table.createdAt
    ),
    index('knowledge_decay_idx').on(
      table.sector,
      table.lastDecayAt,
      table.isProtected
    ),
    index('knowledge_temporal_idx').on(
      table.projectId,
      table.validFrom,
      table.validTo
    ),
    index('knowledge_agent_visibility_idx').on(
      table.agentId,
      table.visibilityScope,
      table.isActive
    ),
  ],
) as any;

/**
 * Knowledge Edges - universal relationship table (v2.0.0).
 * Replaces: belief_edges, strategy_edges, strategy_belief_edges,
 *           entity_relations, memory_places (as edge type).
 * Polymorphic via from_kind/to_kind: 'knowledge' | 'entity' | 'place'.
 */
export const knowledgeEdges = sqliteTable(
  'knowledge_edges',
  {
    id: text('id').primaryKey().$default(() => crypto.randomUUID()),
    fromId: text('from_id').notNull(),
    fromKind: text('from_kind').notNull().$type<'knowledge' | 'entity' | 'place'>(),
    toId: text('to_id').notNull(),
    toKind: text('to_kind').notNull().$type<'knowledge' | 'entity' | 'place'>(),
    edgeType: text('edge_type').notNull(),
    weight: real('weight').default(1.0),
    metadata: text('metadata').$type<Record<string, unknown>>(),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    index('knowledge_edges_from_idx').on(table.fromId, table.fromKind),
    index('knowledge_edges_to_idx').on(table.toId, table.toKind),
    index('knowledge_edges_type_idx').on(table.edgeType),
    index('knowledge_edges_from_kind_idx').on(table.fromKind),
    index('knowledge_edges_to_kind_idx').on(table.toKind),
    unique('knowledge_edges_unique').on(table.fromId, table.fromKind, table.toId, table.toKind, table.edgeType),
  ],
);

/**
 * Agent Session Cache - Batch 7
 * Read-through cache for parsed harness session stores (claude-code JSONL,
 * codex rollouts, gemini chats). Invalidated by source file mtime + size.
 */
export const agentSessionCache = sqliteTable('agent_session_cache', {
  cacheKey: text('cache_key').primaryKey(),
  agent: text('agent').notNull(),
  sessionId: text('session_id').notNull(),
  sourcePath: text('source_path').notNull(),
  mtimeMs: integer('mtime_ms').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  payload: text('payload').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('agent_session_cache_agent_idx').on(table.agent),
]);

// Types
// ============================================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type Learning = typeof learnings.$inferSelect;
export type NewLearning = typeof learnings.$inferInsert;

export type AgentPreference = typeof agentPreferences.$inferSelect;
export type NewAgentPreference = typeof agentPreferences.$inferInsert;

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;

export type EntityRelation = typeof entityRelations.$inferSelect;
export type NewEntityRelation = typeof entityRelations.$inferInsert;

export type MemoryMergeProposal = typeof memoryMergeProposals.$inferSelect;
export type NewMemoryMergeProposal = typeof memoryMergeProposals.$inferInsert;

export type MemoryMergeHistory = typeof memoryMergeHistory.$inferSelect;
export type NewMemoryMergeHistory = typeof memoryMergeHistory.$inferInsert;

export type MemoryHashCache = typeof memoryHashCache.$inferSelect;
export type NewMemoryHashCache = typeof memoryHashCache.$inferInsert;

export type MemoryAssociation = typeof memoryAssociations.$inferSelect;
export type NewMemoryAssociation = typeof memoryAssociations.$inferInsert;

export type SessionSummary = typeof sessionSummaries.$inferSelect;
export type NewSessionSummary = typeof sessionSummaries.$inferInsert;

export type MemorySnapshot = typeof memorySnapshots.$inferSelect;
export type NewMemorySnapshot = typeof memorySnapshots.$inferInsert;

export type CoreMemory = typeof coreMemory.$inferSelect;
export type NewCoreMemory = typeof coreMemory.$inferInsert;

export type ContextSession = typeof contextSessions.$inferSelect;
export type NewContextSession = typeof contextSessions.$inferInsert;

// v0.10.0: Echo/Fizzle Tracking & Scheduled Maintenance
// ============================================================================

export const memoryFeedback = sqliteTable('memory_feedback', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  wasInjected: integer('was_injected', { mode: 'boolean' }).default(false),
  wasReferenced: integer('was_referenced', { mode: 'boolean' }).default(false),
  referenceCount: integer('reference_count').default(0),
  retrievalPriorityDelta: integer('retrieval_priority_delta').default(0),
  injectedAt: integer('injected_at', { mode: 'timestamp' }),
  referencedAt: integer('referenced_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('memory_feedback_memory_idx').on(table.memoryId),
  index('memory_feedback_session_idx').on(table.sessionId),
  index('memory_feedback_referenced_idx').on(table.wasReferenced),
  index('memory_feedback_conversation_idx').on(table.conversationId),
]);

export const maintenanceJobs = sqliteTable('maintenance_jobs', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  jobName: text('job_name').notNull().unique(),
  jobType: text('job_type').notNull().$type<'nightly' | 'weekly' | 'hourly'>(),
  cronExpression: text('cron_expression'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  nextRunAt: integer('next_run_at', { mode: 'timestamp' }),
  lastRunDuration: integer('last_run_duration'),
  lastRunStatus: text('last_run_status').$type<'success' | 'failed' | 'skipped'>(),
  lastRunError: text('last_run_error'),
  totalRuns: integer('total_runs').default(0),
  successCount: integer('success_count').default(0),
  failureCount: integer('failure_count').default(0),
  jobConfig: text('job_config').$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('maintenance_jobs_name_idx').on(table.jobName),
  index('maintenance_jobs_next_run_idx').on(table.nextRunAt),
  index('maintenance_jobs_type_idx').on(table.jobType),
  index('maintenance_jobs_enabled_idx').on(table.enabled),
]);

export const maintenanceJobHistory = sqliteTable('maintenance_job_history', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  jobId: text('job_id').notNull().references(() => maintenanceJobs.id, { onDelete: 'cascade' }),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  duration: integer('duration'),
  status: text('status').notNull().$type<'success' | 'failed' | 'skipped'>(),
  error: text('error'),
  recordsProcessed: integer('records_processed').default(0),
  resultSummary: text('result_summary').$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('maintenance_job_history_job_idx').on(table.jobId),
  index('maintenance_job_history_started_idx').on(table.startedAt),
  index('maintenance_job_history_status_idx').on(table.status),
]);

export type MemoryFeedback = typeof memoryFeedback.$inferSelect;
export type NewMemoryFeedback = typeof memoryFeedback.$inferInsert;

export type MaintenanceJob = typeof maintenanceJobs.$inferSelect;
export type NewMaintenanceJob = typeof maintenanceJobs.$inferInsert;

export type MaintenanceJobHistory = typeof maintenanceJobHistory.$inferSelect;
export type NewMaintenanceJobHistory = typeof maintenanceJobHistory.$inferInsert;

export type LightweightMemoryIndex = typeof lightweightMemoryIndices.$inferSelect;
export type NewLightweightMemoryIndex = typeof lightweightMemoryIndices.$inferInsert;

export type ContextPagingSession = typeof contextPagingSessions.$inferSelect;
export type NewContextPagingSession = typeof contextPagingSessions.$inferInsert;

// Knowledge System type exports
export type Knowledge = typeof knowledge.$inferSelect;
export type NewKnowledge = typeof knowledge.$inferInsert;
export type KnowledgeEdge = typeof knowledgeEdges.$inferSelect;
export type NewKnowledgeEdge = typeof knowledgeEdges.$inferInsert;

// Memory Editing Tables (SQLite)
// ============================================================================

export const memoryEditProposals = sqliteTable('memory_edit_proposals', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  
  currentContent: text('current_content').notNull(),
  proposedContent: text('proposed_content').notNull(),
  
  reason: text('reason').notNull(),
  conflictWarnings: text('conflict_warnings').$type<string[]>(),
  status: text('status').$type<'pending' | 'approved' | 'rejected' | 'expired'>().default('pending').notNull(),
  
  version: integer('version').default(1).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
  reviewNotes: text('review_notes'),
}, (table) => [
  index('memory_edit_proposals_memory_idx').on(table.memoryId),
  index('memory_edit_proposals_status_idx').on(table.status),
  index('memory_edit_proposals_created_at_idx').on(table.createdAt),
]);

export type MemoryEditProposal = typeof memoryEditProposals.$inferSelect;
export type NewMemoryEditProposal = typeof memoryEditProposals.$inferInsert;

export type SearchTrace = typeof searchTraces.$inferSelect;

// Phase 3: Retrieval Tracing - Search Traces table
// ============================================================================

/**
 * Search Traces - Stores retrieval logs for debugging and performance analysis
 */
export const searchTraces = sqliteTable('search_traces', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  sessionId: text('session_id').notNull(),
  query: text('query').notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),

  // Search pipeline stages (JSONB stored as text for SQLite)
  queryRewrite: text('query_rewrite').$type<string | null>(),
  candidateRetrieval: text('candidate_retrieval').$type<string | null>(),
  entityFiltering: text('entity_filtering').$type<string | null>(),
  hybridScoring: text('hybrid_scoring').$type<string | null>(),
  reranking: text('reranking').$type<string | null>(),

  // Final results
  resultCount: integer('result_count').default(0),
  topResults: text('top_results').$type<string | null>(),

  // Performance metrics
  totalDurationMs: integer('total_duration_ms').default(0),
  metadata: text('metadata').$type<string | null>(),
}, (table) => [
  index('search_traces_session_idx').on(table.sessionId),
  index('search_traces_timestamp_idx').on(table.timestamp),
]);

// Belief Systems - Derived Beliefs from Memory
// ============================================================================

/**
 * Beliefs - Derived semantic beliefs extracted from memories
 * Represents inferred decisions, preferences, constraints, failure causes
 */
export const beliefs = sqliteTable('beliefs', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),

  // Belief identification
  beliefType: text('belief_type').notNull().$type<BeliefType>(),
  statement: text('statement').notNull(),
  normalizedKey: text('normalized_key').notNull(),

  // Confidence and decay
  confidence: integer('confidence').default(50), // 0-100
  beliefDecayRate: integer('belief_decay_rate').default(30), // days half-life
  lastConfirmedAt: integer('last_confirmed_at', { mode: 'timestamp' }),
  sourceCount: integer('source_count').default(1),

  // Status
  status: text('status').$type<BeliefStatus>().default('active'),
  
  // Context and evidence
  reason: text('reason'),
  context: text('context'),
  evidenceSummary: text('evidence_summary'),

  // Metadata (stores edges, derivation info)
  metadata: text('metadata').$type<Record<string, unknown>>(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('beliefs_project_idx').on(table.projectId),
  index('beliefs_type_idx').on(table.beliefType),
  index('beliefs_status_idx').on(table.status),
  index('beliefs_confidence_idx').on(table.confidence),
  index('beliefs_normalized_key_idx').on(table.normalizedKey),
]);

/**
 * Belief Memory Sources - Links beliefs to source memories
 */
export const beliefMemorySources = sqliteTable('belief_memory_sources', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  beliefId: text('belief_id').references(() => beliefs.id, { onDelete: 'cascade' }).notNull(),
  memoryId: text('memory_id').references(() => memories.id, { onDelete: 'cascade' }).notNull(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('belief_sources_belief_idx').on(table.beliefId),
  index('belief_sources_memory_idx').on(table.memoryId),
]);

/**
 * Belief Edges - Relationships between beliefs
 */
export const beliefEdges = sqliteTable('belief_edges', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  fromBeliefId: text('from_belief_id').references(() => beliefs.id, { onDelete: 'cascade' }).notNull(),
  toBeliefId: text('to_belief_id').references(() => beliefs.id, { onDelete: 'cascade' }).notNull(),

  edgeType: text('edge_type').notNull().$type<BeliefEdgeType>(),
  metadata: text('metadata').$type<Record<string, unknown>>(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('belief_edges_from_idx').on(table.fromBeliefId),
  index('belief_edges_to_idx').on(table.toBeliefId),
]);

// Strategy Systems (v1.7.0+)
// ============================================================================

/**
 * Strategies - executable strategies for agents
 */
export const strategies = sqliteTable('strategies', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  agentId: text('agent_id'),

  strategyType: text('strategy_type').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  context: text('context'),
  steps: text('steps'),
  successCriteria: text('success_criteria'),
  failureIndicators: text('failure_indicators'),

  confidence: real('confidence').default(0.5),
  usageCount: integer('usage_count').default(0),
  successCount: integer('success_count').default(0),
  failureCount: integer('failure_count').default(0),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp' }),
  lastFailureAt: integer('last_failure_at', { mode: 'timestamp' }),

  status: text('status').default('active'),
  supersededBy: text('superseded_by'),
  tags: text('tags'),
  metadata: text('metadata').$type<Record<string, unknown>>(),
  visibilityScope: text('visibility_scope').default('private'),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('strategies_project_idx').on(table.projectId),
  index('strategies_type_idx').on(table.strategyType),
  index('strategies_status_idx').on(table.status),
  index('strategies_confidence_idx').on(table.confidence),
  index('strategies_user_idx').on(table.userId),
]);

/**
 * Strategy Edges - relationships between strategies
 */
export const strategyEdges = sqliteTable('strategy_edges', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  fromStrategyId: text('from_strategy_id').references(() => strategies.id, { onDelete: 'cascade' }).notNull(),
  toStrategyId: text('to_strategy_id').references(() => strategies.id, { onDelete: 'cascade' }).notNull(),

  edgeType: text('edge_type').notNull(),
  metadata: text('metadata').$type<Record<string, unknown>>(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('strategy_edges_from_idx').on(table.fromStrategyId),
  index('strategy_edges_to_idx').on(table.toStrategyId),
]);

/**
 * Strategy Belief Edges - links strategies to beliefs
 */
export const strategyBeliefEdges = sqliteTable('strategy_belief_edges', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  strategyId: text('strategy_id').references(() => strategies.id, { onDelete: 'cascade' }).notNull(),
  beliefId: text('belief_id').references(() => beliefs.id, { onDelete: 'cascade' }).notNull(),

  edgeType: text('edge_type').notNull(),
  metadata: text('metadata').$type<Record<string, unknown>>(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('strategy_belief_edges_strategy_idx').on(table.strategyId),
  index('strategy_belief_edges_belief_idx').on(table.beliefId),
]);

// Belief Types (re-exported for schema)
export type BeliefType = 'decision' | 'preference' | 'failure_cause' | 'constraint' | 'state_change' | 'dispute';
export type BeliefStatus = 'active' | 'superseded' | 'disputed';
export type BeliefEdgeType = 'causes' | 'supports' | 'rejects' | 'supersedes' | 'depends_on';

export type MemoryPlace = typeof memoryPlaces.$inferSelect;
export type NewMemoryPlace = typeof memoryPlaces.$inferInsert;

export type MemoryTag = typeof memoryTags.$inferSelect;
export type NewMemoryTag = typeof memoryTags.$inferInsert;

export type Belief = typeof beliefs.$inferSelect;
export type NewBelief = typeof beliefs.$inferInsert;
export type BeliefMemorySource = typeof beliefMemorySources.$inferSelect;
export type NewBeliefMemorySource = typeof beliefMemorySources.$inferInsert;
export type BeliefEdge = typeof beliefEdges.$inferSelect;
export type NewBeliefEdge = typeof beliefEdges.$inferInsert;

export type Strategy = typeof strategies.$inferSelect;
export type NewStrategy = typeof strategies.$inferInsert;
export type StrategyEdge = typeof strategyEdges.$inferSelect;
export type NewStrategyEdge = typeof strategyEdges.$inferInsert;
export type StrategyBeliefEdge = typeof strategyBeliefEdges.$inferSelect;
export type NewStrategyBeliefEdge = typeof strategyBeliefEdges.$inferInsert;

// Skills System (v2.1.0)
// ============================================================================

/**
 * Skills - reusable SOPs with versions, triggers, steps, and validation
 */
export const skills = sqliteTable('skills', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  skillType: text('skill_type').notNull().default('workflow'),
  status: text('status').notNull().default('draft'),
  visibility: text('visibility').notNull().default('private'),
  triggerConditions: text('trigger_conditions').$type<Record<string, unknown>>(),
  steps: text('steps').$type<Array<{ step: number; action: string; description: string; tool?: string }>>(),
  resources: text('resources').$type<string[]>(),
  validationRules: text('validation_rules').$type<Record<string, unknown>>(),
  successCriteria: text('success_criteria'),
  failureIndicators: text('failure_indicators'),
  tags: text('tags').$type<string[]>(),
  metadata: text('metadata').$type<Record<string, unknown>>(),
  usageCount: integer('usage_count').default(0),
  successCount: integer('success_count').default(0),
  failureCount: integer('failure_count').default(0),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp' }),
  lastFailureAt: integer('last_failure_at', { mode: 'timestamp' }),
  version: integer('version').default(1),
  supersedes: text('supersedes').references((): any => skills.id, { onDelete: 'set null' }),
  agentId: text('agent_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('skills_project_idx').on(table.projectId),
  index('skills_type_idx').on(table.skillType),
  index('skills_status_idx').on(table.status),
  index('skills_visibility_idx').on(table.visibility),
  index('skills_user_idx').on(table.userId),
  index('skills_agent_idx').on(table.agentId),
  index('skills_name_idx').on(table.name),
]);

/**
 * Skill Versions - version history for skills
 */
export const skillVersions = sqliteTable('skill_versions', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  triggerConditions: text('trigger_conditions').$type<Record<string, unknown>>(),
  steps: text('steps').$type<Array<{ step: number; action: string; description: string; tool?: string }>>(),
  resources: text('resources').$type<string[]>(),
  validationRules: text('validation_rules').$type<Record<string, unknown>>(),
  changeSummary: text('change_summary'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('skill_versions_skill_idx').on(table.skillId),
  unique('skill_versions_unique').on(table.skillId, table.version),
]);

/**
 * Skill Assignments - bind skills to agents
 */
export const skillAssignments = sqliteTable('skill_assignments', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  priority: integer('priority').default(0),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  contextFilter: text('context_filter').$type<Record<string, unknown>>(),
  assignedBy: text('assigned_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('skill_assignments_skill_idx').on(table.skillId),
  index('skill_assignments_agent_idx').on(table.agentId),
  unique('skill_assignments_unique').on(table.skillId, table.agentId),
]);

/**
 * Skill Memory Links - connect skills to source memories
 */
export const skillMemoryLinks = sqliteTable('skill_memory_links', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  linkType: text('link_type').notNull().default('derived_from'),
  confidence: real('confidence').default(1.0),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('skill_memory_links_skill_idx').on(table.skillId),
  index('skill_memory_links_memory_idx').on(table.memoryId),
  unique('skill_memory_links_unique').on(table.skillId, table.memoryId),
]);

// Wiki System (v2.1.0) REMOVED in Batch 8 - db-only memory.
// Legacy wiki_pages/wiki_links/wiki_page_versions rows are migrated into
// memories (tagged 'wiki-origin') by db/migrations/wiki-to-memory.ts.

// Agent Loadout & Visibility (v2.1.0)
// ============================================================================

/**
 * Agent Loadouts - bind memory assets to specific agents
 */
export const agentLoadouts = sqliteTable('agent_loadouts', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  agentId: text('agent_id').notNull(),
  assetType: text('asset_type').notNull(),
  assetId: text('asset_id').notNull(),
  priority: integer('priority').default(0),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  injectionMode: text('injection_mode').default('append'),
  metadata: text('metadata').$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('agent_loadouts_agent_idx').on(table.agentId),
  index('agent_loadouts_asset_idx').on(table.assetType, table.assetId),
  unique('agent_loadouts_unique').on(table.agentId, table.assetType, table.assetId),
]);

/**
 * Visibility Rules - fine-grained ACL for assets
 */
export const visibilityRules = sqliteTable('visibility_rules', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  assetType: text('asset_type').notNull(),
  assetId: text('asset_id').notNull(),
  ruleType: text('rule_type').notNull(),
  granteeType: text('grantee_type').notNull(),
  granteeId: text('grantee_id').notNull(),
  permission: text('permission').notNull().default('read'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('visibility_rules_asset_idx').on(table.assetType, table.assetId),
  index('visibility_rules_grantee_idx').on(table.granteeType, table.granteeId),
  unique('visibility_rules_unique').on(table.assetType, table.assetId, table.granteeType, table.granteeId),
]);

// Team Tables
// ============================================================================

/**
 * Teams - organization containers
 */
export const teams = sqliteTable('teams', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('teams_slug_idx').on(table.slug),
]);

/**
 * Team Members - membership join table
 */
export const team_members = sqliteTable('team_members', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'), // 'owner' | 'admin' | 'member'
  joinedAt: integer('joined_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique('team_members_team_user_unique').on(table.teamId, table.userId),
  index('team_members_team_idx').on(table.teamId),
  index('team_members_user_idx').on(table.userId),
]);

/**
 * Team Invitations - pending invitations
 */
export const team_invitations = sqliteTable('team_invitations', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull().default('member'),
  code: text('code').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('team_invitations_team_idx').on(table.teamId),
  index('team_invitations_code_idx').on(table.code),
]);

/**
 * Team Shares - memory sharing between teams
 */
export const team_shares = sqliteTable('team_shares', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  sharedBy: text('shared_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull().default('read'), // 'read' | 'write'
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique('team_shares_memory_team_unique').on(table.memoryId, table.teamId),
  index('team_shares_memory_idx').on(table.memoryId),
  index('team_shares_team_idx').on(table.teamId),
]);

// ============================================================================
// Audit Tables
// ============================================================================

/**
 * Audit Logs - tracks all actions in the system
 */
export const audit_logs = sqliteTable('audit_logs', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  metadata: text('metadata', { mode: 'json' }),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('audit_logs_user_idx').on(table.userId),
  index('audit_logs_action_idx').on(table.action),
  index('audit_logs_entity_idx').on(table.entityType, table.entityId),
  index('audit_logs_team_idx').on(table.teamId),
  index('audit_logs_created_idx').on(table.createdAt),
]);

/**
 * Audit Log Changes - detailed change tracking
 */
export const audit_log_changes = sqliteTable('audit_log_changes', {
  id: text('id').primaryKey().$default(() => crypto.randomUUID()),
  auditLogId: text('audit_log_id').notNull().references(() => audit_logs.id, { onDelete: 'cascade' }),
  field: text('field').notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('audit_log_changes_audit_idx').on(table.auditLogId),
]);

// Team type exports
export type Team = typeof teams.$inferSelect;
export type TeamMember = typeof team_members.$inferSelect;
export type TeamInvitation = typeof team_invitations.$inferSelect;
export type TeamShare = typeof team_shares.$inferSelect;

// Skills type exports
export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type SkillVersion = typeof skillVersions.$inferSelect;
export type NewSkillVersion = typeof skillVersions.$inferInsert;
export type SkillAssignment = typeof skillAssignments.$inferSelect;
export type NewSkillAssignment = typeof skillAssignments.$inferInsert;
export type SkillMemoryLink = typeof skillMemoryLinks.$inferSelect;
export type NewSkillMemoryLink = typeof skillMemoryLinks.$inferInsert;

// Agent Loadout type exports
export type AgentLoadout = typeof agentLoadouts.$inferSelect;
export type NewAgentLoadout = typeof agentLoadouts.$inferInsert;
export type VisibilityRule = typeof visibilityRules.$inferSelect;
export type NewVisibilityRule = typeof visibilityRules.$inferInsert;
