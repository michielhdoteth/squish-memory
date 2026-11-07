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

const ASSOCIATION_SNAPSHOT_MARKER = '2.2.2-memory-association-payload-snapshots';
let knowledgeEdgeMigrationSavepointSequence = 0;

interface LegacyMemoryAssociation {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  association_type: string;
  weight: number | null;
  coactivation_count: number | null;
  last_coactivated_at: number | null;
  metadata: string | null;
  created_at: number;
}

function importLegacyEdges(
  sqlite: Database,
  sourceTable: string,
  insertSql: string,
  matchingSql: string,
): number {
  const sourceCount = (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${sourceTable}`).get() as { count: number }).count;
  if (sourceCount === 0) return 0;
  const migrate = sqlite.transaction(() => {
    sqlite.exec(insertSql);
    const matched = (sqlite.prepare(matchingSql).get() as { count: number }).count;
    if (matched !== sourceCount) {
      throw new Error(`Knowledge edge migration could not reconcile ${sourceCount - matched} rows from ${sourceTable}`);
    }
  });
  migrate.immediate();
  logger.info(`Migration: reconciled ${sourceCount} ${sourceTable} → knowledge_edges`);
  return sourceCount;
}

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

  // Older global databases may already have a partial knowledge table, so
  // CREATE TABLE IF NOT EXISTS alone cannot bring them up to the current write
  // contract. Add every nullable/defaultable column used by the current schema.
  const additiveColumns: Record<string, string> = {
    embedding_blob: 'BLOB', embedding_model: 'TEXT', embedding_dim: 'INTEGER',
    evidence: 'TEXT', version: 'INTEGER DEFAULT 1',
    is_private: 'INTEGER DEFAULT 0', is_protected: 'INTEGER DEFAULT 0',
    is_pinned: 'INTEGER DEFAULT 0', is_immutable: 'INTEGER DEFAULT 0',
    write_scope: 'TEXT', read_scope: 'TEXT', scope: "TEXT DEFAULT 'company'",
    visibility_scope: "TEXT DEFAULT 'private'", actor_user: 'TEXT', actor_agent: 'TEXT',
    agent_role: 'TEXT', triggered_by: 'TEXT', capture_reason: 'TEXT',
    valid_from: 'INTEGER', valid_to: 'INTEGER', recorded_at: 'INTEGER',
    access_count: 'INTEGER DEFAULT 0', last_accessed_at: 'INTEGER',
    is_merged: 'INTEGER DEFAULT 0', merged_into_id: 'TEXT', merged_at: 'INTEGER',
    consolidated_from: 'TEXT', consolidated_at: 'INTEGER', is_consolidated: 'INTEGER DEFAULT 0',
    encrypted_content: 'TEXT', encryption_nonce: 'TEXT', is_encrypted: 'INTEGER DEFAULT 0',
    compression_level: 'INTEGER', relevance_score: 'INTEGER DEFAULT 50',
    tokens_estimate: 'INTEGER DEFAULT 0', decay_rate: 'INTEGER DEFAULT 30',
    coactivation_score: 'INTEGER DEFAULT 0', last_decay_at: 'INTEGER',
    has_l0_abstract: 'INTEGER DEFAULT 0', has_l1_overview: 'INTEGER DEFAULT 0',
    last_layer_update: 'INTEGER', media_type: 'TEXT', media_path: 'TEXT',
    media_metadata: 'TEXT', namespace_id: 'TEXT', namespace_path: 'TEXT', employee_id: 'TEXT',
  };
  const existingKnowledgeColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(knowledge)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  const addedColumns: string[] = [];
  for (const [name, definition] of Object.entries(additiveColumns)) {
    if (existingKnowledgeColumns.has(name)) continue;
    sqlite.exec(`ALTER TABLE knowledge ADD COLUMN ${name} ${definition}`);
    addedColumns.push(name);
  }
  if (addedColumns.length) {
    logger.info(`Migration: added ${addedColumns.length} missing knowledge columns`, { columns: addedColumns });
  }
  // SQLite cannot add CURRENT_TIMESTAMP as a new-column default. Preserve the
  // expected timestamp semantics for existing rows and future inserts.
  sqlite.exec(`
    UPDATE knowledge
    SET recorded_at = COALESCE(recorded_at, created_at, strftime('%s','now')),
        last_decay_at = COALESCE(last_decay_at, created_at, strftime('%s','now'))
    WHERE recorded_at IS NULL OR last_decay_at IS NULL
  `);
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_runtime_timestamps_ai
    AFTER INSERT ON knowledge
    WHEN NEW.recorded_at IS NULL OR NEW.last_decay_at IS NULL
    BEGIN
      UPDATE knowledge
      SET recorded_at = COALESCE(NEW.recorded_at, NEW.created_at, strftime('%s','now')),
          last_decay_at = COALESCE(NEW.last_decay_at, NEW.created_at, strftime('%s','now'))
      WHERE id = NEW.id;
    END
  `);

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
        valid_from INTEGER,
        valid_to INTEGER,
        recorded_at INTEGER,
        recorded_to INTEGER,
        UNIQUE(from_id, from_kind, to_id, to_kind, edge_type, valid_from, recorded_at)
      )
    `);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_from_idx ON knowledge_edges(from_id, from_kind)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_to_idx ON knowledge_edges(to_id, to_kind)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_type_idx ON knowledge_edges(edge_type)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_from_kind_idx ON knowledge_edges(from_kind)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS knowledge_edges_to_kind_idx ON knowledge_edges(to_kind)`);
    const existingEdgeColumns = new Set((sqlite.prepare('PRAGMA table_info(knowledge_edges)').all() as Array<{ name: string }>).map((column) => column.name));
    for (const [name, definition] of Object.entries({ valid_from: 'INTEGER', valid_to: 'INTEGER', recorded_at: 'INTEGER', recorded_to: 'INTEGER' })) {
      if (!existingEdgeColumns.has(name)) sqlite.exec(`ALTER TABLE knowledge_edges ADD COLUMN ${name} ${definition}`);
    }
    sqlite.exec(`UPDATE knowledge_edges SET valid_from = COALESCE(valid_from, created_at * 1000), recorded_at = COALESCE(recorded_at, created_at * 1000, strftime('%s','now') * 1000) WHERE valid_from IS NULL OR recorded_at IS NULL`);
    const edgeIndexes = sqlite.prepare('PRAGMA index_list(knowledge_edges)').all() as Array<{ name: string; unique: number }>;
    const legacyUnique = edgeIndexes.filter((index) => {
      if (!index.unique) return false;
      const columns = (sqlite.prepare(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all() as Array<{ name: string }>).map((column) => column.name);
      return columns.join(',') === 'from_id,from_kind,to_id,to_kind,edge_type';
    });
    if (legacyUnique.length > 0) {
      const columns = sqlite.prepare('PRAGMA table_info(knowledge_edges)').all() as Array<{ name: string }>;
      const expected = ['id', 'from_id', 'from_kind', 'to_id', 'to_kind', 'edge_type', 'weight', 'metadata', 'created_at', 'valid_from', 'valid_to', 'recorded_at', 'recorded_to'];
      if (columns.length !== expected.length || expected.some((name) => !columns.some((column) => column.name === name))) {
        throw new Error('Cannot safely rebuild knowledge_edges with unexpected legacy columns');
      }
      const before = Number((sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges').get() as { count: number }).count);
      const ownsTransaction = !sqlite.inTransaction;
      const savepoint = `squish_knowledge_edges_migration_${++knowledgeEdgeMigrationSavepointSequence}`;
      sqlite.exec(ownsTransaction ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      try {
        sqlite.exec(`
          CREATE TABLE knowledge_edges_temporal_new (
            id TEXT PRIMARY KEY,
            from_id TEXT NOT NULL,
            from_kind TEXT NOT NULL,
            to_id TEXT NOT NULL,
            to_kind TEXT NOT NULL,
            edge_type TEXT NOT NULL,
            weight REAL DEFAULT 1.0,
            metadata TEXT,
            created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
            valid_from INTEGER,
            valid_to INTEGER,
            recorded_at INTEGER,
            recorded_to INTEGER,
            UNIQUE(from_id, from_kind, to_id, to_kind, edge_type, valid_from, recorded_at)
          )
        `);
        sqlite.exec(`INSERT INTO knowledge_edges_temporal_new (${expected.join(',')}) SELECT ${expected.join(',')} FROM knowledge_edges`);
        const copied = Number((sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges_temporal_new').get() as { count: number }).count);
        if (copied !== before) throw new Error(`knowledge_edges migration count mismatch: ${before} source rows, ${copied} copied rows`);
        sqlite.exec('DROP TABLE knowledge_edges');
        sqlite.exec('ALTER TABLE knowledge_edges_temporal_new RENAME TO knowledge_edges');
        sqlite.exec(ownsTransaction ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        try {
          if (ownsTransaction) sqlite.exec('ROLLBACK');
          else {
            sqlite.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
          }
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Knowledge edge migration failed and could not roll back cleanly');
        }
        throw error;
      }
    }
    sqlite.exec('DROP INDEX IF EXISTS knowledge_edges_unique');
    sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS knowledge_edges_unique ON knowledge_edges(from_id, from_kind, to_id, to_kind, edge_type, valid_from, recorded_at)');
    sqlite.exec('CREATE INDEX IF NOT EXISTS knowledge_edges_valid_time_idx ON knowledge_edges(valid_from, valid_to, recorded_at, recorded_to)');
    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_edges_temporal_intervals_insert
      BEFORE INSERT ON knowledge_edges
      WHEN (NEW.valid_to IS NOT NULL AND (NEW.valid_from IS NULL OR NEW.valid_to <= NEW.valid_from))
        OR (NEW.recorded_to IS NOT NULL AND (NEW.recorded_at IS NULL OR NEW.recorded_to <= NEW.recorded_at))
      BEGIN
        SELECT RAISE(ABORT, 'knowledge edge interval end must be later than its start');
      END
    `);
    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_edges_temporal_intervals_update
      BEFORE UPDATE OF valid_from, valid_to, recorded_at, recorded_to ON knowledge_edges
      WHEN (NEW.valid_to IS NOT NULL AND (NEW.valid_from IS NULL OR NEW.valid_to <= NEW.valid_from))
        OR (NEW.recorded_to IS NOT NULL AND (NEW.recorded_at IS NULL OR NEW.recorded_to <= NEW.recorded_at))
      BEGIN
        SELECT RAISE(ABORT, 'knowledge edge interval end must be later than its start');
      END
    `);
    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_edges_temporal_insert
      AFTER INSERT ON knowledge_edges
      WHEN NEW.valid_from IS NULL OR NEW.recorded_at IS NULL
      BEGIN
        UPDATE knowledge_edges
        SET valid_from = COALESCE(NEW.valid_from, NEW.created_at * 1000, strftime('%s','now') * 1000),
            recorded_at = COALESCE(NEW.recorded_at, NEW.created_at * 1000, strftime('%s','now') * 1000)
        WHERE id = NEW.id;
      END
    `);
    logger.info('Migration: knowledge_edges table ready');
  } catch (error: any) {
    logger.error(`Migration: knowledge_edges table failed: ${error.message}`);
    throw error;
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
  const memoriesExist = tableExists(sqlite, 'memories');
  if (memoriesExist) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS memory_capture_receipts (
        capture_key_hash TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS memory_capture_receipts_memory_idx ON memory_capture_receipts(memory_id);
      CREATE TRIGGER IF NOT EXISTS memories_delete_capture_receipts
      AFTER DELETE ON memories BEGIN
        DELETE FROM memory_capture_receipts WHERE memory_id = OLD.id;
      END;
      CREATE TABLE IF NOT EXISTS memory_private_session_index (
        session_token TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        project_id TEXT,
        user_id TEXT,
        team_id TEXT,
        record_mac TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (session_token, memory_id),
        FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS memory_private_session_scope_idx
        ON memory_private_session_index(user_id, session_token, project_id);
      CREATE TRIGGER IF NOT EXISTS memories_delete_private_session_index
      AFTER DELETE ON memories BEGIN
        DELETE FROM memory_private_session_index WHERE memory_id = OLD.id;
      END;
    `);
  }

  if (memoriesExist) {
    logger.info('Migration: migrating memories → knowledge...');

    try {
      sqlite.exec(`
        INSERT OR IGNORE INTO knowledge (
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
          place_id, NULL,
          is_private, is_protected, is_pinned, is_immutable,
          'company', visibility_scope,
          NULL, NULL, agent_role, triggered_by, capture_reason,
          valid_from, valid_to, recorded_at,
          access_count, last_accessed_at,
          is_merged, merged_into_id, merged_at,
          NULL, consolidated_at, is_consolidated,
          encrypted_content, encryption_nonce, is_encrypted,
          NULL, relevance_score, tokens_estimate,
          decay_rate, coactivation_score, last_decay_at,
          has_l0_abstract, has_l1_overview, last_layer_update,
          media_type, media_path, media_metadata,
          namespace_id, namespace_path,
          NULL,
          created_at, updated_at
        FROM memories m
        WHERE NOT EXISTS (
          SELECT 1 FROM knowledge k
          WHERE k.id = m.id
             OR json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.sourceMemoryId') = m.id
             OR (
               json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey') IS NOT NULL
               AND json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey') = json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey')
             )
        )
      `);
      const migrated = sqlite.prepare('SELECT COUNT(*) as cnt FROM knowledge WHERE knowledge_kind = ?').get('memory') as { cnt: number };
      logger.info(`Migration: migrated ${migrated.cnt} memories → knowledge`);
    } catch (error: any) {
      logger.error(`Migration: memories → knowledge failed: ${error.message}`);
      throw error;
    }
    const missingMemoryRows = sqlite.prepare(`
      SELECT COUNT(*) AS count FROM memories m
      WHERE NOT EXISTS (
        SELECT 1 FROM knowledge k
        WHERE k.id = m.id
           OR json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.sourceMemoryId') = m.id
           OR (
             json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey') IS NOT NULL
             AND json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey') = json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey')
           )
      )
    `).get() as { count: number };
    if (missingMemoryRows.count > 0) {
      throw new Error(`Knowledge migration left ${missingMemoryRows.count} memory rows unindexed`);
    }
    scrubEncryptedMemoryDerivatives(sqlite);
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
    // 7a. belief_memory_sources → knowledge_edges (edge_type = 'evidence_for')
    if (beliefsExist && tableExists(sqlite, 'belief_memory_sources')) {
      importLegacyEdges(sqlite, 'belief_memory_sources', `
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at, valid_from, recorded_at)
          SELECT
            id,
            belief_id, 'knowledge',
            memory_id, 'knowledge',
            'evidence_for',
            1.0,
            created_at,
            created_at * 1000,
            created_at * 1000
          FROM belief_memory_sources
        `, `
          SELECT COUNT(*) AS count FROM belief_memory_sources s
          JOIN knowledge_edges e ON e.id = s.id
            AND e.from_id = s.belief_id AND e.from_kind = 'knowledge'
            AND e.to_id = s.memory_id AND e.to_kind = 'knowledge'
            AND e.edge_type = 'evidence_for' AND e.weight = 1.0 AND e.metadata IS NULL
            AND e.created_at IS s.created_at
            AND e.valid_from IS s.created_at * 1000 AND e.recorded_at IS s.created_at * 1000
        `);
    }

    // 7b. Import by source-table presence: the belief rows may already have
    // been moved into knowledge and the legacy beliefs table removed.
    if (tableExists(sqlite, 'belief_edges')) {
      importLegacyEdges(sqlite, 'belief_edges', `
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, metadata, created_at, valid_from, recorded_at)
          SELECT
            id,
            from_belief_id, 'knowledge',
            to_belief_id, 'knowledge',
            edge_type,
            metadata,
            created_at,
            created_at * 1000,
            created_at * 1000
          FROM belief_edges
        `, `
          SELECT COUNT(*) AS count FROM belief_edges s
          JOIN knowledge_edges e ON e.id = s.id
            AND e.from_id = s.from_belief_id AND e.from_kind = 'knowledge'
            AND e.to_id = s.to_belief_id AND e.to_kind = 'knowledge'
            AND e.edge_type = s.edge_type AND e.weight = 1.0 AND e.metadata IS s.metadata
            AND e.created_at IS s.created_at
            AND e.valid_from IS s.created_at * 1000 AND e.recorded_at IS s.created_at * 1000
        `);
    }

    // 7c. strategy_edges → knowledge_edges
    if (strategiesExist && tableExists(sqlite, 'strategy_edges')) {
      importLegacyEdges(sqlite, 'strategy_edges', `
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, metadata, created_at, valid_from, recorded_at)
          SELECT
            id,
            from_strategy_id, 'knowledge',
            to_strategy_id, 'knowledge',
            edge_type,
            metadata,
            created_at,
            created_at * 1000,
            created_at * 1000
          FROM strategy_edges
        `, `
          SELECT COUNT(*) AS count FROM strategy_edges s
          JOIN knowledge_edges e ON e.id = s.id
            AND e.from_id = s.from_strategy_id AND e.from_kind = 'knowledge'
            AND e.to_id = s.to_strategy_id AND e.to_kind = 'knowledge'
            AND e.edge_type = s.edge_type AND e.weight = 1.0 AND e.metadata IS s.metadata
            AND e.created_at IS s.created_at
            AND e.valid_from IS s.created_at * 1000 AND e.recorded_at IS s.created_at * 1000
        `);
    }

    // 7d. strategy_belief_edges → knowledge_edges
    if (strategiesExist && beliefsExist && tableExists(sqlite, 'strategy_belief_edges')) {
      importLegacyEdges(sqlite, 'strategy_belief_edges', `
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, metadata, created_at, valid_from, recorded_at)
          SELECT
            id,
            strategy_id, 'knowledge',
            belief_id, 'knowledge',
            edge_type,
            metadata,
            created_at,
            created_at * 1000,
            created_at * 1000
          FROM strategy_belief_edges
        `, `
          SELECT COUNT(*) AS count FROM strategy_belief_edges s
          JOIN knowledge_edges e ON e.id = s.id
            AND e.from_id = s.strategy_id AND e.from_kind = 'knowledge'
            AND e.to_id = s.belief_id AND e.to_kind = 'knowledge'
            AND e.edge_type = s.edge_type AND e.weight = 1.0 AND e.metadata IS s.metadata
            AND e.created_at IS s.created_at
            AND e.valid_from IS s.created_at * 1000 AND e.recorded_at IS s.created_at * 1000
        `);
    }

    // 7e. entity_relations → knowledge_edges (from_kind/to_kind = 'entity')
    if (tableExists(sqlite, 'entity_relations')) {
      importLegacyEdges(sqlite, 'entity_relations', `
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at)
          SELECT
            id,
            from_entity_id, 'entity',
            to_entity_id, 'entity',
            type,
            CAST(weight AS REAL),
            properties,
            created_at,
            created_at * 1000,
            created_at * 1000
          FROM entity_relations
        `, `
          SELECT COUNT(*) AS count FROM entity_relations s
          JOIN knowledge_edges e ON e.id = s.id
            AND e.from_id = s.from_entity_id AND e.from_kind = 'entity'
            AND e.to_id = s.to_entity_id AND e.to_kind = 'entity'
            AND e.edge_type = s.type
            AND e.weight IS CAST(s.weight AS REAL)
            AND e.metadata IS s.properties
            AND e.created_at IS s.created_at
            AND e.valid_from IS s.created_at * 1000
            AND e.recorded_at IS s.created_at * 1000
        `);
    }

    // 7f. memory_places → knowledge_edges (from_kind='knowledge', to_kind='place')
    if (tableExists(sqlite, 'memory_places')) {
      importLegacyEdges(sqlite, 'memory_places', `
          INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at)
          SELECT
            id,
            memory_id, 'knowledge',
            place_type, 'place',
            'placed_in',
            weight,
            json_object('reason', reason, 'source', source, 'is_primary', is_primary),
            created_at,
            created_at * 1000,
            created_at * 1000
          FROM memory_places
        `, `
          SELECT COUNT(*) AS count FROM memory_places s
          JOIN knowledge_edges e ON e.id = s.id
            AND e.from_id = s.memory_id AND e.from_kind = 'knowledge'
            AND e.to_id = s.place_type AND e.to_kind = 'place'
            AND e.edge_type = 'placed_in' AND e.weight IS s.weight
            AND e.metadata IS json_object('reason', s.reason, 'source', s.source, 'is_primary', s.is_primary)
            AND e.created_at IS s.created_at
            AND e.valid_from IS s.created_at * 1000 AND e.recorded_at IS s.created_at * 1000
        `);
    }

    // 7g. memory_associations -> knowledge_edges. Preserve the source relation
    // labels and lifecycle metadata; do not reinterpret similarity as an update.
    if (tableExists(sqlite, 'memory_associations')) {
      const snapshotMarker = tableExists(sqlite, '_schema_versions')
        ? sqlite.prepare('SELECT 1 FROM _schema_versions WHERE version = ?').get(ASSOCIATION_SNAPSHOT_MARKER)
        : undefined;
      if (!snapshotMarker) {
        const snapshotLegacyAssociations = sqlite.transaction(() => {
          // Older imports predate payload snapshots. Backfill only rows that
          // already carry this importer's marker and still match source edge
          // identity. Future runs compare this frozen payload rather than
          // mutable canonical weight or feedback fields.
          sqlite.exec(`
            UPDATE knowledge_edges AS e
            SET metadata = json_set(
              CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END,
              '$.legacy_snapshot', json_object(
                'weight', (SELECT CAST(a.weight AS REAL) FROM memory_associations a WHERE a.id = e.id),
                'coactivation_count', (SELECT a.coactivation_count FROM memory_associations a WHERE a.id = e.id),
                'last_coactivated_at', (SELECT a.last_coactivated_at FROM memory_associations a WHERE a.id = e.id),
                'metadata', (SELECT a.metadata FROM memory_associations a WHERE a.id = e.id)
              )
            )
            WHERE json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.legacy_snapshot') IS NULL
              AND (
                json_type(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.legacy_metadata') IS NOT NULL
                OR json_type(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.legacy_metadata_raw') IS NOT NULL
              )
              AND EXISTS (
                SELECT 1 FROM memory_associations a
                WHERE a.id = e.id
                  AND a.from_memory_id = e.from_id AND e.from_kind = 'knowledge'
                  AND a.to_memory_id = e.to_id AND e.to_kind = 'knowledge'
                  AND a.association_type = e.edge_type
                  AND a.created_at = e.created_at
                  AND a.created_at * 1000 = e.valid_from
                  AND a.created_at * 1000 = e.recorded_at
              )
          `);
          if (tableExists(sqlite, '_schema_versions')) {
            sqlite.prepare('INSERT OR IGNORE INTO _schema_versions (version, description) VALUES (?, ?)')
              .run(ASSOCIATION_SNAPSHOT_MARKER, 'Record immutable source payloads for migrated memory association edges');
          }
        });
        snapshotLegacyAssociations.immediate();
      }

      const associationCount = (sqlite.prepare('SELECT COUNT(*) AS count FROM memory_associations').get() as { count: number }).count;
      if (associationCount > 0) {
        const migrateAssociations = sqlite.transaction(() => {
          const rows = sqlite.prepare('SELECT id, from_memory_id, to_memory_id, association_type, weight, coactivation_count, last_coactivated_at, metadata, created_at FROM memory_associations').all() as LegacyMemoryAssociation[];
          const directProjection = sqlite.prepare(`
            SELECT id FROM knowledge
            WHERE id = ? OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?
            ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id
            LIMIT 1
          `);
          const workspaceProjection = tableExists(sqlite, 'memories') ? sqlite.prepare(`
            SELECT k.id
            FROM memories m
            JOIN knowledge k
              ON json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey')
               = json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey')
            WHERE m.id = ?
              AND json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.workspaceMemoryImport.sourceKey') IS NOT NULL
            ORDER BY k.id
            LIMIT 1
          `) : null;
          const projectionCache = new Map<string, string | null>();
          const resolveProjection = (memoryId: string): string | null => {
            if (projectionCache.has(memoryId)) return projectionCache.get(memoryId) ?? null;
            const direct = directProjection.get(memoryId, memoryId, memoryId) as { id: string } | undefined;
            const workspace = direct || !workspaceProjection ? undefined : workspaceProjection.get(memoryId) as { id: string } | undefined;
            const id = direct?.id ?? workspace?.id ?? null;
            projectionCache.set(memoryId, id);
            return id;
          };
          const insertAssociation = sqlite.prepare(`
            INSERT OR IGNORE INTO knowledge_edges (
              id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata,
              created_at, valid_from, recorded_at
            )
            SELECT
              a.id, ?, 'knowledge', ?, 'knowledge',
              a.association_type, CAST(a.weight AS REAL),
              CASE
                WHEN json_valid(a.metadata) THEN json_object(
                  'legacy_snapshot', json_object(
                    'weight', CAST(a.weight AS REAL),
                    'coactivation_count', a.coactivation_count,
                    'last_coactivated_at', a.last_coactivated_at,
                    'metadata', a.metadata
                  ),
                  'legacy_metadata', json(a.metadata),
                  'coactivation_count', a.coactivation_count,
                  'last_coactivated_at', a.last_coactivated_at
                )
                ELSE json_object(
                  'legacy_snapshot', json_object(
                    'weight', CAST(a.weight AS REAL),
                    'coactivation_count', a.coactivation_count,
                    'last_coactivated_at', a.last_coactivated_at,
                    'metadata', a.metadata
                  ),
                  'legacy_metadata_raw', a.metadata,
                  'coactivation_count', a.coactivation_count,
                  'last_coactivated_at', a.last_coactivated_at
                )
              END,
              a.created_at, a.created_at * 1000, a.created_at * 1000
            FROM memory_associations a WHERE a.id = ?
          `);
          const verifyAssociation = sqlite.prepare(`
            SELECT 1 FROM knowledge_edges e
            WHERE e.id = ? AND e.from_id = ? AND e.from_kind = 'knowledge'
              AND e.to_id = ? AND e.to_kind = 'knowledge'
              AND e.edge_type = ? AND e.created_at IS ?
              AND e.valid_from = ? * 1000 AND e.recorded_at = ? * 1000
              AND CAST(json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.legacy_snapshot.weight') AS REAL) IS CAST(? AS REAL)
              AND json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.legacy_snapshot.coactivation_count') IS ?
              AND json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.legacy_snapshot.last_coactivated_at') IS ?
              AND json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.legacy_snapshot.metadata') IS ?
          `);
          let imported = 0;
          let unresolved = 0;
          let unreconciled = 0;
          for (const association of rows) {
            const fromId = resolveProjection(association.from_memory_id);
            const toId = resolveProjection(association.to_memory_id);
            if (!fromId || !toId) {
              unresolved += 1;
              continue;
            }
            insertAssociation.run(fromId, toId, association.id);
            const reconciled = verifyAssociation.get(
              association.id, fromId, toId, association.association_type,
              association.created_at, association.created_at, association.created_at,
              association.weight, association.coactivation_count,
              association.last_coactivated_at, association.metadata,
            );
            if (!reconciled) unreconciled += 1;
            else imported += 1;
          }
          if (unreconciled > 0) throw new Error(`Knowledge edge migration could not reconcile ${unreconciled} memory associations`);
          if (unresolved > 0) {
            logger.warn(`Migration: retained ${unresolved} memory associations in their legacy table because a source memory or canonical projection is missing`);
          }
          logger.info(`Migration: reconciled ${imported} of ${rows.length} memory_associations → knowledge_edges`);
        });
        migrateAssociations.immediate();
      }
    }

    const finalEdgeCount = sqlite.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number };
    logger.info(`Migration: total knowledge_edges: ${finalEdgeCount.cnt}`);

  // ── 8. Record schema version ───────────────────────────────────────────
  try {
    sqlite.prepare(
      "INSERT OR IGNORE INTO _schema_versions (version, description) VALUES (?, ?)"
    ).run('2.0.0-knowledge', 'Unified knowledge table replacing memories, beliefs, strategies');
  } catch {
    // ignore
  }
}

/** Remove plaintext derived state left by pre-boundary SQLite encrypted writes. */
function scrubEncryptedMemoryDerivatives(sqlite: Database): void {
  const encryptedRows = sqlite.prepare(`
    SELECT id, project_id, encrypted_content, encryption_nonce, metadata FROM memories
    WHERE COALESCE(is_encrypted, 0) = 1
  `).all() as Array<{
    id: string;
    project_id: string | null;
    encrypted_content: string | null;
    encryption_nonce: string | null;
    metadata: string | Record<string, unknown> | null;
  }>;
  if (encryptedRows.length === 0) return;

  const scrub = sqlite.transaction(() => {
    scrubEncryptedMergeDerivatives(sqlite, encryptedRows);
    const sourceUpdate = sqlite.prepare(`
      UPDATE memories SET
        summary = NULL, embedding_json = NULL, embedding = NULL, embedding_blob = NULL,
        embedding_model = NULL, embedding_dim = NULL, tags = '[]', tokens_estimate = 0,
        metadata = json_object('sourceMemoryId', id, 'encrypted', json('true')),
        primary_place = NULL, place_id = NULL
      WHERE id = ? AND COALESCE(is_encrypted, 0) = 1
    `);
    const projections = sqlite.prepare(`
      SELECT id FROM knowledge WHERE knowledge_kind = 'memory'
        AND (id = ? OR (
          json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?
          AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.analysisJobId') IS NULL
        ))
    `);
    const knowledgeBySource = sqlite.prepare(`
      SELECT id FROM knowledge k WHERE
        json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.sourceMemoryId') = ?
        OR EXISTS (
          SELECT 1 FROM json_each(
            CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END,
            '$.sourceMemoryIds'
          ) support WHERE support.value = ?
        )
    `);
    const deleteKnowledge = sqlite.prepare('DELETE FROM knowledge WHERE id = ?');
    const projectionUpdate = sqlite.prepare(`
      UPDATE knowledge SET
        content = '', summary = NULL, embedding_json = NULL, embedding = NULL, embedding_blob = NULL,
        embedding_model = NULL, embedding_dim = NULL, tags = NULL,
        metadata = json_object('sourceMemoryId', ?, 'encrypted', json('true')),
        encrypted_content = ?, encryption_nonce = ?, is_encrypted = 1,
        title = NULL, description = NULL, steps = NULL, success_criteria = NULL,
        failure_indicators = NULL, reason = NULL, evidence_summary = NULL
      WHERE id = ?
    `);
    const deleteEdges = sqlite.prepare('DELETE FROM knowledge_edges WHERE from_id = ? OR to_id = ?');
    const edgeBySupport = sqlite.prepare(`
      SELECT id, from_id, from_kind, to_id, to_kind FROM knowledge_edges e
      WHERE EXISTS (
        SELECT 1 FROM json_each(
          CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END,
          '$.sourceMemoryIds'
        ) support WHERE support.value = ?
      )
    `);
    const deleteEdgeById = sqlite.prepare('DELETE FROM knowledge_edges WHERE id = ?');
    const candidateEntityIds = new Set<string>();
    const candidateEntityNames = new Map<string, string | null>();

    const columnCache = new Map<string, Set<string>>();
    const tableColumns = (table: string): Set<string> => {
      const cached = columnCache.get(table);
      if (cached) return cached;
      if (!tableExists(sqlite, table)) {
        const empty = new Set<string>();
        columnCache.set(table, empty);
        return empty;
      }
      const columns = new Set((sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((column) => column.name));
      columnCache.set(table, columns);
      return columns;
    };
    const deleteLinkedRow = (table: string, column: string, memoryId: string): void => {
      if (!tableColumns(table).has(column)) return;
      sqlite.prepare(`DELETE FROM "${table}" WHERE "${column}" = ?`).run(memoryId);
    };

    for (const row of encryptedRows) {
      const metadata = parseMigrationMetadata(row.metadata);
      if (Array.isArray(metadata.entities)) {
        for (const value of metadata.entities) {
          if (typeof value === 'string' && value.trim()) candidateEntityNames.set(value.trim(), row.project_id);
        }
      }

      sourceUpdate.run(row.id);
      const canonicalProjectionIds = new Set((projections.all(row.id, row.id) as Array<{ id: string }>).map((projection) => projection.id));
      for (const derived of knowledgeBySource.all(row.id, row.id) as Array<{ id: string }>) {
        if (canonicalProjectionIds.has(derived.id)) continue;
        deleteEdges.run(derived.id, derived.id);
        deleteKnowledge.run(derived.id);
      }
      for (const [table, column] of [
        ['memory_tags', 'memory_id'],
        ['memory_capture_receipts', 'memory_id'],
        ['memory_hash_cache', 'memory_id'],
        ['memory_analysis_jobs', 'source_memory_id'],
        ['memory_places', 'memory_id'],
        ['memory_versions', 'memory_id'],
        ['memory_edit_proposals', 'memory_id'],
        ['memory_feedback', 'memory_id'],
        ['agent_preferences', 'source_memory_id'],
        ['learnings', 'memory_id'],
        ['skill_memory_links', 'memory_id'],
      ]) deleteLinkedRow(table, column, row.id);

      // Keep only authenticated encrypted correction envelopes. Any older
      // plaintext snapshot is removed as part of the existing privacy scrub.
      if (tableColumns('memory_snapshots').has('encrypted_payload')
        && tableColumns('memory_snapshots').has('encrypted_nonce')
        && tableColumns('memory_snapshots').has('encryption_format')) {
        sqlite.prepare(`DELETE FROM memory_snapshots WHERE memory_id=? AND NOT (
          snapshot_type='correction' AND encrypted_payload IS NOT NULL
          AND encrypted_nonce IS NOT NULL AND encryption_format='squish-aesgcm-aad-v1'
        )`).run(row.id);
      } else deleteLinkedRow('memory_snapshots', 'memory_id', row.id);

      // A derived belief may encode the encrypted source even when it has
      // additional supports; delete the linked belief instead of retaining a
      // statement whose exact contribution cannot be separated safely.
      if (tableColumns('belief_memory_sources').has('memory_id') && tableColumns('belief_memory_sources').has('belief_id')) {
        const beliefIds = sqlite.prepare('SELECT belief_id FROM belief_memory_sources WHERE memory_id = ?')
          .all(row.id) as Array<{ belief_id: string | null }>;
        for (const belief of beliefIds) {
          if (belief.belief_id && tableExists(sqlite, 'beliefs')) {
            sqlite.prepare('DELETE FROM beliefs WHERE id = ?').run(belief.belief_id);
          }
        }
        sqlite.prepare('DELETE FROM belief_memory_sources WHERE memory_id = ?').run(row.id);
      }

      // Derived summaries and graph assertions carry source IDs but may have
      // aggregated encrypted text into their own content or relation payload.
      if (tableColumns('mental_models').has('source_memory_ids')) {
        sqlite.prepare(`DELETE FROM mental_models WHERE EXISTS (
          SELECT 1 FROM json_each(
            CASE WHEN json_valid(source_memory_ids) THEN source_memory_ids ELSE '[]' END
          ) source WHERE source.value = ?
        )`).run(row.id);
      }
      for (const edge of edgeBySupport.all(row.id) as Array<{
        id: string; from_id: string; from_kind: string; to_id: string; to_kind: string;
      }>) {
        if (edge.from_kind === 'entity') candidateEntityIds.add(edge.from_id);
        if (edge.to_kind === 'entity') candidateEntityIds.add(edge.to_id);
        deleteEdgeById.run(edge.id);
      }

      for (const projection of projections.all(row.id, row.id) as Array<{ id: string }>) {
        projectionUpdate.run(row.id, row.encrypted_content, row.encryption_nonce, projection.id);
        deleteEdges.run(projection.id, projection.id);
      }
    }

    if (tableExists(sqlite, 'entities')) {
      const columns = tableColumns('entities');
      for (const [name, projectId] of candidateEntityNames) {
        const entities = columns.has('project_id')
          ? sqlite.prepare('SELECT id FROM entities WHERE name = ? AND project_id IS ?').all(name, projectId) as Array<{ id: string }>
          : sqlite.prepare('SELECT id FROM entities WHERE name = ?').all(name) as Array<{ id: string }>;
        for (const entity of entities) candidateEntityIds.add(entity.id);
      }

      const scrubFields = [
        ['description', 'NULL'], ['embedding_json', 'NULL'], ['properties', "'{}'"],
        ['aliases', "'[]'"], ['mention_count', '0'], ['last_mentioned_at', 'NULL'],
      ].filter(([column]) => columns.has(column));
      if (scrubFields.length > 0) {
        const assignments = scrubFields.map(([column, value]) => `"${column}" = ${value}`).join(', ');
        const projectMatch = columns.has('project_id') ? 'AND m.project_id IS entities.project_id' : '';
        for (const entityId of candidateEntityIds) {
          sqlite.prepare(`UPDATE entities SET ${assignments} WHERE id = ?`).run(entityId);
          sqlite.prepare(`DELETE FROM entities WHERE id = ? AND NOT EXISTS (
            SELECT 1 FROM knowledge_edges e WHERE
              (e.from_kind = 'entity' AND e.from_id = entities.id) OR
              (e.to_kind = 'entity' AND e.to_id = entities.id)
          ) AND NOT EXISTS (
            SELECT 1 FROM memories m WHERE COALESCE(m.is_encrypted, 0) = 0
              ${projectMatch}
              AND EXISTS (
                SELECT 1 FROM json_each(
                  CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END,
                  '$.entities'
                ) entity_name WHERE lower(entity_name.value) = lower(entities.name)
              )
          )`).run(entityId);
        }
      }
    }
  });
  scrub.immediate();
  logger.info(`Migration: scrubbed plaintext derivatives for ${encryptedRows.length} encrypted memories`);
}

/** Retract merge artifacts whose stored content may include an encrypted source. */
function scrubEncryptedMergeDerivatives(
  sqlite: Database,
  encryptedRows: Array<{ id: string; project_id: string | null }>,
): void {
  const projectIds = [...new Set(encryptedRows.map((row) => row.project_id).filter((id): id is string => Boolean(id)))];
  if (projectIds.length === 0) return;
  const projectPlaceholders = projectIds.map(() => '?').join(',');
  const encryptedSourceIds = encryptedRows.map((row) => row.id);

  const parseIds = (value: unknown, label: string): string[] => {
    let parsed: unknown;
    try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
    catch { throw new Error(`Encrypted-memory cleanup cannot inspect merge ${label} source IDs`); }
    if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) {
      throw new Error(`Encrypted-memory cleanup found invalid merge ${label} source IDs`);
    }
    return parsed;
  };

  const affectedIds = new Set(encryptedSourceIds);
  let proposals: Array<{ id: string; source_memory_ids: unknown }> = [];
  if (tableExists(sqlite, 'memory_merge_proposals')) {
    proposals = sqlite.prepare(`SELECT id, source_memory_ids FROM memory_merge_proposals
      WHERE project_id IN (${projectPlaceholders})`).all(...projectIds) as Array<{ id: string; source_memory_ids: unknown }>;
  }
  let histories: Array<{ id: string; canonical_memory_id: string; source_memory_ids: unknown }> = [];
  if (tableExists(sqlite, 'memory_merge_history')) {
    histories = sqlite.prepare(`SELECT id, canonical_memory_id, source_memory_ids FROM memory_merge_history
      WHERE project_id IN (${projectPlaceholders})`).all(...projectIds) as Array<{ id: string; canonical_memory_id: string; source_memory_ids: unknown }>;
  }
  const historySources = new Map<string, string[]>();
  for (const history of histories) {
    historySources.set(history.canonical_memory_id, parseIds(history.source_memory_ids, `history ${history.id}`));
  }
  const canonicals = sqlite.prepare(`SELECT id, merge_source_ids FROM memories
    WHERE project_id IN (${projectPlaceholders}) AND (is_canonical = 1 OR source = 'merge')`)
    .all(...projectIds) as Array<{ id: string; merge_source_ids: unknown }>;
  const canonicalSources = new Map<string, string[]>();
  for (const canonical of canonicals) {
    if (canonical.merge_source_ids !== null && canonical.merge_source_ids !== undefined) {
      canonicalSources.set(canonical.id, parseIds(canonical.merge_source_ids, `canonical ${canonical.id}`));
    }
  }

  const affectedCanonicalIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const canonical of canonicals) {
      if (affectedCanonicalIds.has(canonical.id)) continue;
      const sources = canonicalSources.get(canonical.id) ?? [];
      const recordedSources = historySources.get(canonical.id) ?? [];
      if (sources.some((id) => affectedIds.has(id)) || recordedSources.some((id) => affectedIds.has(id))) {
        affectedCanonicalIds.add(canonical.id);
        affectedIds.add(canonical.id);
        changed = true;
      }
    }
  }

  const deleteProposal = tableExists(sqlite, 'memory_merge_proposals')
    ? sqlite.prepare('DELETE FROM memory_merge_proposals WHERE id = ?')
    : null;
  for (const proposal of proposals) {
    if (parseIds(proposal.source_memory_ids, `proposal ${proposal.id}`).some((id) => affectedIds.has(id))) {
      deleteProposal?.run(proposal.id);
    }
  }

  if (affectedCanonicalIds.size === 0) return;
  const restoreSource = sqlite.prepare(`UPDATE memories SET is_merged = 0, merged_into_id = NULL,
    merged_at = NULL, is_active = 1, updated_at = strftime('%s','now')
    WHERE id = ? AND COALESCE(is_encrypted, 0) = 0`);
  const restoreProjection = sqlite.prepare(`UPDATE knowledge SET status = 'active', is_active = 1,
    superseded_by = NULL, updated_at = strftime('%s','now')
    WHERE knowledge_kind = 'memory'
      AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?`);
  const deleteProjection = sqlite.prepare(`DELETE FROM knowledge WHERE id = ? OR
    (knowledge_kind = 'memory' AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?)`);
  const deleteEdges = sqlite.prepare('DELETE FROM knowledge_edges WHERE from_id = ? OR to_id = ?');
  const deleteHistory = tableExists(sqlite, 'memory_merge_history')
    ? sqlite.prepare('DELETE FROM memory_merge_history WHERE canonical_memory_id = ?')
    : null;
  const deleteCanonical = sqlite.prepare('DELETE FROM memories WHERE id = ?');

  for (const canonicalId of affectedCanonicalIds) {
    const sources = historySources.get(canonicalId) ?? canonicalSources.get(canonicalId) ?? [];
    for (const sourceId of sources) {
      if (!affectedIds.has(sourceId)) {
        restoreSource.run(sourceId);
        restoreProjection.run(sourceId);
      }
    }
    deleteEdges.run(canonicalId, canonicalId);
    deleteProjection.run(canonicalId, canonicalId);
    deleteHistory?.run(canonicalId);
    deleteCanonical.run(canonicalId);
  }
}

function parseMigrationMetadata(value: string | Record<string, unknown> | null): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function tableExists(sqlite: Database, name: string): boolean {
  const row = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name) as { name: string } | undefined;
  return !!row;
}
