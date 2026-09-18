/**
 * Learnings table schema for migrations
 * Column definitions for ALTER TABLE migrations
 */

import type { TableSchema } from './generator.js';

export const learningsSchema: TableSchema = {
  name: 'learnings',
  columns: {
    id: { type: 'TEXT', primary: true },
    project_id: { type: 'TEXT' },
    conversation_id: { type: 'TEXT' },
    type: { type: 'TEXT' },
    action: { type: 'TEXT' },
    target: { type: 'TEXT' },
    summary: { type: 'TEXT' },
    details: { type: 'TEXT' },
    embedding_json: { type: 'TEXT' },
    embedding: { type: 'BLOB' },
    memory_id: { type: 'TEXT' },
    folder_path: { type: 'TEXT' },
    project_path: { type: 'TEXT' },
    is_private: { type: 'INTEGER', default: '0' },
    has_secrets: { type: 'INTEGER', default: '0' },
    relevance_score: { type: 'INTEGER', default: '50' },
    category: { type: 'TEXT' },
    importance: { type: 'INTEGER', default: '50' },
    confidence: { type: 'INTEGER', default: '50' },
    metadata: { type: 'TEXT' },
    is_imported: { type: 'INTEGER', default: '0' },
    // UAM: Agent integration columns
    agent_id: { type: 'TEXT' },
    tool_name: { type: 'TEXT' },
    session_id: { type: 'TEXT' },
    created_at: { type: 'INTEGER' },
  },
};