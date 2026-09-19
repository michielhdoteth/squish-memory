/**
 * PostgreSQL Schema for Squish Memory System
 * 
 * Mirrors the SQLite schema (schema-sqlite.ts) 1:1 with PostgreSQL-specific types.
 * Used for team mode with Neon serverless driver.
 */

import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  integer,
  jsonb,
  real,
  boolean,
  index,
  unique,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// =============================================================================
// Enums
// =============================================================================

export const beliefStatusEnum = pgEnum('belief_status', ['active', 'superseded', 'disputed']);
export const beliefTypeEnum = pgEnum('belief_type', ['decision', 'preference', 'failure_cause', 'constraint', 'state_change', 'dispute']);
export const beliefEdgeTypeEnum = pgEnum('belief_edge_type', ['causes', 'supports', 'rejects', 'supersedes', 'depends_on']);
export const teamMemberRoleEnum = pgEnum('team_member_role', ['owner', 'admin', 'member']);
export const teamInvitationStatusEnum = pgEnum('team_invitation_status', ['pending', 'accepted', 'expired']);
export const knowledgeKindEnum = pgEnum('knowledge_kind', ['memory', 'belief', 'strategy']);

// =============================================================================
// Core Tables
// =============================================================================

/**
 * Users - authentication and identity
 */
export const users = pgTable('users', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  email: text('email').unique(),
  name: text('name'),
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('users_email_idx').on(table.email),
]);

/**
 * Projects - memory workspace containers
 */
export const projects = pgTable('projects', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  metadata: jsonb('metadata'),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('projects_slug_idx').on(table.slug),
  index('projects_owner_idx').on(table.ownerId),
]);

/**
 * Memories - atomic units of knowledge
 */
export const memories = pgTable('memories', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  type: text('type').notNull(),
  content: text('content').notNull(),
  embedding: text('embedding'),  // JSON-serialized vector
  confidence: real('confidence').default(1.0),
  source: text('source'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('memories_project_idx').on(table.projectId),
  index('memories_type_idx').on(table.type),
  index('memories_created_idx').on(table.createdAt),
  index('memories_team_idx').on(table.teamId),
]);

/**
 * Memory Versions - edit history for memories
 */
export const memoryVersions = pgTable('memory_versions', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  editedBy: text('edited_by'),
  editedAt: timestamp('edited_at').defaultNow().notNull(),
}, (table) => [
  index('memory_versions_memory_idx').on(table.memoryId),
]);

/**
 * Concepts - extracted semantic units
 */
export const concepts = pgTable('concepts', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  definition: text('definition'),
  embedding: text('embedding'),  // JSON-serialized vector
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('concepts_project_idx').on(table.projectId),
  index('concepts_name_idx').on(table.name),
  uniqueIndex('concepts_project_name_idx').on(table.projectId, table.name),
]);

/**
 * Memory-Concept associations
 */
export const memoryConcepts = pgTable('memory_concepts', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  conceptId: text('concept_id').notNull().references(() => concepts.id, { onDelete: 'cascade' }),
  relevance: real('relevance').default(1.0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('memory_concepts_unique').on(table.memoryId, table.conceptId),
  index('memory_concepts_memory_idx').on(table.memoryId),
  index('memory_concepts_concept_idx').on(table.conceptId),
]);

/**
 * Beliefs - inferences and decisions
 */
export const beliefs = pgTable('beliefs', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  statement: text('statement').notNull(),
  type: beliefTypeEnum('type').notNull().default('decision'),
  status: beliefStatusEnum('status').notNull().default('active'),
  confidence: real('confidence').default(1.0),
  evidence: jsonb('evidence'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('beliefs_project_idx').on(table.projectId),
  index('beliefs_type_idx').on(table.type),
  index('beliefs_status_idx').on(table.status),
]);

/**
 * Belief Memory Sources - which memories support a belief
 */
export const beliefMemorySources = pgTable('belief_memory_sources', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  beliefId: text('belief_id').notNull().references(() => beliefs.id, { onDelete: 'cascade' }),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  weight: real('weight').default(1.0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('belief_memory_sources_unique').on(table.beliefId, table.memoryId),
  index('belief_memory_sources_belief_idx').on(table.beliefId),
  index('belief_memory_sources_memory_idx').on(table.memoryId),
]);

/**
 * Belief Edges - causal/inference relationships
 */
export const beliefEdges = pgTable('belief_edges', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fromBeliefId: text('from_belief_id').notNull().references(() => beliefs.id, { onDelete: 'cascade' }),
  toBeliefId: text('to_belief_id').notNull().references(() => beliefs.id, { onDelete: 'cascade' }),
  type: beliefEdgeTypeEnum('type').notNull(),
  weight: real('weight').default(1.0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('belief_edges_project_idx').on(table.projectId),
  index('belief_edges_from_idx').on(table.fromBeliefId),
  index('belief_edges_to_idx').on(table.toBeliefId),
]);

/**
 * Strategies - execution plans
 */
export const strategies = pgTable('strategies', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type').notNull(),
  status: text('status').notNull().default('draft'),
  confidence: real('confidence').default(1.0),
  evidence: jsonb('evidence'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('strategies_project_idx').on(table.projectId),
  index('strategies_type_idx').on(table.type),
  index('strategies_status_idx').on(table.status),
]);

/**
 * Strategy Edges - step dependencies
 */
export const strategyEdges = pgTable('strategy_edges', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fromStrategyId: text('from_strategy_id').notNull().references(() => strategies.id, { onDelete: 'cascade' }),
  toStrategyId: text('to_strategy_id').notNull().references(() => strategies.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  weight: real('weight').default(1.0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('strategy_edges_project_idx').on(table.projectId),
  index('strategy_edges_from_idx').on(table.fromStrategyId),
  index('strategy_edges_to_idx').on(table.toStrategyId),
]);

/**
 * Strategy-Belief connections
 */
export const strategyBeliefEdges = pgTable('strategy_belief_edges', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  strategyId: text('strategy_id').notNull().references(() => strategies.id, { onDelete: 'cascade' }),
  beliefId: text('belief_id').notNull().references(() => beliefs.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  weight: real('weight').default(1.0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('strategy_belief_edges_project_idx').on(table.projectId),
  index('strategy_belief_edges_strategy_idx').on(table.strategyId),
  index('strategy_belief_edges_belief_idx').on(table.beliefId),
]);

// =============================================================================
// Graph & Context Tables
// =============================================================================

/**
 * Graph Edges - semantic relationships between memories
 */
export const graphEdges = pgTable('graph_edges', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fromMemoryId: text('from_memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  toMemoryId: text('to_memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  weight: real('weight').default(1.0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('graph_edges_project_idx').on(table.projectId),
  index('graph_edges_from_idx').on(table.fromMemoryId),
  index('graph_edges_to_idx').on(table.toMemoryId),
  uniqueIndex('graph_edges_unique').on(table.fromMemoryId, table.toMemoryId, table.type),
]);

/**
 * Contexts - situational metadata
 */
export const contexts = pgTable('contexts', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  data: jsonb('data'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('contexts_project_idx').on(table.projectId),
  index('contexts_name_idx').on(table.name),
]);

/**
 * Memory-Context associations
 */
export const memoryContexts = pgTable('memory_contexts', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  contextId: text('context_id').notNull().references(() => contexts.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('memory_contexts_unique').on(table.memoryId, table.contextId),
  index('memory_contexts_memory_idx').on(table.memoryId),
  index('memory_contexts_context_idx').on(table.contextId),
]);

// =============================================================================
// Tags & Places Tables
// =============================================================================

/**
 * Tags - categorical labels
 */
export const tags = pgTable('tags', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('tags_project_idx').on(table.projectId),
  index('tags_name_idx').on(table.name),
  uniqueIndex('tags_project_name_idx').on(table.projectId, table.name),
]);

/**
 * Memory-Tag associations
 */
export const memoryTags = pgTable('memory_tags', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('memory_tags_unique').on(table.memoryId, table.tagId),
  index('memory_tags_memory_idx').on(table.memoryId),
  index('memory_tags_tag_idx').on(table.tagId),
]);

/**
 * Memory Places - spatial context
 */
export const memoryPlaces = pgTable('memory_places', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  address: text('address'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('memory_places_memory_idx').on(table.memoryId),
]);

// =============================================================================
// Document Tables
// =============================================================================

/**
 * Documents - ingested files
 */
export const documents = pgTable('documents', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  path: text('path'),
  type: text('type'),
  size: integer('size'),
  hash: text('hash'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('documents_project_idx').on(table.projectId),
  index('documents_hash_idx').on(table.hash),
]);

/**
 * Document Chunks - split content for embedding
 */
export const documentChunks = pgTable('document_chunks', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  embedding: text('embedding'),  // JSON-serialized vector
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('document_chunks_document_idx').on(table.documentId),
]);

/**
 * Document Embeddings - vector search metadata
 */
export const documentEmbeddings = pgTable('document_embeddings', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  chunkId: text('chunk_id').references(() => documentChunks.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('document_embeddings_document_idx').on(table.documentId),
  index('document_embeddings_chunk_idx').on(table.chunkId),
]);

// =============================================================================
// Audit & Decay Tables
// =============================================================================

/**
 * Audit Logs - mutation history
 */
export const auditLogs = pgTable('audit_logs', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  memoryId: text('memory_id').references(() => memories.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  details: jsonb('details'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('audit_logs_project_idx').on(table.projectId),
  index('audit_logs_memory_idx').on(table.memoryId),
  index('audit_logs_created_idx').on(table.createdAt),
]);

// =============================================================================
// Knowledge System (v2.0.0) — Unified table replacing memories, beliefs, strategies
// =============================================================================

/**
 * Knowledge - single source of truth for all knowledge items.
 * knowledge_kind discriminates: 'memory' | 'belief' | 'strategy'.
 */
export const knowledge = pgTable('knowledge', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  agentId: text('agent_id'),
  sessionId: text('session_id'),

  // Classification
  knowledgeKind: knowledgeKindEnum('knowledge_kind').notNull(),
  knowledgeType: text('knowledge_type').notNull(),

  // Content
  content: text('content').notNull(),
  summary: text('summary'),

  // Embeddings (multi-model)
  embeddingJson: text('embedding_json'),
  embedding: text('embedding'),
  embeddingModel: text('embedding_model'),
  embeddingDim: integer('embedding_dim'),

  // Confidence & importance
  confidence: real('confidence').default(0.5),
  confidenceLevel: text('confidence_level').default('certain'),
  importanceScore: real('importance_score').default(0.5),
  importanceDecayRate: real('importance_decay_rate').default(30),
  lastImportanceRecalc: timestamp('last_importance_recalc'),

  // Belief-specific
  normalizedKey: text('normalized_key'),
  reason: text('reason'),
  evidenceSummary: text('evidence_summary'),
  evidence: jsonb('evidence'),
  lastConfirmedAt: timestamp('last_confirmed_at'),
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
  lastUsedAt: timestamp('last_used_at'),
  lastSuccessAt: timestamp('last_success_at'),
  lastFailureAt: timestamp('last_failure_at'),

  // Status & lifecycle
  status: text('status').default('active'),
  isActive: boolean('is_active').default(true),
  sector: text('sector').default('general'),
  tier: text('tier').default('episodic'),
  version: integer('version').default(1),

  // Self-referencing relationships
  supersededBy: text('superseded_by'),
  contradictsId: text('contradicts_id'),
  informedById: text('informed_by_id'),

  // Tags & metadata
  tags: text('tags'),
  metadata: jsonb('metadata'),

  // Place routing
  placeId: text('place_id'),
  primaryPlace: text('primary_place'),

  // Privacy & governance
  isPrivate: boolean('is_private').default(false),
  isProtected: boolean('is_protected').default(false),
  isPinned: boolean('is_pinned').default(false),
  isImmutable: boolean('is_immutable').default(false),
  writeScope: text('write_scope'),
  readScope: text('read_scope'),

  // Visibility
  scope: text('scope').default('company'),
  visibilityScope: text('visibility_scope').default('private'),

  // Provenance
  actorUser: text('actor_user'),
  actorAgent: text('actor_agent'),
  agentRole: text('agent_role'),
  triggeredBy: text('triggered_by'),
  captureReason: text('capture_reason'),

  // Temporal facts
  validFrom: timestamp('valid_from'),
  validTo: timestamp('valid_to'),
  recordedAt: timestamp('recorded_at').defaultNow().notNull(),

  // Access tracking
  accessCount: integer('access_count').default(0),
  lastAccessedAt: timestamp('last_accessed_at'),

  // Merge tracking
  isMerged: boolean('is_merged').default(false),
  mergedIntoId: text('merged_into_id'),
  mergedAt: timestamp('merged_at'),

  // Consolidation
  consolidatedFrom: text('consolidated_from'),
  consolidatedAt: timestamp('consolidated_at'),
  isConsolidated: boolean('is_consolidated').default(false),

  // Encryption
  encryptedContent: text('encrypted_content'),
  encryptionNonce: text('encryption_nonce'),
  isEncrypted: boolean('is_encrypted').default(false),

  // Retrieval optimization
  compressionLevel: integer('compression_level'),
  relevanceScore: integer('relevance_score').default(50),
  tokensEstimate: integer('tokens_estimate').default(0),

  // Decay system
  decayRate: integer('decay_rate').default(30),
  coactivationScore: integer('coactivation_score').default(0),
  lastDecayAt: timestamp('last_decay_at').defaultNow(),

  // Layer tracking
  hasL0Abstract: boolean('has_l0_abstract').default(false),
  hasL1Overview: boolean('has_l1_overview').default(false),
  lastLayerUpdate: timestamp('last_layer_update'),

  // Multimodal
  mediaType: text('media_type'),
  mediaPath: text('media_path'),
  mediaMetadata: text('media_metadata'),

  // Organization
  namespaceId: text('namespace_id'),
  namespacePath: text('namespace_path'),

  // Cloud-specific
  employeeId: text('employee_id'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
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
]);

/**
 * Knowledge Edges - universal relationship table (v2.0.0).
 * Replaces: belief_edges, strategy_edges, strategy_belief_edges,
 *           entity_relations, graph_edges.
 */
export const knowledgeEdges = pgTable('knowledge_edges', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  fromId: text('from_id').notNull(),
  fromKind: text('from_kind').notNull(),
  toId: text('to_id').notNull(),
  toKind: text('to_kind').notNull(),
  edgeType: text('edge_type').notNull(),
  weight: real('weight').default(1.0),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('knowledge_edges_from_idx').on(table.fromId, table.fromKind),
  index('knowledge_edges_to_idx').on(table.toId, table.toKind),
  index('knowledge_edges_type_idx').on(table.edgeType),
  uniqueIndex('knowledge_edges_unique').on(table.fromId, table.fromKind, table.toId, table.toKind, table.edgeType),
]);

/**
 * Memory Decay States - forgetting curve tracking
 */
export const memoryDecayStates = pgTable('memory_decay_states', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  stability: real('stability').notNull().default(1.0),
  difficulty: real('difficulty').notNull().default(0.0),
  lastReview: timestamp('last_review'),
  nextReview: timestamp('next_review'),
  reviewCount: integer('review_count').default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('memory_decay_states_unique').on(table.memoryId),
  index('memory_decay_states_next_review_idx').on(table.nextReview),
]);

// =============================================================================
// Skills System (v2.1.0)
// ============================================================================

/**
 * Skills - reusable SOPs with versions, triggers, steps, and validation
 */
export const skills = pgTable('skills', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  skillType: text('skill_type').notNull().default('workflow'),
  status: text('status').notNull().default('draft'),
  visibility: text('visibility').notNull().default('private'),
  triggerConditions: jsonb('trigger_conditions'),
  steps: jsonb('steps'),
  resources: jsonb('resources'),
  validationRules: jsonb('validation_rules'),
  successCriteria: text('success_criteria'),
  failureIndicators: text('failure_indicators'),
  tags: jsonb('tags'),
  metadata: jsonb('metadata'),
  usageCount: integer('usage_count').default(0),
  successCount: integer('success_count').default(0),
  failureCount: integer('failure_count').default(0),
  lastUsedAt: timestamp('last_used_at'),
  lastSuccessAt: timestamp('last_success_at'),
  lastFailureAt: timestamp('last_failure_at'),
  version: integer('version').default(1),
  supersedes: text('supersedes').references((): any => skills.id, { onDelete: 'set null' }),
  agentId: text('agent_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
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
export const skillVersions = pgTable('skill_versions', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  triggerConditions: jsonb('trigger_conditions'),
  steps: jsonb('steps'),
  resources: jsonb('resources'),
  validationRules: jsonb('validation_rules'),
  changeSummary: text('change_summary'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('skill_versions_skill_idx').on(table.skillId),
  uniqueIndex('skill_versions_unique').on(table.skillId, table.version),
]);

/**
 * Skill Assignments - bind skills to agents
 */
export const skillAssignments = pgTable('skill_assignments', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  priority: integer('priority').default(0),
  enabled: boolean('enabled').default(true),
  contextFilter: jsonb('context_filter'),
  assignedBy: text('assigned_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('skill_assignments_skill_idx').on(table.skillId),
  index('skill_assignments_agent_idx').on(table.agentId),
  uniqueIndex('skill_assignments_unique').on(table.skillId, table.agentId),
]);

/**
 * Skill Memory Links - connect skills to source memories
 */
export const skillMemoryLinks = pgTable('skill_memory_links', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  linkType: text('link_type').notNull().default('derived_from'),
  confidence: real('confidence').default(1.0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('skill_memory_links_skill_idx').on(table.skillId),
  index('skill_memory_links_memory_idx').on(table.memoryId),
  uniqueIndex('skill_memory_links_unique').on(table.skillId, table.memoryId),
]);

// Agent Loadout & Visibility (v2.1.0)
// ============================================================================

/**
 * Agent Loadouts - bind memory assets to specific agents
 */
export const agentLoadouts = pgTable('agent_loadouts', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  agentId: text('agent_id').notNull(),
  assetType: text('asset_type').notNull(),
  assetId: text('asset_id').notNull(),
  priority: integer('priority').default(0),
  enabled: boolean('enabled').default(true),
  injectionMode: text('injection_mode').default('append'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('agent_loadouts_agent_idx').on(table.agentId),
  index('agent_loadouts_asset_idx').on(table.assetType, table.assetId),
  uniqueIndex('agent_loadouts_unique').on(table.agentId, table.assetType, table.assetId),
]);

/**
 * Visibility Rules - fine-grained ACL for assets
 */
export const visibilityRules = pgTable('visibility_rules', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  assetType: text('asset_type').notNull(),
  assetId: text('asset_id').notNull(),
  ruleType: text('rule_type').notNull(),
  granteeType: text('grantee_type').notNull(),
  granteeId: text('grantee_id').notNull(),
  permission: text('permission').notNull().default('read'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('visibility_rules_asset_idx').on(table.assetType, table.assetId),
  index('visibility_rules_grantee_idx').on(table.granteeType, table.granteeId),
  uniqueIndex('visibility_rules_unique').on(table.assetType, table.assetId, table.granteeType, table.granteeId),
]);

// Team Tables
// ============================================================================

/**
 * Teams - organization containers
 */
export const teams = pgTable('teams', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('teams_slug_idx').on(table.slug),
]);

/**
 * Team Members - membership join table
 */
export const team_members = pgTable('team_members', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: teamMemberRoleEnum('role').notNull().default('member'),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('team_members_team_user_unique').on(table.teamId, table.userId),
  index('team_members_team_idx').on(table.teamId),
  index('team_members_user_idx').on(table.userId),
]);

/**
 * Team Invitations - pending invitations
 */
export const team_invitations = pgTable('team_invitations', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: teamMemberRoleEnum('role').notNull().default('member'),
  code: text('code').notNull().unique(),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('team_invitations_team_idx').on(table.teamId),
  index('team_invitations_code_idx').on(table.code),
]);

/**
 * Team Shares - memory sharing between teams
 */
export const team_shares = pgTable('team_shares', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  sharedBy: text('shared_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull().default('read'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('team_shares_memory_team_unique').on(table.memoryId, table.teamId),
  index('team_shares_memory_idx').on(table.memoryId),
  index('team_shares_team_idx').on(table.teamId),
]);

// =============================================================================
// Scheduled Tasks Tables
// =============================================================================

/**
 * Scheduled Tasks - background job definitions
 */
export const scheduledTasks = pgTable('scheduled_tasks', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  schedule: text('schedule').notNull(),
  enabled: boolean('enabled').default(true),
  config: jsonb('config'),
  lastRun: timestamp('last_run'),
  nextRun: timestamp('next_run'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('scheduled_tasks_project_idx').on(table.projectId),
  index('scheduled_tasks_next_run_idx').on(table.nextRun),
]);

/**
 * Task Run Logs - execution history
 */
export const taskRunLogs = pgTable('task_run_logs', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  taskId: text('task_id').notNull().references(() => scheduledTasks.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
  duration: integer('duration'),
  error: text('error'),
  details: jsonb('details'),
}, (table) => [
  index('task_run_logs_task_idx').on(table.taskId),
  index('task_run_logs_started_idx').on(table.startedAt),
]);

/**
 * Cron Jobs - recurring task definitions
 */
export const cronJobs = pgTable('cron_jobs', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  schedule: text('schedule').notNull(),
  command: text('command').notNull(),
  enabled: boolean('enabled').default(true),
  lastRun: timestamp('last_run'),
  nextRun: timestamp('next_run'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('cron_jobs_project_idx').on(table.projectId),
  index('cron_jobs_next_run_idx').on(table.nextRun),
]);

// =============================================================================
// Project Members Table
// =============================================================================

/**
 * Project Members - project-level access control
 */
export const projectMembers = pgTable('project_members', {
  id: text('id').default(sql`gen_random_uuid()`).primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('viewer'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('project_members_unique').on(table.projectId, table.userId),
  index('project_members_project_idx').on(table.projectId),
  index('project_members_user_idx').on(table.userId),
]);

// =============================================================================
// Type Exports
// =============================================================================

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

// Knowledge System type exports
export type Knowledge = typeof knowledge.$inferSelect;
export type NewKnowledge = typeof knowledge.$inferInsert;
export type KnowledgeEdge = typeof knowledgeEdges.$inferSelect;
export type NewKnowledgeEdge = typeof knowledgeEdges.$inferInsert;

// Agent Loadout type exports
export type AgentLoadout = typeof agentLoadouts.$inferSelect;
export type NewAgentLoadout = typeof agentLoadouts.$inferInsert;
export type VisibilityRule = typeof visibilityRules.$inferSelect;
export type NewVisibilityRule = typeof visibilityRules.$inferInsert;
