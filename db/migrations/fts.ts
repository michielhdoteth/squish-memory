/**
 * FTS (Full-Text Search) table migrations
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../core/logger.js';

let ftsMigrationSavepointSequence = 0;

export async function runFtsMigrations(sqlite: Database): Promise<void> {
  const ftsTableCheck = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
  ).get() as { name: string } | undefined;

  if (!ftsTableCheck) return;

  const ftsSql = String((sqlite.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'"
  ).get() as { sql?: string } | undefined)?.sql ?? '').toLowerCase();
  const hasPorter = ftsSql.includes("tokenize='porter unicode61'") || ftsSql.includes('tokenize = \'porter unicode61\'');
  let rankConfig: string | undefined;
  try {
    rankConfig = (sqlite.prepare("SELECT v FROM memories_fts_config WHERE k = 'rank'").get() as { v?: string } | undefined)?.v;
  } catch {
    // Older FTS5 tables may not have a rank config table entry yet.
  }
  if (hasPorter && rankConfig === 'bm25(1.0, 2.0, 3.0)') return;

  logger.info('Migration: Rebuilding memories_fts with Porter stemming and BM25 weights...');
  const ownsTransaction = !sqlite.inTransaction;
  const savepoint = `squish_fts_migration_${++ftsMigrationSavepointSequence}`;
  try {
    sqlite.exec(ownsTransaction ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    sqlite.exec('DROP TRIGGER IF EXISTS memories_ai');
    sqlite.exec('DROP TRIGGER IF EXISTS memories_ad');
    sqlite.exec('DROP TRIGGER IF EXISTS memories_au');
    sqlite.exec('DROP TABLE IF EXISTS memories_fts');
    sqlite.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content, tags, summary,
        content='memories', content_rowid='rowid',
        tokenize='porter unicode61'
      );
      INSERT INTO memories_fts(memories_fts, rank) VALUES('rank', 'bm25(1.0, 2.0, 3.0)');
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags, summary)
        VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
        VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
        VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
        INSERT INTO memories_fts(rowid, content, tags, summary)
        VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
      END;
      INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
    `);
    sqlite.exec(ownsTransaction ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
    logger.info('Migration: memories_fts Porter/BM25 index rebuilt');
  } catch (error) {
    try {
      if (ownsTransaction) sqlite.exec('ROLLBACK');
      else {
        sqlite.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'FTS migration failed and could not roll back cleanly');
    }
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`Migration: Could not upgrade memories_fts: ${msg}`);
    throw error;
  }
}
