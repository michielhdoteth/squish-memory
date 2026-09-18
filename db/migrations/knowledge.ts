/**
 * Knowledge System migration (v2.0.0)
 *
 * Creates the unified knowledge + knowledge_edges tables and migrates
 * existing data from memories, beliefs, strategies, and edge tables.
 *
 * This migration is idempotent — safe to run multiple times.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../core/logger.js';

export async function runKnowledgeMigrations(sqlite: Database): Promise<void> {
  // ── 1. Create knowledge table ──────────────────────────────────────────
  try {
    sqlite.exec(`
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
      )
    `);
    logger.info('Migration: knowledge table ready');
  } catch (error: any) {
    logger.warn(`Migration: knowledge table: ${error.message}`);
  }

  // ── 2. Create knowledge_edges table ────────────────────────────────────
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        from_kind TEXT NOT NULL,
        to_id TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
        UNIQUE(from_id, from_kind, to_id, to_kind, edge_type)
      )
    `);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_from_idx ON knowledge_edges(from_id, from_kind)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_to_idx ON knowledge_edges(to_id, to_kind)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_type_idx ON knowledge_edges(edge_type)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_from_kind_idx ON knowledge_edges(from_kind)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_to_kind_idx ON knowledge_edges(to_kind)`);
    logger.info('Migration: knowledge_edges table ready');
  } catch (error: any) {
    logger.warn(`Migration: knowledge_edges table: ${error.message}`);
  }

  // ── 3. Create knowledge FTS ────────────────────────────────────────────
  try {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        content,
        tags,
        summary,
        title,
        description,
        content='knowledge',
        content_rowid='rowid'
      )
    `);
    // Triggers (idempotent via IF NOT EXISTS)
    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts(rowid, content, tags, summary, title, description)
        VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''), COALESCE(new.title, ''), COALESCE(new.description, ''));
      END
    `);
    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags, summary, title, description)
        VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''), COALESCE(old.title, ''), COALESCE(old.description, ''));
      END
    `);
    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags, summary, title, description)
        VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''), COALESCE(old.title, ''), COALESCE(old.description, ''));
        INSERT INTO knowledge_fts(rowid, content, tags, summary, title, description)
        VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''), COALESCE(new.title, ''), COALESCE(new.description, ''));
      END
    `);
    logger.info('Migration: knowledge_fts ready');
  } catch (error: any) {
    logger.warn(`Migration: knowledge_fts: ${error.message}`);
  }

  // ── 4. Migrate data from memories → knowledge ──────────────────────────
  const knowledgeCount = sqlite.prepare('SELECT COUNT(*) as cnt FROM knowledge').get() as { cnt: number };
  const memoriesExist = tableExists(sqlite, 'memories');

  if (knowledgeCount.cnt === 0 && memoriesExist) {
    logger.info('Migration: migrating memories → knowledge...');

    try {
      sqlite.exec(`
        INSERT INTO knowledge (
          id, project_id, user_id, agent_id, session_id,
          knowledge_kind, knowledge_type,
          content, summary,
          embedding_json, embedding, embedding_blob, embedding_model, embedding_dim,
          confidence, confidence_level, importance_score, importance_decay_rate, last_importance_recalc,
          title,
          status, is_active, sector, tier, version,
          superseded_by,
          tags, metadata,
          place_id, primary_place,
          is_private, is_protected, is_pinned, is_immutable,
          scope, visibility_scope,
          actor_user, actor_agent, agent_role, triggered_by, capture_reason,
          valid_from, valid_to, recorded_at,
          access_count, last_accessed_at,
          is_merged, merged_into_id, merged_at,
          consolidated_from, consolidated_at, is_consolidated,
          encrypted_content, encryption_nonce, is_encrypted,
          compression_level, relevance_score, tokens_estimate,
          decay_rate, coactivation_score, last_decay_at,
          has_l0_abstract, has_l1_overview, last_layer_update,
          media_type, media_path, media_metadata,
          namespace_id, namespace_path,
          employee_id,
          created_at, updated_at
        )
        SELECT
          id, project_id, user_id, agent_id, NULL,
          'memory', type,
          content, summary,
          embedding_json, embedding, embedding_blob, embedding_model, embedding_dim,
          CAST(confidence AS REAL) / 100.0, confidence_level, CAST(importance_score AS REAL) / 100.0, importance_decay_rate, last_importance_recalc,
          NULL,
          status, is_active, sector, tier, version,
          superseded_by,
          tags, metadata,
          place_id, primary_place,
          is_private, is_protected, is_pinned, is_immutable,
          scope, visibility_scope,
          actor_user, actor_agent, agent_role, triggered_by, capture_reason,
          valid_from, valid_to, recorded_at,
          access_count, last_accessed_at,
          is_merged, merged_into_id, merged_at,
          consolidated_from, consolidated_at, is_consolidated,
          encrypted_content, encryption_nonce, is_encrypted,
          compression_level, relevance_score, tokens_estimate,
          decay_rate, coactivation_score, last_decay_at,
          has_l0_abstract, has_l1_overview, last_layer_update,
          media_type, media_path, media_metadata,
          namespace_id, namespace_path,
          employee_id,
          created_at, updated_at
        FROM memories
      `);
      const migrated = sqlite.prepare('SELECT COUNT(*) as cnt FROM knowledge WHERE knowledge_kind = ?').get('memory') as { cnt: number };
      logger.info(`Migration: migrated ${migrated.cnt} memories → knowledge`);
    } catch (error: any) {
      logger.error(`Migration: memories → knowledge failed: ${error.message}`);
    }
  }

  // ── 5. Migrate data from beliefs → knowledge ───────────────────────────
  const beliefsExist = tableExists(sqlite, 'beliefs');
  const beliefCount = beliefsExist
    ? (sqlite.prepare('SELECT COUNT(*) as cnt FROM beliefs').get() as { cnt: number }).cnt
    : 0;

  if (beliefCount > 0) {
    const beliefKnowledgeCount = sqlite.prepare(
      'SELECT COUNT(*) as cnt FROM knowledge WHERE knowledge_kind = ?'
    ).get('belief') as { cnt: number };

    if (beliefKnowledgeCount.cnt === 0) {
      logger.info('Migration: migrating beliefs → knowledge...');
      try {
        sqlite.exec(`
          INSERT INTO knowledge (
            id, project_id,
            knowledge_kind, knowledge_type,
            content,
            normalized_key, reason, evidence_summary, evidence, last_confirmed_at, source_count,
            confidence, confidence_level,
            status,
            tags, metadata,
            created_at, updated_at
          )
          SELECT
            id, project_id,
            'belief', belief_type,
            statement,
            normalized_key, reason, evidence_summary, metadata, last_confirmed_at, source_count,
            CAST(confidence AS REAL) / 100.0, 'certain',
            status,
            NULL, metadata,
            created_at, updated_at
          FROM beliefs
        `);
        const migrated = sqlite.prepare('SELECT COUNT(*) as cnt FROM knowledge WHERE knowledge_kind = ?').get('belief') as { cnt: number };
        logger.info(`Migration: migrated ${migrated.cnt} beliefs → knowledge`);
      } catch (error: any) {
        logger.error(`Migration: beliefs → knowledge failed: ${error.message}`);
      }
    }
  }

  // ── 6. Migrate data from strategies → knowledge ────────────────────────
  const strategiesExist = tableExists(sqlite, 'strategies');
  const strategyCount = strategiesExist
    ? (sqlite.prepare('SELECT COUNT(*) as cnt FROM strategies').get() as { cnt: number }).cnt
    : 0;

  if (strategyCount > 0) {
    const strategyKnowledgeCount = sqlite.prepare(
      'SELECT COUNT(*) as cnt FROM knowledge WHERE knowledge_kind = ?'
    ).get('strategy') as { cnt: number };

    if (strategyKnowledgeCount.cnt === 0) {
      logger.info('Migration: migrating strategies → knowledge...');
      try {
        sqlite.exec(`
          INSERT INTO knowledge (
            id, project_id, user_id, agent_id,
            knowledge_kind, knowledge_type,
            content, title, description,
            steps, success_criteria, failure_indicators,
            confidence, status,
            usage_count, success_count, failure_count,
            last_used_at, last_success_at, last_failure_at,
            superseded_by, tags, metadata,
            visibility_scope,
            created_at, updated_at
          )
          SELECT
            id, project_id, user_id, agent_id,
            'strategy', strategy_type,
            description, title, description,
            steps, success_criteria, failure_indicators,
            confidence, status,
            usage_count, success_count, failure_count,
            last_used_at, last_success_at, last_failure_at,
            superseded_by, tags, metadata,
            visibility_scope,
            created_at, updated_at
          FROM strategies
        `);
        const migrated = sqlite.prepare('SELECT COUNT(*) as cnt FROM knowledge WHERE knowledge_kind = ?').get('strategy') as { cnt: number };
        logger.info(`Migration: migrated ${migrated.cnt} strategies → knowledge`);
      } catch (error: any) {
        logger.error(`Migration: strategies → knowledge failed: ${error.message}`);
      }
    }
  }

  // ── 7. Migrate edge tables → knowledge_edges ───────────────────────────
  const edgeCount = (sqlite.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number }).cnt;

  if (edgeCount === 0) {
    // 7a. belief_memory_sources → knowledge_edges (edge_type = 'evidence_for')
    if (beliefsExist && tableExists(sqlite, 'belief_memory_sources')) {
      try {
        sqlite.exec(`
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at)
          SELECT
            id,
            belief_id, 'knowledge',
            memory_id, 'knowledge',
            'evidence_for',
            1.0,
            created_at
          FROM belief_memory_sources
        `);
        logger.info('Migration: migrated belief_memory_sources → knowledge_edges');
      } catch (error: any) {
        logger.warn(`Migration: belief_memory_sources → knowledge_edges: ${error.message}`);
      }
    }

    // 7b. belief_edges → knowledge_edges
    if (beliefsExist && tableExists(sqlite, 'belief_edges')) {
      try {
        sqlite.exec(`
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, metadata, created_at)
          SELECT
            id,
            from_belief_id, 'knowledge',
            to_belief_id, 'knowledge',
            edge_type,
            metadata,
            created_at
          FROM belief_edges
        `);
        logger.info('Migration: migrated belief_edges → knowledge_edges');
      } catch (error: any) {
        logger.warn(`Migration: belief_edges → knowledge_edges: ${error.message}`);
      }
    }

    // 7c. strategy_edges → knowledge_edges
    if (strategiesExist && tableExists(sqlite, 'strategy_edges')) {
      try {
        sqlite.exec(`
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, metadata, created_at)
          SELECT
            id,
            from_strategy_id, 'knowledge',
            to_strategy_id, 'knowledge',
            edge_type,
            metadata,
            created_at
          FROM strategy_edges
        `);
        logger.info('Migration: migrated strategy_edges → knowledge_edges');
      } catch (error: any) {
        logger.warn(`Migration: strategy_edges → knowledge_edges: ${error.message}`);
      }
    }

    // 7d. strategy_belief_edges → knowledge_edges
    if (strategiesExist && beliefsExist && tableExists(sqlite, 'strategy_belief_edges')) {
      try {
        sqlite.exec(`
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, metadata, created_at)
          SELECT
            id,
            strategy_id, 'knowledge',
            belief_id, 'knowledge',
            edge_type,
            metadata,
            created_at
          FROM strategy_belief_edges
        `);
        logger.info('Migration: migrated strategy_belief_edges → knowledge_edges');
      } catch (error: any) {
        logger.warn(`Migration: strategy_belief_edges → knowledge_edges: ${error.message}`);
      }
    }

    // 7e. entity_relations → knowledge_edges (from_kind/to_kind = 'entity')
    if (tableExists(sqlite, 'entity_relations')) {
      try {
        sqlite.exec(`
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at)
          SELECT
            id,
            from_entity_id, 'entity',
            to_entity_id, 'entity',
            type,
            CAST(weight AS REAL),
            properties,
            created_at
          FROM entity_relations
        `);
        logger.info('Migration: migrated entity_relations → knowledge_edges');
      } catch (error: any) {
        logger.warn(`Migration: entity_relations → knowledge_edges: ${error.message}`);
      }
    }

    // 7f. memory_places → knowledge_edges (from_kind='knowledge', to_kind='place')
    if (tableExists(sqlite, 'memory_places')) {
      try {
        sqlite.exec(`
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at)
          SELECT
            id,
            memory_id, 'knowledge',
            place_type, 'place',
            'placed_in',
            weight,
            json_object('reason', reason, 'source', source, 'is_primary', is_primary),
            created_at
          FROM memory_places
        `);
        logger.info('Migration: migrated memory_places → knowledge_edges');
      } catch (error: any) {
        logger.warn(`Migration: memory_places → knowledge_edges: ${error.message}`);
      }
    }

    const finalEdgeCount = sqlite.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number };
    logger.info(`Migration: total knowledge_edges: ${finalEdgeCount.cnt}`);
  }

  // ── 8. Record schema version ───────────────────────────────────────────
  try {
    sqlite.prepare(
      "INSERT OR IGNORE INTO _schema_versions (version, description) VALUES (?, ?)"
    ).run('2.0.0-knowledge', 'Unified knowledge table replacing memories, beliefs, strategies');
  } catch {
    // ignore
  }
}

function tableExists(sqlite: Database, name: string): boolean {
  const row = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name) as { name: string } | undefined;
  return !!row;
}
