/**
 * Teams table migrations
 * Creates team-related tables for multi-tenant memory sharing
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../core/logger.js';

export async function runTeamsMigrations(sqlite: Database): Promise<void> {
  // Create teams table if it doesn't exist
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )
    `);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS teams_slug_idx ON teams(slug)`);
    logger.info('Migration: Created teams table');
  } catch (error: any) {
    logger.warn(`Migration: teams table: ${error.message}`);
  }

  // Create team_members table if it doesn't exist
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS team_members (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(team_id, user_id)
      )
    `);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS team_members_team_idx ON team_members(team_id)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members(user_id)`);
    logger.info('Migration: Created team_members table');
  } catch (error: any) {
    logger.warn(`Migration: team_members table: ${error.message}`);
  }

  // Create team_invitations table if it doesn't exist
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS team_invitations (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        code TEXT NOT NULL UNIQUE,
        expires_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )
    `);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS team_invitations_team_idx ON team_invitations(team_id)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS team_invitations_code_idx ON team_invitations(code)`);
    logger.info('Migration: Created team_invitations table');
  } catch (error: any) {
    logger.warn(`Migration: team_invitations table: ${error.message}`);
  }

  // Create team_shares table if it doesn't exist
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS team_shares (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        shared_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission TEXT NOT NULL DEFAULT 'read',
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(memory_id, team_id)
      )
    `);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS team_shares_memory_idx ON team_shares(memory_id)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS team_shares_team_idx ON team_shares(team_id)`);
    logger.info('Migration: Created team_shares table');
  } catch (error: any) {
    logger.warn(`Migration: team_shares table: ${error.message}`);
  }
}
