import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { getSchema } from '../db/schema.js';
import { deserializeMetadata } from './memory/serialization.js';
import { config, detectProjectScope, normalizeProjectPath } from '../config.js';
import { createDatabaseClient } from './storage/database.js';
import { getDbClient } from './lib/db-client.js';
import { evictMemoryRuntimeState } from './memory/runtime-cache-lifecycle.js';

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The stored spellings a lookup should accept for a caller-supplied path.
 *
 * `normalizeProjectPath` is the canonical form and goes first. The two others
 * exist only to keep rows written before the write side was normalised
 * reachable, which is a read tolerance and not a rewrite: merging or re-pointing
 * those rows is an operator decision.
 *
 *  - The caller's raw string, so a row stored with the other separator style
 *    still matches no matter which style this host sends. This is what lets a
 *    forward-slash host resolve a backslash row and the reverse.
 *  - The forward-slash spelling of the canonical value on Windows, where `\`
 *    and `/` are interchangeable in path syntax. Skipped on POSIX, where `\`
 *    is a legal filename character and folding it would alias two different
 *    directories.
 *
 * All candidates go into one `IN (...)`, so the lookup keeps using
 * `projects_path_idx` instead of scanning the table.
 */
function pathLookupCandidates(path: string): string[] {
  const normalized = normalizeProjectPath(path);
  const candidates = [normalized, path];
  if (process.platform === 'win32') {
    candidates.push(normalized.replace(/\\/g, '/'));
  }
  return [...new Set(candidates)];
}

export async function getProjectByPath(path: string): Promise<ProjectRecord | null> {
  try {
    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();
    const candidates = pathLookupCandidates(path);
    const rows = await db
      .select()
      .from(schema.projects)
      .where(inArray(schema.projects.path, candidates))
      .limit(candidates.length);
    if (rows.length === 0) return null;
    // When a directory has both a canonical row and a legacy separator variant,
    // the canonical row wins, so the memories already attached to it are the
    // ones that come back rather than the ones from the shadowed duplicate.
    const canonical = candidates[0];
    const row = rows.find((candidate: any) => candidate.path === canonical) ?? rows[0];
    return normalizeProject(row);
  } catch (error: any) {
    throw error;
  }
}

export async function ensureProject(path?: string): Promise<ProjectRecord | null> {
  if (!path) return null;
  const existing = await getProjectByPath(path);
  if (existing) return existing;
  // Create new project when explicit path is provided
  return createProject(path);
}

/**
 * Resolve the project scope a request should use AND guarantee the `projects`
 * row exists before the request is dispatched.
 *
 * Write paths already self-heal: `rememberMemory` uses `getOrCreateProject` and
 * `resolveProjectScope` uses `ensureProject`. Every read path instead goes
 * through `requireProject`, which throws `ProjectNotFoundError` when no row
 * matches the path. Because the MCP layer always produces a truthy scope
 * (`resolveProjectPath` -> `detectProjectScope`), recall and bulk forget failed
 * on every call for any working directory that had never been written to, and
 * the FTS5 keyword leg silently reported zero rows because its catch-all
 * swallowed the throw.
 *
 * Calling this once at the dispatch boundary fixes the read fan-out
 * (memory-search, keyword-search, vector-search, belief-search) at once FOR MCP
 * TOOL CALLS, while leaving `requireProject` intact for the invariants it
 * genuinely guards (context-window, entities, conversations, learnings,
 * trust-state).
 *
 * Known limitation, deliberately not fixed here: this only holds for the MCP
 * transport. `mcp/index.ts` is the only caller of `ensureProjectScope`; the CLI,
 * `SquishRuntime`, and direct SDK consumers that pass an unregistered path still
 * reach `requireProject` and still throw `ProjectNotFoundError` on every read.
 * Moving the `ensureProject` call into `SquishRuntime.search` would cover those
 * transports too, but it changes read behaviour for every SDK consumer and
 * belongs in its own change with its own decision record.
 *
 * Idempotent: an already-registered path is a single read, no write.
 *
 * @returns the resolved project path, or undefined when there is no scope.
 */
export async function ensureProjectScope(projectArg?: string): Promise<string | undefined> {
  const explicit = typeof projectArg === 'string' && projectArg.length > 0 ? projectArg : undefined;
  const projectPath = explicit ?? detectProjectScope() ?? undefined;
  if (!projectPath) return undefined;
  await ensureProject(projectPath);
  return projectPath;
}

export class ProjectNotFoundError extends Error {
  constructor(path: string) {
    super(`Project not found: ${path}`);
    this.name = 'ProjectNotFoundError';
  }
}

export async function requireProject(path: string): Promise<ProjectRecord> {
  const project = await getProjectByPath(path);
  if (!project) {
    throw new ProjectNotFoundError(path);
  }
  return project;
}

export async function getOrCreateProject(path?: string): Promise<ProjectRecord | null> {
  if (!path) return null;
  const existing = await getProjectByPath(path);
  if (existing) return existing;
  // Create new project when explicit path is provided
  return createProject(path);
}

async function createProject(path: string): Promise<ProjectRecord> {
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();
  const id = randomUUID();
  // Normalise before insert, not after. `detectProjectScope()` already reports
  // the normalised form, so storing the caller's raw string made a project
  // unreadable the moment the host and the agent disagreed about separator
  // style or about relative vs absolute. `normalizeProjectPath` is the same
  // rule `detectProjectRoot()` uses, so the two ends cannot drift apart.
  const normalizedPath = normalizeProjectPath(path);
  // Splitting on both separators handles paths that arrive from Windows clients
  // and paths that did not need resolving (a logical scope id has no separator
  // and becomes its own name).
  const name = normalizedPath.split(/[\\/]+/).filter(Boolean).pop() || 'default';
  const metadata = { source: 'mcp' };
  await db.insert(schema.projects).values({ id, name, path: normalizedPath, metadata: JSON.stringify(metadata) });
  return { id, name, path: normalizedPath, metadata };
}

function normalizeProject(row: any): ProjectRecord {
  const metadata = deserializeMetadata(row.metadata ?? null);
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    description: row.description ?? null,
    metadata,
  };
}

export async function getAllProjects(): Promise<ProjectRecord[]> {
  try {
    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();
    const rows = await db.select().from(schema.projects);
    return rows.map(normalizeProject);
  } catch (error: any) {
    throw error;
  }
}

export async function getProjectById(id: string): Promise<ProjectRecord | null> {
  try {
    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();
    const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return normalizeProject(row);
  } catch (error: any) {
    throw error;
  }
}

/**
 * Permanently delete one local SQLite project and its owned data. SQLite
 * cascades project-owned records, removes every edge referencing erased
 * project nodes, and FTS triggers clean projections.
 * Team/PostgreSQL project deletion is intentionally unsupported until its ACL,
 * audit, and transaction contract is implemented separately.
 */
export async function deleteProject(id: string): Promise<boolean> {
  if (!id?.trim()) throw new Error('Project ID cannot be empty');
  if (config.mode !== 'local') throw new Error('Project deletion is supported only in local SQLite mode');

  const { raw } = await getDbClient();
  const sqlite = (raw as any).$client;
  if (!sqlite || typeof sqlite.exec !== 'function') {
    throw new Error('Project deletion requires a local SQLite connection');
  }

  sqlite.exec('BEGIN IMMEDIATE');
  let deletedMemoryIds: string[] = [];
  try {
    const project = sqlite.prepare('SELECT id, path FROM projects WHERE id = ?').get(id.trim()) as { id: string; path: string } | undefined;
    if (!project) {
      sqlite.exec('COMMIT');
      return false;
    }
    const hasLegacyAssociations = Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_associations'").get());
    sqlite.exec(`
      CREATE TEMP TABLE _squish_project_delete_nodes (id TEXT PRIMARY KEY);
      CREATE TEMP TABLE _squish_project_delete_memories (id TEXT PRIMARY KEY);
    `);
    for (const table of ['memories', 'knowledge', 'entities', 'places', 'conversations', 'namespaces', 'skills', 'learnings', 'beliefs', 'strategies']) {
      const tableExists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!tableExists) continue;
      sqlite.prepare(`INSERT OR IGNORE INTO _squish_project_delete_nodes SELECT id FROM ${table} WHERE project_id = ?`).run(project.id);
    }
    sqlite.prepare('INSERT INTO _squish_project_delete_memories SELECT id FROM memories WHERE project_id = ?').run(project.id);
    deletedMemoryIds = (sqlite.prepare('SELECT id FROM _squish_project_delete_memories').all() as Array<{ id: string }>)
      .map((row) => row.id);
    sqlite.prepare(`
      DELETE FROM knowledge_edges
      WHERE from_id IN (SELECT id FROM _squish_project_delete_nodes)
        OR to_id IN (SELECT id FROM _squish_project_delete_nodes)
    `).run();
    // These stores intentionally use polymorphic asset IDs rather than foreign
    // keys, so project cascades cannot remove grants for erased memory/graph nodes.
    sqlite.prepare(`
      DELETE FROM agent_loadouts
      WHERE asset_type IN ('memory', 'skill', 'belief', 'strategy', 'learning')
        AND asset_id IN (SELECT id FROM _squish_project_delete_nodes)
    `).run();
    sqlite.prepare(`
      DELETE FROM visibility_rules
      WHERE asset_type IN ('memory', 'skill', 'belief', 'strategy', 'learning')
        AND asset_id IN (SELECT id FROM _squish_project_delete_nodes)
    `).run();
    for (const [table, predicate] of [
      ['belief_memory_sources', 'belief_id IN (SELECT id FROM _squish_project_delete_nodes) OR memory_id IN (SELECT id FROM _squish_project_delete_memories)'],
      ['belief_edges', 'from_belief_id IN (SELECT id FROM _squish_project_delete_nodes) OR to_belief_id IN (SELECT id FROM _squish_project_delete_nodes)'],
      ['strategy_edges', 'from_strategy_id IN (SELECT id FROM _squish_project_delete_nodes) OR to_strategy_id IN (SELECT id FROM _squish_project_delete_nodes)'],
      ['strategy_belief_edges', 'strategy_id IN (SELECT id FROM _squish_project_delete_nodes) OR belief_id IN (SELECT id FROM _squish_project_delete_nodes)'],
    ]) {
      const tableExists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (tableExists) sqlite.prepare(`DELETE FROM ${table} WHERE ${predicate}`).run();
    }
    for (const table of ['beliefs', 'strategies']) {
      const tableExists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (tableExists) sqlite.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(project.id);
    }
    if (hasLegacyAssociations) {
      sqlite.prepare(`
        DELETE FROM memory_associations
        WHERE from_memory_id IN (SELECT id FROM _squish_project_delete_memories)
          OR to_memory_id IN (SELECT id FROM _squish_project_delete_memories)
      `).run();
    }
    const sourcePathCollation = process.platform === 'win32' ? ' COLLATE NOCASE' : '';
    sqlite.prepare(`
      DELETE FROM agent_session_cache
      WHERE replace(source_path, '/', char(92))${sourcePathCollation} = replace(?, '/', char(92))${sourcePathCollation}
        OR substr(replace(source_path, '/', char(92)), 1, length(replace(?, '/', char(92))) + 1)${sourcePathCollation}
          = (replace(?, '/', char(92)) || char(92))${sourcePathCollation}
    `).run(project.path, project.path, project.path);
    sqlite.prepare(`
      DELETE FROM memory_snapshots
      WHERE memory_id IN (SELECT id FROM _squish_project_delete_memories)
    `).run();
    sqlite.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    const stillExists = sqlite.prepare('SELECT 1 FROM projects WHERE id = ?').get(project.id);
    if (stillExists) throw new Error('Project changed during deletion');
    const danglingEdges = sqlite.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_edges
      WHERE from_id IN (SELECT id FROM _squish_project_delete_nodes)
        OR to_id IN (SELECT id FROM _squish_project_delete_nodes)
    `).get() as { count: number };
    if (Number(danglingEdges.count) > 0) throw new Error('Project deletion left graph edges referencing erased nodes');
    if (hasLegacyAssociations) {
      const danglingAssociations = sqlite.prepare(`
        SELECT COUNT(*) AS count FROM memory_associations
        WHERE from_memory_id IN (SELECT id FROM _squish_project_delete_memories)
          OR to_memory_id IN (SELECT id FROM _squish_project_delete_memories)
      `).get() as { count: number };
      if (Number(danglingAssociations.count) > 0) throw new Error('Project deletion left associations touching erased memories');
    }
    sqlite.exec('DROP TABLE _squish_project_delete_nodes; DROP TABLE _squish_project_delete_memories;');
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
  await evictMemoryRuntimeState(deletedMemoryIds);
  return true;
}
