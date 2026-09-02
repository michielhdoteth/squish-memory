/**
 * Migration runner - imports and runs all migrations
 *
 * Usage:
 *   import { runAllMigrations } from './migrations/index.js';
 *   await runAllMigrations(sqlite);
 */
import type { Database } from 'better-sqlite3';
/**
 * Run all v1.2.0 migrations in order
 */
export declare function runAllMigrations(sqlite: Database): Promise<void>;
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
//# sourceMappingURL=index.d.ts.map