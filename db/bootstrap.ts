import type { Database } from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { logger } from '../core/logger.js';
import { getDataDir } from '../config.js';
import { runAllMigrations } from './migrations/index.js';
import { runWikiToMemoryMigration } from './migrations/wiki-to-memory.js';

const sqliteSchemaSql = `
PRAGMA foreign_keys = ON;

-- Schema version tracking table (v1.2.0+)
CREATE TABLE IF NOT EXISTS _schema_versions (
  version TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

-- Agent preferences table (v1.2.0+) - stores accumulated agent preferences from learnings
CREATE TABLE IF NOT EXISTS agent_preferences (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source_memory_id TEXT,
  confidence REAL DEFAULT 0.5,
  usage_count INTEGER DEFAULT 1,
  last_updated INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  UNIQUE(project_id, key)
);

CREATE INDEX IF NOT EXISTS agent_preferences_project_idx ON agent_preferences(project_id);
CREATE INDEX IF NOT EXISTS agent_preferences_key_idx ON agent_preferences(key);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  name TEXT,
  email TEXT,
  preferences TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_path_idx ON projects(path);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  embedding_json TEXT,
  embedding BLOB,
  embedding_blob BLOB,
  embedding_model TEXT,
  embedding_dim INTEGER,
  source TEXT,
  confidence INTEGER DEFAULT 50,
  confidence_level TEXT DEFAULT 'speculative',
  tags TEXT,
  metadata TEXT,
  is_private INTEGER DEFAULT 0,
  has_secrets INTEGER DEFAULT 0,
  relevance_score INTEGER DEFAULT 50,
  is_active INTEGER DEFAULT 1,
  expires_at INTEGER,
  access_count INTEGER DEFAULT 0,
  last_accessed_at INTEGER,
  is_merged INTEGER DEFAULT 0,
  merged_into_id TEXT,
  merged_at INTEGER,
  is_canonical INTEGER DEFAULT 0,
  merge_source_ids TEXT,
  is_mergeable INTEGER DEFAULT 1,
  merge_version INTEGER DEFAULT 1,
  namespace_id TEXT REFERENCES namespaces(id) ON DELETE SET NULL,
  namespace_path TEXT,
  has_l0_abstract INTEGER DEFAULT 0,
  has_l1_overview INTEGER DEFAULT 0,
  last_layer_update INTEGER,
  importance_score INTEGER DEFAULT 50,
  importance_decay_rate INTEGER DEFAULT 30,
  last_importance_recalc INTEGER,
  retrieval_priority INTEGER DEFAULT 50,
  tokens_estimate INTEGER DEFAULT 0,
  consolidated_into TEXT,
  consolidated_at INTEGER,
  is_consolidated INTEGER DEFAULT 0,
  sector TEXT DEFAULT 'episodic',
  tier TEXT DEFAULT 'working',
  status TEXT DEFAULT 'active',
  encrypted_content TEXT,
  encryption_nonce TEXT,
  is_encrypted INTEGER DEFAULT 0,
  context_status TEXT DEFAULT 'out-of-context',
  decay_rate INTEGER DEFAULT 30,
  coactivation_score INTEGER DEFAULT 0,
  last_decay_at INTEGER DEFAULT (strftime('%s','now')),
  agent_id TEXT,
  agent_role TEXT,
  visibility_scope TEXT DEFAULT 'private',
  is_protected INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  is_immutable INTEGER DEFAULT 0,
  write_scope TEXT,
  read_scope TEXT,
  triggered_by TEXT,
  capture_reason TEXT,
  last_used_at INTEGER,
  usage_count INTEGER DEFAULT 0,
  valid_from INTEGER,
  valid_to INTEGER,
  recorded_at INTEGER DEFAULT (strftime('%s','now')),
  superseded_by TEXT,
  version INTEGER DEFAULT 1,
  place_id TEXT,
  place_sort_order INTEGER DEFAULT 0,
  -- v2.0.0: Multimodal ingestion
  media_type TEXT,
  media_path TEXT,
  media_metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS memories_project_idx ON memories(project_id);
CREATE INDEX IF NOT EXISTS memories_type_idx ON memories(type);
CREATE INDEX IF NOT EXISTS memories_created_idx ON memories(created_at);
CREATE INDEX IF NOT EXISTS memories_tags_idx ON memories(tags);

CREATE TABLE IF NOT EXISTS memory_associations (
  id TEXT PRIMARY KEY,
  from_memory_id TEXT NOT NULL,
  to_memory_id TEXT NOT NULL,
  association_type TEXT NOT NULL,
  weight REAL DEFAULT 1,
  coactivation_count INTEGER DEFAULT 1,
  metadata TEXT,
  last_coactivated_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  UNIQUE(from_memory_id, to_memory_id)
);

-- Composite index for graph traversal (v1.1.0)
CREATE INDEX IF NOT EXISTS associations_graph_traversal_idx ON memory_associations(from_memory_id, to_memory_id, weight, association_type);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  session_id TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  message_count INTEGER DEFAULT 0,
  token_count INTEGER DEFAULT 0,
  started_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  ended_at INTEGER,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations(project_id);
CREATE INDEX IF NOT EXISTS conversations_session_idx ON conversations(session_id);
CREATE INDEX IF NOT EXISTS conversations_started_idx ON conversations(started_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding_json TEXT,
  token_count INTEGER,
  tool_calls TEXT,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS messages_role_idx ON messages(role);
CREATE INDEX IF NOT EXISTS messages_created_idx ON messages(created_at);

-- Learnings table (renamed from observations)
CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  summary TEXT NOT NULL,
  details TEXT,
  embedding_json TEXT,
  embedding BLOB,
  memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
  folder_path TEXT,
  project_path TEXT,
  is_private INTEGER DEFAULT 0,
  has_secrets INTEGER DEFAULT 0,
  relevance_score INTEGER DEFAULT 50,
  category TEXT,
  importance INTEGER DEFAULT 50,
  confidence INTEGER DEFAULT 50,
  metadata TEXT,
  is_imported INTEGER DEFAULT 0,
  -- UAM: Agent integration columns
  agent_id TEXT,
  tool_name TEXT,
  session_id TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS learnings_project_idx ON learnings(project_id);
CREATE INDEX IF NOT EXISTS learnings_type_idx ON learnings(type);
CREATE INDEX IF NOT EXISTS learnings_action_idx ON learnings(action);
CREATE INDEX IF NOT EXISTS learnings_created_idx ON learnings(created_at);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  embedding_json TEXT,
  properties TEXT,
  mention_count INTEGER DEFAULT 0,
  last_mentioned_at INTEGER,
  aliases TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS entities_project_idx ON entities(project_id);
CREATE INDEX IF NOT EXISTS entities_type_idx ON entities(type);
CREATE INDEX IF NOT EXISTS entities_name_idx ON entities(name);

CREATE TABLE IF NOT EXISTS entity_relations (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  weight INTEGER DEFAULT 1,
  properties TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS relations_from_idx ON entity_relations(from_entity_id);
CREATE INDEX IF NOT EXISTS relations_to_idx ON entity_relations(to_entity_id);
CREATE INDEX IF NOT EXISTS relations_type_idx ON entity_relations(type);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  summary,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags, summary)
  VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
  VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
  VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
  INSERT INTO memories_fts(rowid, content, tags, summary)
  VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
END;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content)
  VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content)
  VALUES (new.rowid, new.content);
END;

CREATE TABLE IF NOT EXISTS core_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  section TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER DEFAULT 0 NOT NULL,
  tokens_estimate INTEGER DEFAULT 0 NOT NULL,
  version INTEGER DEFAULT 1 NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS core_memory_project_idx ON core_memory(project_id);
CREATE INDEX IF NOT EXISTS core_memory_user_idx ON core_memory(user_id);
CREATE INDEX IF NOT EXISTS core_memory_section_idx ON core_memory(section);

CREATE TABLE IF NOT EXISTS context_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  loaded_memory_ids TEXT,
  token_budget INTEGER DEFAULT 8000 NOT NULL,
  tokens_used INTEGER DEFAULT 0 NOT NULL,
  core_memory_tokens INTEGER DEFAULT 0 NOT NULL,
  loaded_memories_tokens INTEGER DEFAULT 0 NOT NULL,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS context_sessions_session_idx ON context_sessions(session_id);
CREATE INDEX IF NOT EXISTS context_sessions_project_idx ON context_sessions(project_id);
CREATE INDEX IF NOT EXISTS context_sessions_created_idx ON context_sessions(created_at);

-- v0.8.0: Memory Merge Tables
CREATE TABLE IF NOT EXISTS memory_merge_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_memory_ids TEXT NOT NULL,
  proposed_content TEXT NOT NULL,
  proposed_summary TEXT,
  proposed_tags TEXT,
  proposed_metadata TEXT,
  detection_method TEXT NOT NULL,
  similarity_score TEXT NOT NULL,
  confidence_level TEXT NOT NULL,
  merge_reason TEXT NOT NULL,
  conflict_warnings TEXT,
  status TEXT DEFAULT 'pending' NOT NULL,
  reviewed_at INTEGER,
  review_notes TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS memory_merge_proposals_project_status_idx ON memory_merge_proposals(project_id, status);
CREATE INDEX IF NOT EXISTS memory_merge_proposals_created_at_idx ON memory_merge_proposals(created_at);

CREATE TABLE IF NOT EXISTS memory_merge_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  proposal_id TEXT REFERENCES memory_merge_proposals(id) ON DELETE SET NULL,
  source_memory_ids TEXT NOT NULL,
  canonical_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_memories_snapshot TEXT NOT NULL,
  merge_strategy TEXT NOT NULL,
  tokens_saved INTEGER,
  is_reversed INTEGER DEFAULT 0,
  reversed_at INTEGER,
  reversed_by TEXT,
  merged_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_hash_cache (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  simhash TEXT,
  minhash TEXT,
  content_hash TEXT NOT NULL,
  last_updated INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_hash_cache_project_id_idx ON memory_hash_cache(project_id);
CREATE INDEX IF NOT EXISTS memory_hash_cache_simhash_idx ON memory_hash_cache(simhash);

-- Batch 7: parsed agent-session cache (mtime-invalidated read-through cache
-- for harness session stores: claude-code JSONL, codex rollouts, gemini chats).
CREATE TABLE IF NOT EXISTS agent_session_cache (
  cache_key TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_session_cache_agent_idx ON agent_session_cache(agent);
CREATE UNIQUE INDEX IF NOT EXISTS agent_session_cache_agent_session_idx ON agent_session_cache(agent, session_id);

-- Namespaces table (v1.0.x) - Hierarchical organization
CREATE TABLE IF NOT EXISTS namespaces (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT,
  description TEXT,
  parent_id TEXT REFERENCES namespaces(id) ON DELETE SET NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS namespaces_project_idx ON namespaces(project_id);
CREATE INDEX IF NOT EXISTS namespaces_parent_idx ON namespaces(parent_id);

-- Maintenance jobs table (v1.0.x) - Cron scheduler
CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL,
  cron_expression TEXT,
  enabled INTEGER DEFAULT 1 NOT NULL,
  last_run_at INTEGER,
  last_run_duration INTEGER,
  last_run_status TEXT,
  last_run_error TEXT,
  total_runs INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  job_config TEXT,
  next_run_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS maintenance_jobs_name_idx ON maintenance_jobs(job_name);
CREATE INDEX IF NOT EXISTS maintenance_jobs_next_run_idx ON maintenance_jobs(next_run_at);
CREATE INDEX IF NOT EXISTS maintenance_jobs_type_idx ON maintenance_jobs(job_type);
CREATE INDEX IF NOT EXISTS maintenance_jobs_enabled_idx ON maintenance_jobs(enabled);

CREATE TABLE IF NOT EXISTS maintenance_job_history (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES maintenance_jobs(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration INTEGER,
  status TEXT NOT NULL DEFAULT 'success',
  error TEXT,
  records_processed INTEGER DEFAULT 0,
  result_summary TEXT
);
CREATE INDEX IF NOT EXISTS maintenance_job_history_job_idx ON maintenance_job_history(job_id);
CREATE INDEX IF NOT EXISTS maintenance_job_history_started_idx ON maintenance_job_history(started_at);
CREATE INDEX IF NOT EXISTS maintenance_job_history_status_idx ON maintenance_job_history(status);

-- Places table (v1.1.5) - Spatial memory organization
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  place_type TEXT NOT NULL,
  parent_id TEXT REFERENCES places(id) ON DELETE SET NULL,
  sort_order INTEGER DEFAULT 0,
  position_x INTEGER DEFAULT 0,
  position_y INTEGER DEFAULT 0,
  description TEXT,
  purpose TEXT,
  memory_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS places_project_idx ON places(project_id);
CREATE INDEX IF NOT EXISTS places_type_idx ON places(place_type);
CREATE INDEX IF NOT EXISTS places_parent_idx ON places(parent_id);
CREATE INDEX IF NOT EXISTS places_sort_order_idx ON places(project_id, sort_order);

-- Memory Tags (v1.5.0: Tag-aware retrieval)
CREATE TABLE IF NOT EXISTS memory_tags (
  id TEXT PRIMARY KEY,
  memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE NOT NULL,
  tag TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'heuristic',
  confidence REAL,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_tags_tag_idx ON memory_tags(tag);
CREATE INDEX IF NOT EXISTS memory_tags_memory_idx ON memory_tags(memory_id);
CREATE INDEX IF NOT EXISTS memory_tags_tag_memory_idx ON memory_tags(tag, memory_id);
CREATE UNIQUE INDEX IF NOT EXISTS memory_tags_unique ON memory_tags(memory_id, tag);

-- Place auto-assignment rules
CREATE TABLE IF NOT EXISTS place_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  place_type TEXT NOT NULL,
  match_tool TEXT,
  match_keyword TEXT,
  match_tag TEXT,
  match_memory_type TEXT,
  priority INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS place_rules_project_idx ON place_rules(project_id);
CREATE INDEX IF NOT EXISTS place_rules_type_idx ON place_rules(place_type);

-- ═══════════════════════════════════════════════════════════════════════════════
-- UNIFIED KNOWLEDGE TABLE (v2.0.0)
-- Replaces separate memories, beliefs, and strategies tables.
-- Fields are nullable based on knowledge_kind.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  agent_id TEXT,
  session_id TEXT,

  knowledge_kind TEXT NOT NULL,
  knowledge_type TEXT NOT NULL,

  content TEXT NOT NULL,
  summary TEXT,

  embedding_json TEXT,
  embedding BLOB,
  embedding_blob BLOB,
  embedding_model TEXT,
  embedding_dim INTEGER,

  confidence REAL DEFAULT 0.5,
  confidence_level TEXT DEFAULT 'certain',
  importance_score REAL DEFAULT 0.5,
  importance_decay_rate REAL DEFAULT 30,
  last_importance_recalc INTEGER,

  normalized_key TEXT,
  reason TEXT,
  evidence_summary TEXT,
  evidence TEXT,
  last_confirmed_at INTEGER,
  source_count INTEGER DEFAULT 1,

  title TEXT,
  description TEXT,
  steps TEXT,
  success_criteria TEXT,
  failure_indicators TEXT,
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  last_used_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,

  status TEXT DEFAULT 'active',
  is_active INTEGER DEFAULT 1,
  sector TEXT DEFAULT 'general',
  tier TEXT DEFAULT 'episodic',
  version INTEGER DEFAULT 1,

  superseded_by TEXT,
  contradicts_id TEXT,
  informed_by_id TEXT,

  tags TEXT,
  metadata TEXT,

  place_id TEXT,
  primary_place TEXT,

  is_private INTEGER DEFAULT 0,
  is_protected INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  is_immutable INTEGER DEFAULT 0,
  write_scope TEXT,
  read_scope TEXT,

  scope TEXT DEFAULT 'company',
  visibility_scope TEXT DEFAULT 'private',

  actor_user TEXT,
  actor_agent TEXT,
  agent_role TEXT,
  triggered_by TEXT,
  capture_reason TEXT,

  valid_from INTEGER,
  valid_to INTEGER,
  recorded_at INTEGER DEFAULT (strftime('%s','now')),

  access_count INTEGER DEFAULT 0,
  last_accessed_at INTEGER,

  is_merged INTEGER DEFAULT 0,
  merged_into_id TEXT,
  merged_at INTEGER,

  consolidated_from TEXT,
  consolidated_at INTEGER,
  is_consolidated INTEGER DEFAULT 0,

  encrypted_content TEXT,
  encryption_nonce TEXT,
  is_encrypted INTEGER DEFAULT 0,

  compression_level INTEGER,
  relevance_score INTEGER DEFAULT 50,
  tokens_estimate INTEGER DEFAULT 0,

  decay_rate INTEGER DEFAULT 30,
  coactivation_score INTEGER DEFAULT 0,
  last_decay_at INTEGER DEFAULT (strftime('%s','now')),

  has_l0_abstract INTEGER DEFAULT 0,
  has_l1_overview INTEGER DEFAULT 0,
  last_layer_update INTEGER,

  media_type TEXT,
  media_path TEXT,
  media_metadata TEXT,

  namespace_id TEXT,
  namespace_path TEXT,

  employee_id TEXT,

  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

-- Knowledge table indexes
CREATE INDEX IF NOT EXISTS knowledge_project_idx ON knowledge(project_id);
CREATE INDEX IF NOT EXISTS knowledge_kind_idx ON knowledge(knowledge_kind);
CREATE INDEX IF NOT EXISTS knowledge_type_idx ON knowledge(knowledge_type);
CREATE INDEX IF NOT EXISTS knowledge_status_idx ON knowledge(status);
CREATE INDEX IF NOT EXISTS knowledge_session_idx ON knowledge(session_id);
CREATE INDEX IF NOT EXISTS knowledge_user_idx ON knowledge(user_id);
CREATE INDEX IF NOT EXISTS knowledge_agent_idx ON knowledge(agent_id);
CREATE INDEX IF NOT EXISTS knowledge_confidence_idx ON knowledge(confidence);
CREATE INDEX IF NOT EXISTS knowledge_active_idx ON knowledge(is_active);
CREATE INDEX IF NOT EXISTS knowledge_created_idx ON knowledge(created_at);
CREATE INDEX IF NOT EXISTS knowledge_sector_idx ON knowledge(sector);
CREATE INDEX IF NOT EXISTS knowledge_tier_idx ON knowledge(tier);
CREATE INDEX IF NOT EXISTS knowledge_project_kind_idx ON knowledge(project_id, knowledge_kind);
CREATE INDEX IF NOT EXISTS knowledge_project_status_idx ON knowledge(project_id, status);

-- Knowledge FTS (full-text search)
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  content,
  tags,
  summary,
  title,
  description,
  content='knowledge',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, content, tags, summary, title, description)
  VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''), COALESCE(new.title, ''), COALESCE(new.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags, summary, title, description)
  VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''), COALESCE(old.title, ''), COALESCE(old.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags, summary, title, description)
  VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''), COALESCE(old.title, ''), COALESCE(old.description, ''));
  INSERT INTO knowledge_fts(rowid, content, tags, summary, title, description)
  VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''), COALESCE(new.title, ''), COALESCE(new.description, ''));
END;

-- ═══════════════════════════════════════════════════════════════════════════════
-- UNIVERSAL EDGE TABLE (v2.0.0)
-- Replaces: belief_edges, strategy_edges, strategy_belief_edges,
--           entity_relations, memory_places
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS knowledge_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  from_kind TEXT NOT NULL,   -- 'knowledge' | 'entity' | 'place'
  to_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,     -- 'knowledge' | 'entity' | 'place'
  edge_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  metadata TEXT,             -- JSON object
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);

-- Knowledge edges indexes
CREATE INDEX IF NOT EXISTS knowledge_edges_from_idx ON knowledge_edges(from_id, from_kind);
CREATE INDEX IF NOT EXISTS knowledge_edges_to_idx ON knowledge_edges(to_id, to_kind);
CREATE INDEX IF NOT EXISTS knowledge_edges_type_idx ON knowledge_edges(edge_type);
CREATE INDEX IF NOT EXISTS knowledge_edges_from_kind_idx ON knowledge_edges(from_kind);
CREATE INDEX IF NOT EXISTS knowledge_edges_to_kind_idx ON knowledge_edges(to_kind);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_edges_unique ON knowledge_edges(from_id, from_kind, to_id, to_kind, edge_type);

-- session_summaries table
CREATE TABLE IF NOT EXISTS session_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  summary_type TEXT NOT NULL,
  content TEXT NOT NULL,
  compressed_from INTEGER,
  tokens_saved INTEGER,
  embedding BLOB,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS session_summaries_conversation_idx ON session_summaries(conversation_id);
CREATE INDEX IF NOT EXISTS session_summaries_project_idx ON session_summaries(project_id);
CREATE INDEX IF NOT EXISTS session_summaries_type_idx ON session_summaries(summary_type);
CREATE INDEX IF NOT EXISTS session_summaries_created_idx ON session_summaries(created_at);

-- ═══════════════════════════════════════════════════════════════════════════════
-- DEPRECATED TABLES (superseded by knowledge + knowledge_edges above)
-- These are kept temporarily for foreign key compatibility and data migration.
-- Drop once all code paths use the knowledge tables exclusively.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Skills System (v2.1.0) - Reusable SOPs with versions, triggers, steps
-- ============================================================================

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  skill_type TEXT NOT NULL DEFAULT 'workflow',
  status TEXT NOT NULL DEFAULT 'draft',
  visibility TEXT NOT NULL DEFAULT 'private',
  trigger_conditions TEXT,
  steps TEXT,
  resources TEXT,
  validation_rules TEXT,
  success_criteria TEXT,
  failure_indicators TEXT,
  tags TEXT,
  metadata TEXT,
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  last_used_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  version INTEGER DEFAULT 1,
  supersedes TEXT REFERENCES skills(id) ON DELETE SET NULL,
  agent_id TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS skills_project_idx ON skills(project_id);
CREATE INDEX IF NOT EXISTS skills_type_idx ON skills(skill_type);
CREATE INDEX IF NOT EXISTS skills_status_idx ON skills(status);
CREATE INDEX IF NOT EXISTS skills_visibility_idx ON skills(visibility);
CREATE INDEX IF NOT EXISTS skills_user_idx ON skills(user_id);
CREATE INDEX IF NOT EXISTS skills_agent_idx ON skills(agent_id);
CREATE INDEX IF NOT EXISTS skills_name_idx ON skills(name);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  trigger_conditions TEXT,
  steps TEXT,
  resources TEXT,
  validation_rules TEXT,
  change_summary TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  UNIQUE(skill_id, version)
);
CREATE INDEX IF NOT EXISTS skill_versions_skill_idx ON skill_versions(skill_id);

CREATE TABLE IF NOT EXISTS skill_assignments (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  context_filter TEXT,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  UNIQUE(skill_id, agent_id)
);
CREATE INDEX IF NOT EXISTS skill_assignments_skill_idx ON skill_assignments(skill_id);
CREATE INDEX IF NOT EXISTS skill_assignments_agent_idx ON skill_assignments(agent_id);

CREATE TABLE IF NOT EXISTS skill_memory_links (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'derived_from',
  confidence REAL DEFAULT 1.0,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  UNIQUE(skill_id, memory_id)
);
CREATE INDEX IF NOT EXISTS skill_memory_links_skill_idx ON skill_memory_links(skill_id);
CREATE INDEX IF NOT EXISTS skill_memory_links_memory_idx ON skill_memory_links(memory_id);

-- Agent Loadout (v2.1.0) - Bind memory assets to agents
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_loadouts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  injection_mode TEXT DEFAULT 'append',
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  UNIQUE(agent_id, asset_type, asset_id)
);
CREATE INDEX IF NOT EXISTS agent_loadouts_agent_idx ON agent_loadouts(agent_id);
CREATE INDEX IF NOT EXISTS agent_loadouts_asset_idx ON agent_loadouts(asset_type, asset_id);

-- Visibility ACL (v2.1.0) - Fine-grained access control
-- ============================================================================

CREATE TABLE IF NOT EXISTS visibility_rules (
  id TEXT PRIMARY KEY,
  asset_type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  grantee_type TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read',
  created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
  UNIQUE(asset_type, asset_id, grantee_type, grantee_id)
);
CREATE INDEX IF NOT EXISTS visibility_rules_asset_idx ON visibility_rules(asset_type, asset_id);
CREATE INDEX IF NOT EXISTS visibility_rules_grantee_idx ON visibility_rules(grantee_type, grantee_id);

`;



/**
 * Ensure the data directory exists (.squish folder in project root)
 */
export async function ensureDataDirectory(): Promise<void> {
  try {
    const dataDir = getDataDir();
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
      logger.info(`Created data directory at: ${dataDir}`);
    }
  } catch (error) {
    logger.error('Failed to create data directory', error);
    throw new Error(`Failed to initialize data directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function ensureSqliteSchema(sqlite: Database): Promise<void> {
  // Run schema creation FIRST (creates tables with latest schema).
  // Older installs may fail partway through when later indexes/triggers refer
  // to columns that migrations have not added yet, so tolerate that first pass.
  execSqliteSchema(sqlite, { tolerant: true });
  
  // Initialize schema version tracking
  await initializeSchemaVersionTable(sqlite);
  
  // Run migrations AFTER (for existing databases that need column additions)
  await runSqliteMigrations(sqlite);

  // Replay the full schema after migrations so deferred indexes/triggers land.
  execSqliteSchema(sqlite, { tolerant: false });

  // Batch 8: one-time wiki_pages -> memories migration (marker-gated,
  // SQUISH_WIKI_MIGRATE_DRY_RUN=true previews). Legacy wiki tables are
  // dropped on apply - memory rows tagged 'wiki-origin' carry the data.
  try {
    runWikiToMemoryMigration(sqlite);
  } catch (error) {
    logger.error('[wiki-migration] Failed:', error instanceof Error ? error.message : String(error));
  }
}

// Schema versions for tracking
const SCHEMA_VERSIONS = [
  { version: '1.2.0-base', description: 'Initial v1.2.0 schema with schema_versions table' },
  { version: '1.2.0-place-sort', description: 'Add place_sort_order column to places' },
  { version: '1.2.0-agent-prefs', description: 'Add agent_preferences table for agent evolution' },
  { version: '2.1.0-skills', description: 'Add skills, skill_versions, skill_assignments, skill_memory_links tables' },
  // '2.1.0-wiki' retired in Batch 8: wiki subsystem removed (db-only memory).
  // The one-time wiki->memory migration records marker '2.2.0-wiki-to-memory'.
  { version: '2.1.0-loadout', description: 'Add agent_loadouts, visibility_rules tables' },
];

async function initializeSchemaVersionTable(sqlite: Database): Promise<void> {
  // Get existing versions
  const existingVersions = sqlite.prepare("SELECT version FROM _schema_versions").all() as Array<{version: string}>;
  const appliedVersions = new Set(existingVersions.map(v => v.version));
  
  // Insert any missing versions
  for (const { version, description } of SCHEMA_VERSIONS) {
    if (!appliedVersions.has(version)) {
      try {
        sqlite.prepare("INSERT INTO _schema_versions (version, description) VALUES (?, ?)").run(version, description);
        logger.info(`Schema version ${version} recorded`);
      } catch (error) {
        // Ignore duplicate errors
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes('UNIQUE constraint failed')) {
          logger.warn(`Could not record schema version ${version}: ${msg}`);
        }
      }
    }
  }
}

export async function getSchemaVersion(sqlite: Database): Promise<string | null> {
  const result = sqlite.prepare("SELECT version FROM _schema_versions ORDER BY applied_at DESC LIMIT 1").get() as {version: string} | undefined;
  return result?.version || null;
}

export async function runMigrationsForVersion(sqlite: Database, targetVersion: string): Promise<void> {
  const currentVersion = await getSchemaVersion(sqlite);
  logger.info(`Current schema version: ${currentVersion}, target: ${targetVersion}`);
  
  // Run ensureSqliteSchema which handles all migrations
  await runSqliteMigrations(sqlite);
}

async function runSqliteMigrations(sqlite: Database): Promise<void> {
  // All migrations are in separate files - just run them all
  await runAllMigrations(sqlite);
}

function execSqliteSchema(
  sqlite: Database,
  options: { tolerant: boolean },
): void {
  try {
    sqlite.exec(sqliteSchemaSql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isRecoverable =
      message.includes('no such column') ||
      message.includes('has no column named');

    if (options.tolerant && isRecoverable) {
      logger.debug(`Deferred schema statement until after migrations: ${message}`);
      return;
    }

    throw error;
  }
}
