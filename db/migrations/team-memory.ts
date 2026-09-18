/**
 * Team Memory migration
 * Adds team_id column to memories table for team-scoped memory support.
 * Part of the "two brains" architecture: Personal Memory + Team Memory.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../core/logger.js';

export async function runTeamMemoryMigration(sqlite: Database): Promise<void> {
  // Add team_id column to memories table if it doesn't exist
  try {
    const columns = sqlite.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
    const hasTeamId = columns.some((col) => col.name === 'team_id');

    if (!hasTeamId) {
      sqlite.exec(`
        ALTER TABLE memories ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL
      `);
      logger.info('Migration: Added team_id column to memories table');
    }
  } catch (error: any) {
    logger.warn(`Migration: team_id column: ${error.message}`);
  }

  // Add index for team_id on memories if it doesn't exist
  try {
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS memories_team_idx ON memories(team_id)
    `);
    logger.info('Migration: Created memories_team_idx index');
  } catch (error: any) {
    logger.warn(`Migration: memories_team_idx index: ${error.message}`);
  }
}
