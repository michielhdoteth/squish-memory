/**
 * Memory Migration Module
 * Migrate memories between .squish directories/databases
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger.js';
import { isStrictTrustPolicy, TrustBoundaryError } from '../acl/trust-policy.js';

export interface MigrateOptions {
  dryRun?: boolean;
  deleteSource?: boolean;
}

export interface MigrateResult {
  memoriesCopied: number;
  observationsCopied: number;
  associationsCopied: number;
  projectsMapped: number;
  sourceDeleted?: boolean;
  message: string;
}

type SqliteRow = Record<string, any>;

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Migrate memories from one .squish directory to another
 */
export async function migrateMemories(
  sourceDir: string,
  targetDir: string,
  options: MigrateOptions = {}
): Promise<MigrateResult> {
  if (isStrictTrustPolicy()) {
    throw new TrustBoundaryError('Memory migration is disabled under strict trust until imported rows can be owner-attested');
  }

  const { dryRun = false, deleteSource = false } = options;
  
  const sourceDbPath = join(sourceDir, 'squish.db');
  const targetDbPath = join(targetDir, 'squish.db');
  
  if (!existsSync(sourceDbPath)) {
    throw new Error(`Source database not found: ${sourceDbPath}`);
  }
  if (!existsSync(targetDbPath)) {
    throw new Error(`Target database not found: ${targetDbPath}`);
  }

  const sourceDb = new Database(sourceDbPath, { readonly: true });
  const targetDb = new Database(targetDbPath);
  targetDb.pragma('foreign_keys = ON');

  try {
    const sourceProjects = sourceDb.prepare('SELECT * FROM projects').all() as SqliteRow[];
    const projectIdMap = new Map<string, string>();
    const targetProjectByPath = targetDb.prepare(
      'SELECT id FROM projects WHERE path = ? LIMIT 1'
    );
    const insertProject = targetDb.prepare(`
      INSERT INTO projects (id, name, path, description, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const project of sourceProjects) {
      const existing = targetProjectByPath.get(project.path) as { id: string } | undefined;

      if (existing?.id) {
        projectIdMap.set(project.id, existing.id);
        continue;
      }

      const newId = randomUUID();
      if (!dryRun) {
        insertProject.run(
          newId,
          project.name || 'migrated',
          project.path,
          project.description ?? null,
          project.metadata ?? null,
          project.created_at ?? Math.floor(Date.now() / 1000),
          project.updated_at ?? Math.floor(Date.now() / 1000)
        );
      }
      projectIdMap.set(project.id, newId);
    }

    const sourceMemories = sourceDb.prepare('SELECT * FROM memories').all() as SqliteRow[];
    const insertMemory = targetDb.prepare(`
      INSERT INTO memories (
        id, project_id, type, content, summary, source, confidence, confidence_level,
        tags, metadata, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let memoriesCopied = 0;

    for (const mem of sourceMemories) {
      const newProjectId = projectIdMap.get(mem.project_id);

      if (!newProjectId) {
        logger.warn(`Skipping memory ${mem.id}: no project mapping found`);
        continue;
      }

      if (!dryRun) {
        const existingTags = parseJsonField<string[]>(mem.tags, []);
        const metadata = parseJsonField<Record<string, unknown>>(mem.metadata, {});

        insertMemory.run(
          randomUUID(),
          newProjectId,
          mem.type,
          mem.content,
          mem.summary ?? null,
          mem.source || 'migrated',
          mem.confidence ?? 50,
          mem.confidence_level || 'speculative',
          JSON.stringify([...existingTags, 'imported']),
          JSON.stringify({
            ...metadata,
            migratedAt: new Date().toISOString(),
            originalId: mem.id,
          }),
          mem.is_active ?? 1,
          mem.created_at ?? Math.floor(Date.now() / 1000),
          mem.updated_at ?? Math.floor(Date.now() / 1000)
        );
      }
      memoriesCopied++;
    }

    const sourceLearnings = sourceDb.prepare('SELECT * FROM learnings').all() as SqliteRow[];
    const insertLearning = targetDb.prepare(`
      INSERT INTO learnings (
        id, project_id, type, action, target, summary, details, is_imported, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let learningsCopied = 0;

    for (const learn of sourceLearnings) {
      const newProjectId = projectIdMap.get(learn.project_id);
      if (!newProjectId) continue;

      if (!dryRun) {
        insertLearning.run(
          randomUUID(),
          newProjectId,
          learn.type,
          learn.action,
          learn.target ?? null,
          learn.summary,
          learn.details ?? null,
          1,
          learn.created_at ?? Math.floor(Date.now() / 1000)
        );
      }
      learningsCopied++;
    }

    const hasSourceAssociations = Boolean(sourceDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_associations'").get());
    const sourceAssoc = hasSourceAssociations
      ? sourceDb.prepare('SELECT * FROM memory_associations').all() as SqliteRow[]
      : [];
    let associationsCopied = 0;

    if (!dryRun && sourceAssoc.length > 0) {
      logger.warn(`Note: ${sourceAssoc.length} associations not migrated (requires ID mapping)`);
    }

    let sourceDeleted = false;
    if (!dryRun && deleteSource && memoriesCopied > 0) {
      logger.warn('Source deletion not implemented - requires manual removal');
    }

    return {
      memoriesCopied,
      observationsCopied: learningsCopied,
      associationsCopied,
      projectsMapped: projectIdMap.size,
      sourceDeleted,
      message: dryRun
        ? 'Dry run complete - no changes made'
        : `Successfully migrated ${memoriesCopied} memories, ${learningsCopied} learnings`,
    };
  } finally {
    sourceDb.close();
    targetDb.close();
  }
}
