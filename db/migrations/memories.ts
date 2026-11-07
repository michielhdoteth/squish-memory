/**
 * Memories table migrations
 * Uses schema definitions to generate migrations
 */

import type { Database } from 'better-sqlite3';
import { migrateTable } from '../schema/generator.js';
import { memoriesSchema } from '../schema/memories.js';
import { runEmbeddingBlobBackfill } from './embedding-blob-backfill.js';
import { runBatch6bBackfill } from './batch6b-backfill.js';
import { logger } from '../../core/logger.js';

export async function runMemoriesMigrations(sqlite: Database): Promise<void> {
  const tableCheck = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
  ).get() as { name: string } | undefined;

  if (!tableCheck) {
    logger.debug('Memories table does not exist yet, skipping migrations');
    return;
  }

  await migrateTable(sqlite, memoriesSchema);
  sqlite.exec('CREATE INDEX IF NOT EXISTS memories_valid_from_idx ON memories(valid_from)');
  await runEmbeddingBlobBackfill(sqlite);
  // Batch 6b: sector re-classification + legacy hot-tier repair (one-time,
  // marker-gated, O(1) after first successful pass).
  await runBatch6bBackfill(sqlite);
}
