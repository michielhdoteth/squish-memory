/**
 * Migration runner - imports and runs all migrations
 * 
 * Usage:
 *   import { runAllMigrations } from './migrations/index.js';
 *   await runAllMigrations(sqlite);
 */

import type { Database } from 'better-sqlite3';
import { runPlacesMigrations } from './places.js';
import { runProjectMigrations } from './projects.js';
import { runMemoriesMigrations } from './memories.js';
import { runLearningsMigrations } from './learnings.js';
import { runCoreMemoryMigrations } from './core-memory.js';
import { runAssociationsMigrations } from './associations.js';
import { runMemoryPlacesMigrations } from './memory-places.js';
import { runIndexMigrations } from './indexes.js';
import { runFtsMigrations } from './fts.js';
import { runMaintenanceMigrations } from './maintenance.js';
import { runEntitiesMigrations } from './entities.js';
import { runTeamsMigrations } from './teams.js';
import { runKnowledgeMigrations } from './knowledge.js';

/**
 * Run all v1.2.0 migrations in order
 */
export async function runAllMigrations(sqlite: Database): Promise<void> {
  // Run each migration in dependency order
  await runProjectMigrations(sqlite);
  await runPlacesMigrations(sqlite);
  await runMemoriesMigrations(sqlite);
  await runLearningsMigrations(sqlite);
  await runEntitiesMigrations(sqlite);
  await runCoreMemoryMigrations(sqlite);
  await runAssociationsMigrations(sqlite);
  await runMemoryPlacesMigrations(sqlite);
  await runIndexMigrations(sqlite);
  await runFtsMigrations(sqlite);
  await runMaintenanceMigrations(sqlite);
  await runTeamsMigrations(sqlite);
  await runKnowledgeMigrations(sqlite);
}

// Re-export for direct usage if needed
export { runPlacesMigrations } from './places.js';
export { runProjectMigrations } from './projects.js';
export { runMemoriesMigrations } from './memories.js';
export { runLearningsMigrations } from './learnings.js';
export { runCoreMemoryMigrations } from './core-memory.js';
export { runAssociationsMigrations } from './associations.js';
export { runMemoryPlacesMigrations } from './memory-places.js';
export { runIndexMigrations } from './indexes.js';
export { runFtsMigrations } from './fts.js';
export { runMaintenanceMigrations } from './maintenance.js';
export { runEntitiesMigrations } from './entities.js';
export { runTeamsMigrations } from './teams.js';
export { runKnowledgeMigrations } from './knowledge.js';
