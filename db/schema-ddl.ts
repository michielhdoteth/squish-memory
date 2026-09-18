/**
 * DDL definitions for creating individual tables by name.
 *
 * Used by the repair module to create tables that may have been missed
 * during the bootstrap's tolerant first pass. Only supports tables that
 * appear after the last schema index/trigger statement that could fail
 * on existing tables.
 */

export function createSingleTable(raw: any, tableName: string): void {
  switch (tableName) {
    case 'session_summaries':
      raw.exec(`
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
      `);
      raw.exec('CREATE INDEX IF NOT EXISTS session_summaries_conversation_idx ON session_summaries(conversation_id)');
      raw.exec('CREATE INDEX IF NOT EXISTS session_summaries_project_idx ON session_summaries(project_id)');
      raw.exec('CREATE INDEX IF NOT EXISTS session_summaries_type_idx ON session_summaries(summary_type)');
      raw.exec('CREATE INDEX IF NOT EXISTS session_summaries_created_idx ON session_summaries(created_at)');
      break;

    case 'beliefs':
      raw.exec(`
        CREATE TABLE IF NOT EXISTS beliefs (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          belief_type TEXT NOT NULL,
          statement TEXT NOT NULL,
          normalized_key TEXT NOT NULL,
          confidence REAL DEFAULT 0.5,
          belief_decay_rate INTEGER DEFAULT 30,
          last_confirmed_at INTEGER,
          source_count INTEGER DEFAULT 1,
          status TEXT DEFAULT 'active',
          reason TEXT,
          context TEXT,
          evidence_summary TEXT,
          metadata TEXT,
          created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
          updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
          UNIQUE(project_id, normalized_key)
        );
      `);
      raw.exec('CREATE INDEX IF NOT EXISTS beliefs_project_idx ON beliefs(project_id)');
      raw.exec('CREATE INDEX IF NOT EXISTS beliefs_type_idx ON beliefs(belief_type)');
      raw.exec('CREATE INDEX IF NOT EXISTS beliefs_status_idx ON beliefs(status)');
      raw.exec('CREATE INDEX IF NOT EXISTS beliefs_confidence_idx ON beliefs(confidence)');
      break;

    case 'belief_memory_sources':
      raw.exec(`
        CREATE TABLE IF NOT EXISTS belief_memory_sources (
          id TEXT PRIMARY KEY,
          belief_id TEXT REFERENCES beliefs(id) ON DELETE CASCADE,
          memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
          created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
          UNIQUE(belief_id, memory_id)
        );
      `);
      raw.exec('CREATE INDEX IF NOT EXISTS belief_sources_belief_idx ON belief_memory_sources(belief_id)');
      raw.exec('CREATE INDEX IF NOT EXISTS belief_sources_memory_idx ON belief_memory_sources(memory_id)');
      break;

    case 'belief_edges':
      raw.exec(`
        CREATE TABLE IF NOT EXISTS belief_edges (
          id TEXT PRIMARY KEY,
          from_belief_id TEXT REFERENCES beliefs(id) ON DELETE CASCADE,
          to_belief_id TEXT REFERENCES beliefs(id) ON DELETE CASCADE,
          edge_type TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
          UNIQUE(from_belief_id, to_belief_id, edge_type)
        );
      `);
      raw.exec('CREATE INDEX IF NOT EXISTS belief_edges_from_idx ON belief_edges(from_belief_id)');
      raw.exec('CREATE INDEX IF NOT EXISTS belief_edges_to_idx ON belief_edges(to_belief_id)');
      break;

    case 'knowledge':
      raw.exec(`
        CREATE TABLE IF NOT EXISTS knowledge (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT,
          agent_id TEXT,
          session_id TEXT,
          knowledge_kind TEXT NOT NULL,
          knowledge_type TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT,
          embedding_json TEXT,
          embedding BLOB,
          confidence REAL DEFAULT 0.5,
          confidence_level TEXT DEFAULT 'certain',
          importance_score REAL DEFAULT 0.5,
          importance_decay_rate REAL DEFAULT 30,
          last_importance_recalc INTEGER,
          normalized_key TEXT,
          reason TEXT,
          evidence_summary TEXT,
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
          superseded_by TEXT,
          contradicts_id TEXT,
          informed_by_id TEXT,
          tags TEXT,
          metadata TEXT,
          place_id TEXT,
          primary_place TEXT,
          sector TEXT DEFAULT 'general',
          tier TEXT DEFAULT 'episodic',
          is_active INTEGER DEFAULT 1,
          created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
          updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
        );
      `);
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_project_idx ON knowledge(project_id)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_kind_idx ON knowledge(knowledge_kind)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_type_idx ON knowledge(knowledge_type)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_status_idx ON knowledge(status)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_session_idx ON knowledge(session_id)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_user_idx ON knowledge(user_id)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_agent_idx ON knowledge(agent_id)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_confidence_idx ON knowledge(confidence)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_active_idx ON knowledge(is_active)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_created_idx ON knowledge(created_at)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_sector_idx ON knowledge(sector)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_tier_idx ON knowledge(tier)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_project_kind_idx ON knowledge(project_id, knowledge_kind)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_project_status_idx ON knowledge(project_id, status)');
      break;

    case 'knowledge_edges':
      raw.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_edges (
          id TEXT PRIMARY KEY,
          from_id TEXT NOT NULL,
          from_kind TEXT NOT NULL,
          to_id TEXT NOT NULL,
          to_kind TEXT NOT NULL,
          edge_type TEXT NOT NULL,
          weight REAL DEFAULT 1.0,
          metadata TEXT,
          created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
        );
      `);
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_edges_from_idx ON knowledge_edges(from_id, from_kind)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_edges_to_idx ON knowledge_edges(to_id, to_kind)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_edges_type_idx ON knowledge_edges(edge_type)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_edges_from_kind_idx ON knowledge_edges(from_kind)');
      raw.exec('CREATE INDEX IF NOT EXISTS knowledge_edges_to_kind_idx ON knowledge_edges(to_kind)');
      raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS knowledge_edges_unique ON knowledge_edges(from_id, from_kind, to_id, to_kind, edge_type)');
      break;

    default:
      throw new Error(`Cannot create unknown table: ${tableName}`);
  }
}
