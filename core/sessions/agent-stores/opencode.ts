/**
 * OpenCode session store - implements `AgentSessionStore`.
 *
 * Read-only access to OpenCode's persisted local session database
 * (`opencode.db`) so that `squish sessions list|search|show|related`
 * can return past sessions. The CLI and local integrations use this
 * store; each supported host has its own session adapter.
 *
 * Why read opencode.db directly:
 *   - OpenCode's runtime session API is scoped to the running host
 *     process, while the local database persists session history across
 *     process restarts.
 *   - Reading that persisted store lets local tools search past sessions
 *     by query and project without requiring a running OpenCode process.
 *
 * Performance notes:
 *   - The default text search limits part types and, when scoped, walks
 *     matching sessions through the session-to-part index.
 *   - `ensureSidecarFts()` prepares an optional local index explicitly;
 *     interactive search never builds it implicitly.
 *
 * Public surface consumed by:
 *   - core/sessions/store.ts (the public sessions surface)
 *   - packages/cli/src/commands/sessions.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { normalizeDirectoryScope, sqliteDirectoryScope } from './path-scope.js';

// bun:sqlite is bun-only. Load the constructor lazily so this module stays
// importable under node/tsx; every open site catches and degrades to null.
type Database = any;
let DatabaseCtor: any = null;
try {
  // @ts-ignore - bun:sqlite module not found in types but works at runtime
  DatabaseCtor = (await import('bun:sqlite')).default;
} catch {
  DatabaseCtor = null;
}

import { logger } from '../../logger.js';
import type { Chunk, ChunkResult, SessionGroup } from '../types.js';
import { markSessionSearchTruncated, tokenizeSessionSearchQuery, type AgentSessionStore, type AgentName, type SessionSearchBudget } from './types.js';

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

const OPENCODE_SIDECAR_CONTENT_VERSION = 2;
const MAX_GLOBAL_FTS_CANDIDATES = 10_000;

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------

/**
 * Default location of OpenCode's persisted local database. The path uses
 * XDG_DATA_HOME when configured, otherwise `~/.local/share/opencode/opencode.db`.
 *
 * Tests can set `SQUISH_OPENCODE_DISABLED=1` to force the opencode
 * source to be unavailable even if a real opencode.db exists on the
 * machine. The CLI does NOT set this; the user always gets the real
 * opencode.db unless they opt out.
 */
export function defaultOpenCodeDbPath(): string {
  if (process.env.SQUISH_OPENCODE_DISABLED === '1') {
    return path.join(os.homedir(), '.squish', 'opencode-disabled-for-tests.db');
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  const dataDir = path.join(dataHome, 'opencode');
  const configuredDb = process.env.OPENCODE_DB?.trim();
  if (configuredDb) {
    if (configuredDb === ':memory:') return configuredDb;
    return path.isAbsolute(configuredDb) ? configuredDb : path.resolve(dataDir, configuredDb);
  }
  return path.join(dataDir, 'opencode.db');
}

/**
 * Sidecar FTS5 index location. Preparation is an explicit operation.
 */
export function defaultSidecarPath(): string {
  return path.join(os.homedir(), '.squish', 'opencode-fts.db');
}

function sourceFingerprint(filePath: string): string | null {
  try {
    const files = [filePath, `${filePath}-wal`, `${filePath}-journal`];
    const fingerprint = files.map((candidate) => {
      try {
        const stat = fs.statSync(candidate, { bigint: true });
        // Timestamps are not sufficient on every filesystem: an in-place
        // SQLite update can preserve size and restore mtime, and Windows
        // ctime commonly reflects creation time. Include fixed-size SQLite
        // content markers so a same-path source rewrite cannot keep an old
        // FTS sidecar looking current. The database header contains SQLite's
        // change counter; the WAL/journal tail captures the latest frame/page.
        const fd = fs.openSync(candidate, 'r');
        let contentMarker: string;
        try {
          const first = Buffer.alloc(Number(stat.size < 100n ? stat.size : 100n));
          fs.readSync(fd, first, 0, first.length, 0);
          const tailLength = Number(stat.size < 64n ? stat.size : 64n);
          const tail = Buffer.alloc(tailLength);
          fs.readSync(fd, tail, 0, tail.length, Math.max(0, Number(stat.size) - tailLength));
          contentMarker = createHash('sha256').update(first).update(tail).digest('hex');
        } finally {
          fs.closeSync(fd);
        }
        return [stat.mtimeNs.toString(), stat.size.toString(), stat.ctimeNs.toString(), String(stat.dev), String(stat.ino), contentMarker];
      } catch {
        return null;
      }
    });
    return fingerprint[0] ? JSON.stringify(fingerprint) : null;
  } catch {
    return null;
  }
}

function sidecarMatchesSource(sourcePath: string, sidecarPath: string): boolean {
  const fingerprint = sourceFingerprint(sourcePath);
  if (!fingerprint || !fs.existsSync(sidecarPath)) return false;
  let db: Database | null = null;
  try {
    db = new (DatabaseCtor as any)(sidecarPath, { readonly: true });
    const row = db.query('SELECT source_fingerprint, content_version FROM index_meta WHERE id = 1').get() as
      { source_fingerprint: string; content_version: number } | null;
    return row?.source_fingerprint === fingerprint && row.content_version === OPENCODE_SIDECAR_CONTENT_VERSION;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export interface OpenCodeStoreOptions {
  /** Override the DB path (default: defaultOpenCodeDbPath()) */
  dbPath?: string;
  /** Override the sidecar path (default: defaultSidecarPath()) */
  sidecarPath?: string;
  /** Read-only connection (default: true) */
  readonly?: boolean;
  /** Internal batch-size control for the explicit resumable FTS builder. */
  indexBatchSize?: number;
}

export interface OpenCodeTranscriptMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageIndex: number;
  sourceFingerprint: string;
}

export interface OpenCodeTranscriptSnapshot {
  sessionId: string;
  projectPath: string;
  messages: OpenCodeTranscriptMessage[];
}

/**
 * Read a bounded, uncached transcript snapshot for role-aware capture.
 * Roles come only from the structured `message.data.role` field. Text is
 * assembled from text parts in source order; tool/reasoning payloads are
 * intentionally excluded. Every invocation opens a fresh read-only handle,
 * so committed WAL updates and source edits cannot be hidden by the search cache.
 */
export function readOpenCodeTranscript(
  sessionId: string,
  opts: OpenCodeStoreOptions = {},
): OpenCodeTranscriptSnapshot | null {
  if (!sessionId.trim() || sessionId.length > 256) return null;
  const dbPath = opts.dbPath ?? defaultOpenCodeDbPath();
  if (!fs.existsSync(dbPath)) return null;

  let db: Database | null = null;
  try {
    // Keep this reader independent from the long-lived search connection.
    // bun:sqlite's read-only connection observes committed WAL frames.
    db = new (DatabaseCtor as any)(dbPath, { readonly: true });
    const session = db.query('SELECT id, directory FROM session WHERE id = ?').get(sessionId) as
      { id: string; directory: string } | null;
    if (!session || typeof session.directory !== 'string' || !session.directory.trim()) return null;

    const rows = db.query(`
      SELECT id, session_id, time_created, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC, id ASC
      LIMIT 201
    `).all(sessionId) as Array<{ id: string; session_id: string; time_created: number; data: string }>;
    if (rows.length > 200) return null;

    const messages: OpenCodeTranscriptMessage[] = [];
    let partRowsRead = 0;
    for (const [messageIndex, row] of rows.entries()) {
      if (row.session_id !== sessionId || typeof row.data !== 'string') return null;
      let metadata: unknown;
      try { metadata = JSON.parse(row.data); } catch { return null; }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
      const role = (metadata as { role?: unknown }).role;
      if (typeof role !== 'string' || !['user', 'assistant', 'system'].includes(role)) continue;

      const parts = db.query(`
        SELECT data FROM part
        WHERE message_id = ? AND session_id = ?
        ORDER BY time_created ASC, id ASC
        LIMIT 201
      `).all(row.id, sessionId) as Array<{ data: string }>;
      partRowsRead += parts.length;
      if (parts.length > 200 || partRowsRead > 2_000) return null;

      const textParts: string[] = [];
      for (const part of parts) {
        let value: unknown;
        try { value = JSON.parse(part.data); } catch { return null; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const typed = value as { type?: unknown; text?: unknown };
        if (typed.type === 'text' && typeof typed.text === 'string') textParts.push(typed.text);
      }
      const content = textParts.join('\n').trim();
      if (!content) continue;
      if (content.length > 20_000) return null;
      const sourceFingerprint = createHash('sha256')
        .update(JSON.stringify(['opencode-message-v1', sessionId, session.directory, messageIndex, row.time_created, role, content]))
        .digest('hex');
      messages.push({ role: role as OpenCodeTranscriptMessage['role'], content, messageIndex, sourceFingerprint });
    }
    return { sessionId, projectPath: session.directory, messages };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Connection cache
// ---------------------------------------------------------------------------

interface CachedDb {
  db: Database;
  dbPath: string;
  readonly: boolean;
  sourceFingerprint: string;
}

let cached: CachedDb | null = null;

function getDb(opts: OpenCodeStoreOptions = {}): Database | null {
  const dbPath = opts.dbPath ?? defaultOpenCodeDbPath();
  if (!fs.existsSync(dbPath)) return null;

  const readonly = opts.readonly !== false;
  const fingerprint = sourceFingerprint(dbPath);
  if (!fingerprint) return null;

  if (cached && cached.dbPath === dbPath && cached.readonly === readonly && cached.sourceFingerprint === fingerprint) {
    return cached.db;
  }

  try {
    if (cached) {
      try { cached.db.close(); } catch { /* ignore */ }
      cached = null;
    }
    const db = new (DatabaseCtor as any)(dbPath, readonly ? { readonly: true } : undefined);
    cached = { db, dbPath, readonly, sourceFingerprint: fingerprint };
    return db;
  } catch (err) {
    logger.debug('[opencode-store] failed to open database', { errorType: errorType(err) });
    return null;
  }
}

export function closeOpenCodeDb(): void {
  if (cached) {
    try { cached.db.close(); } catch { /* ignore */ }
    cached = null;
  }
}

// ---------------------------------------------------------------------------
// Health / discovery
// ---------------------------------------------------------------------------

export interface OpenCodeDbStatus {
  ok: boolean;
  path: string | null;
  size_bytes: number | null;
  session_count: number | null;
  message_count: number | null;
  part_count: number | null;
  error?: string;
}

export function opencodeDbStatus(opts: OpenCodeStoreOptions = {}): OpenCodeDbStatus {
  const dbPath = opts.dbPath ?? defaultOpenCodeDbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      path: null,
      size_bytes: null,
      session_count: null,
      message_count: null,
      part_count: null,
      error: `OpenCode db not found at ${dbPath}`,
    };
  }
  const stat = fs.statSync(dbPath);
  const db = getDb(opts);
  if (!db) {
    return {
      ok: false,
      path: dbPath,
      size_bytes: stat.size,
      session_count: null,
      message_count: null,
      part_count: null,
      error: 'failed to open db',
    };
  }
  try {
    const sessions = db.query('SELECT COUNT(*) as n FROM session').get() as { n: number } | null;
    const messages = db.query('SELECT COUNT(*) as n FROM message').get() as { n: number } | null;
    const parts = db.query('SELECT COUNT(*) as n FROM part').get() as { n: number } | null;
    return {
      ok: true,
      path: dbPath,
      size_bytes: stat.size,
      session_count: sessions?.n ?? 0,
      message_count: messages?.n ?? 0,
      part_count: parts?.n ?? 0,
    };
  } catch (err) {
    return {
      ok: false,
      path: dbPath,
      size_bytes: stat.size,
      session_count: null,
      message_count: null,
      part_count: null,
      error: String(err),
    };
  }
}

/** Cheap readiness check for interactive search; never counts a large transcript database. */
export function opencodeDbAvailability(opts: OpenCodeStoreOptions = {}) {
  const dbPath = opts.dbPath ?? defaultOpenCodeDbPath();
  if (!fs.existsSync(dbPath)) return { ok: false as const, path: dbPath, error: 'opencode.db not found' };
  const db = getDb(opts);
  if (!db) return { ok: false as const, path: dbPath, error: 'failed to open opencode.db' };
  try {
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'part')").all() as Array<{ name: string }>).map((row) => row.name));
    if (!tables.has('session') || !tables.has('part')) {
      return { ok: false as const, path: dbPath, error: 'opencode.db is missing session or part tables' };
    }
    return { ok: true as const, path: dbPath };
  } catch {
    return { ok: false as const, path: dbPath, error: 'failed to inspect opencode.db schema' };
  }
}

// ---------------------------------------------------------------------------
// Row -> SessionGroup mapping
// ---------------------------------------------------------------------------

interface OpenCodeSessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  slug: string;
  directory: string;
  title: string;
  version: string;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
  time_created: number;
  time_updated: number;
  agent: string | null;
  model: string | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

function epochToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function deriveProjectName(directory: string): string {
  // Extract the last meaningful directory name from a path
  // For paths ending in a leaf repo, use the leaf.
  if (!directory) return '';
  const norm = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm === '/' || /^[A-Z]:$/.test(norm)) return directory;
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] || directory;
}

function sessionRowToGroup(row: OpenCodeSessionRow, chunkCount?: number): SessionGroup {
  const project = deriveProjectName(row.directory);
  const started = epochToIso(row.time_created);
  const updated = epochToIso(row.time_updated);
  return {
    session_id: row.id,
    title: row.title || row.slug || row.id,
    project,
    repo_path: row.directory,
    branch: '', // OpenCode does not store branch info
    agent: (row.agent || 'opencode') as SessionGroup['agent'],
    started_at: started,
    ended_at: updated !== started ? updated : null,
    status: 'completed',
    chunk_count: chunkCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// List sessions
// ---------------------------------------------------------------------------

export interface ListOpenCodeSessionsInput {
  limit?: number;
  /** Absolute directory path, or an exact unambiguous OpenCode project ID/name. */
  directory_glob?: string;
  /** Filter by agent (e.g. "build", "coder", "explore"). */
  agent?: string;
  /** Filter by project_id (exact). */
  project_id?: string;
}

export class OpenCodeProjectScopeError extends Error {
  readonly code = 'OPENCODE_PROJECT_SCOPE_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeProjectScopeError';
  }
}

type OpenCodeResolvedScope =
  | { kind: 'directory'; value: string; label: string }
  | { kind: 'project_id'; value: string; label: string };

function isAbsoluteDirectoryPath(value: string): boolean {
  return path.isAbsolute(value) || path.posix.isAbsolute(value)
    || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function directoryName(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function sameDirectoryName(left: string, right: string): boolean {
  return directoryName(left).toLocaleLowerCase() === directoryName(right).toLocaleLowerCase();
}

function directoryNameFilter(column: string): string {
  const normalized = `LOWER(RTRIM(REPLACE(${column}, char(92), '/'), '/'))`;
  return `(${normalized} = ? OR (LENGTH(${normalized}) > LENGTH(?)
    AND SUBSTR(${normalized}, -LENGTH(?) - 1, 1) = '/'
    AND SUBSTR(${normalized}, -LENGTH(?)) = ?))`;
}

function resolveOpenCodeProjectScope(value: string | undefined, db: Database): OpenCodeResolvedScope | null {
  if (value === undefined) return null;
  const alias = value.trim();
  if (!alias) throw new OpenCodeProjectScopeError('OpenCode project scope cannot be empty.');
  if (isAbsoluteDirectoryPath(alias)) return { kind: 'directory', value: alias, label: directoryName(alias) };

  const projectColumns = new Set<string>();
  try {
    for (const row of db.query('PRAGMA table_info(project)').all() as Array<{ name?: unknown }>) {
      if (typeof row.name === 'string') projectColumns.add(row.name);
    }
  } catch {
    // Older OpenCode databases may not have a project table; session metadata remains usable.
  }

  const projectSelect = ['id', 'worktree', 'directory'].filter((column) => projectColumns.has(column));
  const projectRows = projectSelect.includes('id')
    ? db.query(`SELECT ${projectSelect.join(', ')} FROM project`).all() as Array<{
      id?: unknown;
      worktree?: unknown;
      directory?: unknown;
    }>
    : [];

  const directoryFilter = directoryNameFilter('directory');
  const aliasDirectoryName = directoryName(alias).toLocaleLowerCase();
  const sessionRows = db.query(`SELECT DISTINCT project_id, directory FROM session
    WHERE project_id = ? OR ${directoryFilter}`)
    .all(alias, ...Array(5).fill(aliasDirectoryName)) as Array<{
      project_id: unknown;
      directory: unknown;
    }>;

  const targets = new Map<string, OpenCodeResolvedScope>();
  const projectIds = new Set<string>();
  const projectPaths = new Map<string, string>();
  for (const row of projectRows) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (id) {
      projectIds.add(id);
      const candidatePath = [row.worktree, row.directory].find((candidate) =>
        typeof candidate === 'string' && candidate.trim() && isAbsoluteDirectoryPath(candidate));
      if (typeof candidatePath === 'string') projectPaths.set(id, candidatePath);
    }
  }
  for (const row of sessionRows) {
    if (typeof row.project_id === 'string' && row.project_id) projectIds.add(row.project_id);
  }

  for (const id of projectIds) {
    const keyMatch = id === alias;
    const projectPath = projectPaths.get(id);
    const nameMatch = (projectPath !== undefined && sameDirectoryName(projectPath, alias))
      || sessionRows.some((row) => row.project_id === id && typeof row.directory === 'string'
        && sameDirectoryName(row.directory, alias));
    if (keyMatch) targets.set(`project:${id}`, { kind: 'project_id', value: id, label: directoryName(projectPath ?? alias) || alias });
    if (nameMatch) {
      const directory = projectPath ?? sessionRows.find((row) => row.project_id === id
        && typeof row.directory === 'string' && directoryName(row.directory) === directoryName(alias))?.directory;
      if (typeof directory === 'string' && directory.trim()) {
        const normalized = normalizeDirectoryScope(directory);
        if (normalized) targets.set(`directory:${normalized}`, { kind: 'directory', value: directory, label: directoryName(directory) });
      }
    }
  }

  for (const row of sessionRows) {
    if (typeof row.project_id === 'string' && row.project_id) continue;
    if (typeof row.directory !== 'string' || !sameDirectoryName(row.directory, alias)) continue;
    const normalized = normalizeDirectoryScope(row.directory);
    if (normalized) targets.set(`directory:${normalized}`, { kind: 'directory', value: row.directory, label: directoryName(row.directory) });
  }

  if (targets.size > 1) {
    throw new OpenCodeProjectScopeError('OpenCode project alias is ambiguous. Use an absolute project path or exact project ID.');
  }
  const target = targets.values().next().value as OpenCodeResolvedScope | undefined;
  if (!target) {
    throw new OpenCodeProjectScopeError('OpenCode project alias was not found. Use an absolute project path or exact project ID/name.');
  }
  if (target.kind === 'project_id' && target.value.toLowerCase() === 'global') {
    const roots = new Set(sessionRows.filter((row) => row.project_id === target.value && typeof row.directory === 'string')
      .map((row) => normalizeDirectoryScope(row.directory as string)).filter(Boolean));
    if (roots.size > 1) {
      throw new OpenCodeProjectScopeError('OpenCode project key maps to multiple directories. Use an absolute project path.');
    }
  }
  return target;
}

function sqliteOpenCodeScope(scope: OpenCodeResolvedScope, sessionAlias?: string): { clause: string; params: string[] } {
  const column = (name: string) => sessionAlias ? `${sessionAlias}.${name}` : name;
  if (scope.kind === 'project_id') return { clause: `${column('project_id')} = ?`, params: [scope.value] };
  return sqliteDirectoryScope(column('directory'), scope.value);
}

export function listOpenCodeSessions(
  input: ListOpenCodeSessionsInput = {},
  opts: OpenCodeStoreOptions = {}
): SessionGroup[] {
  const db = getDb(opts);
  if (!db) return [];

  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
  const where: string[] = ['1=1'];
  const params: any[] = [];
  if (input.directory_glob) {
    const resolved = resolveOpenCodeProjectScope(input.directory_glob, db);
    if (!resolved) return [];
    const scope = sqliteOpenCodeScope(resolved);
    where.push(scope.clause);
    params.push(...scope.params);
  }
  if (input.agent) {
    where.push('agent = ?');
    params.push(input.agent);
  }
  if (input.project_id) {
    where.push('project_id = ?');
    params.push(input.project_id);
  }

  const sql = `
    SELECT id, project_id, parent_id, slug, directory, title, version,
           summary_additions, summary_deletions, summary_files,
           time_created, time_updated, agent, model, cost,
           tokens_input, tokens_output, tokens_reasoning,
           tokens_cache_read, tokens_cache_write
    FROM session
    WHERE ${where.join(' AND ')}
    ORDER BY time_created DESC
    LIMIT ?
  `;
  params.push(limit);

  try {
    const rows = db.query(sql).all(...params) as OpenCodeSessionRow[];
    return rows.map((r) => sessionRowToGroup(r));
  } catch (err) {
    logger.debug('[opencode-store] list sessions failed', { errorType: errorType(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Search sessions (text LIKE)
// ---------------------------------------------------------------------------

export interface SearchOpenCodeInput {
  query: string;
  limit?: number;
  /** 'text' (default, fast ~3s) | 'deep' (all parts, ~24s) */
  depth?: 'text' | 'deep';
  /** Absolute directory path, or an exact unambiguous OpenCode project ID/name. */
  directory_glob?: string;
  /** Max results per session (default 2 - summary + best match). */
  per_session_chunks?: number;
  /** Internal session page used by the bounded source-database fallback. */
  sessionIds?: string[];
  /** Time budget shared with the indexed query path. */
  scanBudget?: SessionSearchBudget;
}

interface HitRow {
  session_id: string;
  message_id: string;
  part_id: string;
  ptype: string;
  text: string;
  file_path: string | null;
  time_created: number;
  session_title: string;
  session_directory: string;
  session_agent: string | null;
  session_time_created: number;
  session_time_updated: number;
}

export function searchOpenCodeSessions(
  input: SearchOpenCodeInput,
  opts: OpenCodeStoreOptions = {},
  resolvedScope?: OpenCodeResolvedScope | null,
): ChunkResult[] {
  const db = getDb(opts);
  if (!db) return [];
  if (!input.query || input.query.trim().length === 0) return [];
  const scope = resolvedScope ?? (input.directory_glob ? resolveOpenCodeProjectScope(input.directory_glob, db) : null);

  const limit = Math.max(1, Math.min(input.limit ?? 8, 10));
  const perSession = Math.max(1, Math.min(input.per_session_chunks ?? 2, 5));
  const depth = input.depth ?? 'text';

  // Split query into terms; require all terms to appear (AND) so the
  // search is not too noisy.
  const terms = tokenizeSessionSearchQuery(input.query);
  if (terms.length === 0) return [];

  const scopedFilters: string[] = [];
  const scopedParams: string[] = [];
  if (scope) {
    const filter = sqliteOpenCodeScope(scope);
    scopedFilters.push(filter.clause);
    scopedParams.push(...filter.params);
  }
  if (input.sessionIds?.length) {
    scopedFilters.push(`id IN (${input.sessionIds.map(() => '?').join(',')})`);
    scopedParams.push(...input.sessionIds);
  }
  const scopedWhere = scopedFilters.length > 0 ? `WHERE ${scopedFilters.join(' AND ')}` : '';
  const typeFilter = depth === 'deep'
    ? ''
    : `AND json_extract(p.data, "$.type") IN ('text', 'reasoning', 'tool', 'file', 'patch')`;
  const matchingTypeFilter = depth === 'deep'
    ? ''
    : `AND json_extract(match_part.data, "$.type") IN ('text', 'reasoning', 'tool', 'file', 'patch')`;
  const searchableText = (alias: string) => `TRIM(COALESCE(json_extract(${alias}.data, '$.text'), '') || ' ' || COALESCE(json_extract(${alias}.data, '$.path'), ''))`;
  const termHitFilter = terms
    .map(() => `LOWER(${searchableText('p')}) LIKE ?`)
    .join(' OR ');
  const sessionTermCoverage = terms.map(() => `EXISTS (
    SELECT 1 FROM part match_part INDEXED BY part_session_idx
    WHERE match_part.session_id = s.id
      ${matchingTypeFilter}
      AND LOWER(${searchableText('match_part')}) LIKE ?
  )`).join(' AND ');

  const fetchLimit = Math.max(limit * 25, 100);

  const scopedSql = `
    WITH scoped_sessions AS MATERIALIZED (
      SELECT id, title, directory, agent, time_created, time_updated
      FROM session
      ${scopedWhere}
    )
    SELECT p.session_id, p.message_id, p.id as part_id,
           json_extract(p.data, "$.type") as ptype,
           ${searchableText('p')} as text,
           json_extract(p.data, "$.path") as file_path,
           p.time_created,
           s.title as session_title,
           s.directory as session_directory,
           s.agent as session_agent,
           s.time_created as session_time_created,
           s.time_updated as session_time_updated
    FROM scoped_sessions s
    CROSS JOIN part p INDEXED BY part_session_idx
    WHERE p.session_id = s.id
      AND (${termHitFilter})
      ${typeFilter}
      AND ${sessionTermCoverage}
    ORDER BY s.time_created DESC, p.time_created ASC
    LIMIT ?
  `;
  const params: any[] = [
    ...scopedParams,
    ...terms.map((term) => `%${term}%`),
    ...terms.map((term) => `%${term}%`),
    fetchLimit,
  ];

  let rows: HitRow[] = [];
  try {
    rows = db.query(scopedSql).all(...params) as HitRow[];
  } catch (err) {
    logger.debug('[opencode-store] search sessions failed', { errorType: errorType(err) });
    return [];
  }

  // Group by session, keep top-N hits per session, build chunks.
  const bySession = new Map<string, { row: OpenCodeSessionRow; hits: HitRow[] }>();
  for (const r of rows) {
    let entry = bySession.get(r.session_id);
    if (!entry) {
      const row: OpenCodeSessionRow = {
        id: r.session_id,
        project_id: '',
        parent_id: null,
        slug: '',
        directory: r.session_directory,
        title: r.session_title,
        version: '',
        summary_additions: null,
        summary_deletions: null,
        summary_files: null,
        time_created: r.session_time_created,
        time_updated: r.session_time_updated,
        agent: r.session_agent,
        model: null,
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      };
      entry = { row, hits: [] };
      bySession.set(r.session_id, entry);
    }
    if (entry.hits.length < perSession) entry.hits.push(r);
  }

  const project = scope?.label ?? '';

  const out: ChunkResult[] = [];
  for (const [, entry] of bySession) {
    const group = sessionRowToGroup(entry.row, entry.hits.length);
    // Build one chunk per hit. First hit doubles as the "summary"
    // so callers can use buildInjectText.
    for (let i = 0; i < entry.hits.length; i++) {
      const hit = entry.hits[i];
      const content = (hit.text ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, 500);
      if (content.length === 0) continue;
      const chunk: Chunk = {
        type: i === 0 ? 'summary' : 'file',
        content,
        session_id: hit.session_id,
        session_title: group.title,
        project: project || group.project,
        repo_path: group.repo_path,
        branch: '',
        agent: 'opencode',
        agent_session_id: hit.session_id,
        files: [hit.file_path || hit.session_directory],
        timestamp: epochToIso(hit.time_created),
      };
      out.push({
        chunk,
        score: 1 / (i + 1), // first hit scores highest
        memory_id: hit.part_id,
        why: `matched in ${hit.ptype} part of session "${group.title}"`,
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** Search stale or missing OpenCode indexes in small, resumable source-database pages. */
export async function searchOpenCodeSessionsBudgeted(
  input: SearchOpenCodeInput,
  opts: OpenCodeStoreOptions = {},
): Promise<ChunkResult[]> {
  const source = opts.dbPath ?? defaultOpenCodeDbPath();
  const sidecar = opts.sidecarPath ?? defaultSidecarPath();
  const db = getDb(opts);
  if (!db || !input.query.trim()) return [];
  let scope: OpenCodeResolvedScope | null;
  try {
    scope = input.directory_glob ? resolveOpenCodeProjectScope(input.directory_glob, db) : null;
  } catch (error) {
    if (input.scanBudget && error instanceof OpenCodeProjectScopeError) input.scanBudget.scopeError = error.message;
    throw error;
  }
  if (sidecarMatchesSource(source, sidecar)) {
    if (input.scanBudget) input.scanBudget.mode = 'indexed_query';
    return searchOpenCodeSessionsFts(input, opts, scope);
  }

  if (input.scanBudget) input.scanBudget.mode = 'session_scan';

  const budget = input.scanBudget;
  const deadline = budget?.deadlineMs ?? Date.now() + 7_000;
  const limit = Math.max(1, Math.min(input.limit ?? 8, 10));
  const pageSize = 100;
  const scopeFilter = scope ? sqliteOpenCodeScope(scope) : null;
  const where = scopeFilter ? `WHERE ${scopeFilter.clause}` : '';
  const whereParams = scopeFilter?.params ?? [];
  const pageSql = `
    SELECT id
    FROM session
    ${where}
    ORDER BY time_updated DESC, id DESC
    LIMIT ? OFFSET ?
  `;

  const candidates: ChunkResult[] = [];
  let offset = 0;
  while (true) {
    if (Date.now() >= deadline) {
      if (budget) markSessionSearchTruncated(budget, 'time_limit');
      break;
    }
    const remaining = budget ? budget.maxSessions - budget.scannedSessions : pageSize;
    if (remaining <= 0) {
      if (budget) markSessionSearchTruncated(budget, 'session_limit');
      break;
    }
    const sessionLimit = Math.min(pageSize, remaining);
    let sessionRows: Array<{ id: string }>;
    try {
      sessionRows = db.query(pageSql).all(...whereParams, sessionLimit, offset) as Array<{ id: string }>;
    } catch (error) {
      logger.debug('[opencode-store] bounded session page failed', { errorType: errorType(error) });
      break;
    }
    if (sessionRows.length === 0) break;
    if (budget) budget.scannedSessions += sessionRows.length;

    const pageResults = searchOpenCodeSessions({
      ...input,
      limit: 10,
      sessionIds: sessionRows.map((row) => row.id),
    }, opts, scope);
    candidates.push(...pageResults);
    offset += sessionRows.length;
    if (sessionRows.length < sessionLimit) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const queryTerms = tokenizeSessionSearchQuery(input.query);
  const bySession = new Map<string, ChunkResult[]>();
  for (const candidate of candidates) {
    const sessionId = candidate.chunk.session_id;
    const group = bySession.get(sessionId) ?? [];
    group.push(candidate);
    bySession.set(sessionId, group);
  }
  const ranked = [...bySession.values()].map((group) => {
    const combinedText = group.map((item) => item.chunk.content.toLowerCase()).join(' ');
    const termCoverage = queryTerms.length === 0 ? 0 : queryTerms.filter((term) => combinedText.includes(term)).length / queryTerms.length;
    const bestChunkCoverage = queryTerms.length === 0 ? 0 : Math.max(...group.map((item) => {
      const text = item.chunk.content.toLowerCase();
      return queryTerms.filter((term) => text.includes(term)).length / queryTerms.length;
    }));
    const exactPhrase = combinedText.includes(input.query.toLowerCase().trim()) ? 1 : 0;
    const timestamp = group[0]?.chunk.timestamp ?? '';
    const score = exactPhrase * 0.15 + termCoverage * 0.55 + bestChunkCoverage * 0.3;
    group.sort((a, b) => {
      const aText = a.chunk.content.toLowerCase();
      const bText = b.chunk.content.toLowerCase();
      const aScore = queryTerms.filter((term) => aText.includes(term)).length;
      const bScore = queryTerms.filter((term) => bText.includes(term)).length;
      return bScore - aScore;
    });
    return { group, score, timestamp };
  }).sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp));

  return ranked.flatMap(({ group }) => group).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Get a single session (with optional message snippets)
// ---------------------------------------------------------------------------

export interface OpenCodeSessionDetail extends SessionGroup {
  chunks: Chunk[];
  message_count: number;
  part_count: number;
}

interface MessageHeadRow {
  id: string;
  role: string;
  time_created: number;
  title: string | null;
}

export function getOpenCodeSession(
  sessionId: string,
  opts: OpenCodeStoreOptions = {}
): OpenCodeSessionDetail | null {
  const db = getDb(opts);
  if (!db) return null;

  const row = db
    .query(
      `SELECT id, project_id, parent_id, slug, directory, title, version,
              summary_additions, summary_deletions, summary_files,
              time_created, time_updated, agent, model, cost,
              tokens_input, tokens_output, tokens_reasoning,
              tokens_cache_read, tokens_cache_write
       FROM session WHERE id = ?`
    )
    .get(sessionId) as OpenCodeSessionRow | null;
  if (!row) return null;

  // Count messages/parts
  const mcount = (db.query('SELECT COUNT(*) as n FROM message WHERE session_id = ?').get(sessionId) as { n: number } | null)?.n ?? 0;
  const pcount = (db.query('SELECT COUNT(*) as n FROM part WHERE session_id = ?').get(sessionId) as { n: number } | null)?.n ?? 0;

  // Pull the first user message and first assistant text as the summary.
  const userFirst = db
    .query(
      `SELECT m.id, json_extract(m.data, '$.role') as role, m.time_created,
              json_extract(m.data, '$.summary.title') as title
       FROM message m WHERE m.session_id = ?
         AND json_extract(m.data, '$.role') = 'user'
       ORDER BY m.time_created ASC LIMIT 1`
    )
    .get(sessionId) as MessageHeadRow | null;

  const assistantTextFirst = db
    .query(
      `SELECT p.id, p.message_id, json_extract(p.data, '$.text') as text
       FROM part p WHERE p.session_id = ?
         AND json_extract(p.data, '$.type') = 'text'
       ORDER BY p.time_created ASC LIMIT 1`
    )
    .get(sessionId) as { id: string; message_id: string; text: string | null } | null;

  const toolFiles = db
    .query(
      `SELECT DISTINCT json_extract(p.data, '$.path') as fpath
       FROM part p WHERE p.session_id = ?
         AND json_extract(p.data, '$.type') IN ('tool', 'patch', 'file')
         AND json_extract(p.data, '$.path') IS NOT NULL
         AND json_extract(p.data, '$.path') != ''
       LIMIT 20`
    )
    .all(sessionId) as { fpath: string }[];

  const group = sessionRowToGroup(row);

  const chunks: Chunk[] = [];

  if (userFirst) {
    // If the user message has a summary.title, use it. Otherwise fall back
    // to the first text part of the user message (the actual user prompt).
    // Never use the message id — that's noise.
    let title = (userFirst.title || '').trim();
    if (!title) {
      const userText = db
        .query(
          `SELECT json_extract(data, '$.text') as text
           FROM part
           WHERE message_id = ?
             AND json_extract(data, '$.type') = 'text'
             AND json_extract(data, '$.text') IS NOT NULL
             AND json_extract(data, '$.text') != ''
           ORDER BY time_created ASC
           LIMIT 1`
        )
        .get(userFirst.id) as { text: string | null } | null;
      if (userText?.text) {
        title = userText.text
          .toString()
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200);
      }
    }
    if (title) {
      chunks.push({
        type: 'summary',
        content: title,
        session_id: row.id,
        session_title: group.title,
        project: group.project,
        repo_path: group.repo_path,
        branch: '',
        agent: 'opencode',
        agent_session_id: row.id,
        timestamp: epochToIso(userFirst.time_created),
      });
    }
  }

  if (assistantTextFirst && assistantTextFirst.text) {
    const text = assistantTextFirst.text.toString().replace(/\s+/g, ' ').trim().slice(0, 500);
    if (text) {
      chunks.push({
        type: 'file',
        content: text,
        session_id: row.id,
        session_title: group.title,
        project: group.project,
        repo_path: group.repo_path,
        branch: '',
        agent: 'opencode',
        agent_session_id: row.id,
        timestamp: epochToIso(row.time_created),
      });
    }
  }

  for (const tf of toolFiles) {
    if (!tf.fpath) continue;
    chunks.push({
      type: 'file',
      content: tf.fpath,
      session_id: row.id,
      session_title: group.title,
      project: group.project,
      repo_path: group.repo_path,
      branch: '',
      agent: 'opencode',
      agent_session_id: row.id,
      files: [tf.fpath],
      timestamp: epochToIso(row.time_updated),
    });
  }

  return {
    ...group,
    chunks,
    message_count: mcount,
    part_count: pcount,
  };
}

// ---------------------------------------------------------------------------
// Find sessions related to a directory (and optional file paths)
// ---------------------------------------------------------------------------

export interface FindOpenCodeRelatedInput {
  repo_path: string;
  files?: string[];
  limit?: number;
}

export interface OpenCodeRelatedResult {
  session: SessionGroup;
  matching_chunks: Chunk[];
  score: number;
}

export function findOpenCodeRelatedSessions(
  input: FindOpenCodeRelatedInput,
  opts: OpenCodeStoreOptions = {}
): OpenCodeRelatedResult[] {
  // Strategy: list sessions in the directory, then for each, compute
  // a score based on how many of the requested file paths appear in
  // its tool/patch parts. Faster than LIKE-on-messages.
  const db = getDb(opts);
  if (!db) return [];

  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const sessions = listOpenCodeSessions(
    { limit: 200, directory_glob: input.repo_path },
    opts
  );
  if (sessions.length === 0) return [];

  const out: OpenCodeRelatedResult[] = [];
  for (const s of sessions) {
    const detail = getOpenCodeSession(s.session_id, opts);
    if (!detail) continue;
    const fileHits = new Set<string>();
    for (const c of detail.chunks) {
      for (const f of c.files ?? []) {
        for (const target of input.files ?? []) {
          if (target && f.includes(target)) fileHits.add(target);
        }
      }
    }
    const score = fileHits.size;
    if (input.files && input.files.length > 0 && score === 0) continue;
    out.push({
      session: { ...s, chunk_count: detail.chunks.length },
      matching_chunks: detail.chunks,
      score,
    });
  }

  out.sort((a, b) => b.score - a.score || b.session.started_at.localeCompare(a.session.started_at));
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Sidecar FTS5 index (explicit build; source-fingerprinted freshness)
// ---------------------------------------------------------------------------

const SIDECAR_BUILD_VERSION = 1;
const DEFAULT_INDEX_BATCH_SIZE = 250;

export interface OpenCodeSidecarBuildProgress {
  status: 'building' | 'complete' | 'source_changed' | 'error';
  path: string;
  indexedParts: number;
}

function buildingSidecarPath(dest: string): string {
  return `${dest}.building`;
}

function removeSqliteFiles(filePath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(`${filePath}${suffix}`); } catch { /* absent or not removable */ }
  }
}

function readBuildState(db: Database): {
  source_fingerprint: string;
  cursor: string | null;
  indexed_parts: number;
  build_version: number;
} | null {
  try {
    return db.query('SELECT source_fingerprint, cursor, indexed_parts, build_version FROM build_state WHERE id = 1').get() as {
      source_fingerprint: string;
      cursor: string | null;
      indexed_parts: number;
      build_version: number;
    } | null;
  } catch {
    return null;
  }
}

function initializeBuildingSidecar(db: Database, fingerprint: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      DROP TABLE IF EXISTS part_fts;
      DROP TABLE IF EXISTS build_state;
      DROP TABLE IF EXISTS index_meta;
      CREATE VIRTUAL TABLE part_fts USING fts5(
        session_id UNINDEXED,
        message_id UNINDEXED,
        part_id UNINDEXED,
        ptype UNINDEXED,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE build_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        source_fingerprint TEXT NOT NULL,
        cursor TEXT,
        indexed_parts INTEGER NOT NULL,
        build_version INTEGER NOT NULL
      );
      CREATE TABLE index_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        source_fingerprint TEXT NOT NULL,
        indexed_parts INTEGER NOT NULL,
        content_version INTEGER NOT NULL
      );
    `);
    db.query('INSERT INTO build_state (id, source_fingerprint, cursor, indexed_parts, build_version) VALUES (1, ?, NULL, 0, ?)')
      .run(fingerprint, SIDECAR_BUILD_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

function promoteBuildingSidecar(buildingPath: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.renameSync(buildingPath, dest);
    return;
  }

  // Keep the previous index intact until a fully validated replacement exists.
  const previousPath = `${dest}.previous`;
  removeSqliteFiles(previousPath);
  fs.renameSync(dest, previousPath);
  try {
    fs.renameSync(buildingPath, dest);
    removeSqliteFiles(previousPath);
  } catch (error) {
    try { fs.renameSync(previousPath, dest); } catch { /* retain the previous file for manual recovery */ }
    throw error;
  }
}

/** Process a bounded batch of an explicitly requested, resumable OpenCode FTS build. */
export async function buildOpenCodeSidecarBatch(
  opts: OpenCodeStoreOptions = {},
  maxBatches = 1,
): Promise<OpenCodeSidecarBuildProgress> {
  const src = opts.dbPath ?? defaultOpenCodeDbPath();
  const dest = opts.sidecarPath ?? defaultSidecarPath();
  const buildingPath = buildingSidecarPath(dest);
  if (path.resolve(src) === path.resolve(dest) || path.resolve(src) === path.resolve(buildingPath)) {
    return { status: 'error', path: dest, indexedParts: 0 };
  }
  if (sidecarMatchesSource(src, dest)) return { status: 'complete', path: dest, indexedParts: 0 };

  const fingerprint = sourceFingerprint(src);
  if (!fingerprint || !fs.existsSync(src)) return { status: 'error', path: dest, indexedParts: 0 };
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let srcDb: Database | null = null;
  let destDb: Database | null = null;
  try {
    srcDb = new DatabaseCtor(src, { readonly: true });
  } catch (err) {
    logger.debug('[opencode-store] sidecar source could not be opened', { errorType: errorType(err) });
    return { status: 'error', path: dest, indexedParts: 0 };
  }
  try {
    destDb = new DatabaseCtor(buildingPath);
  } catch (err) {
    try { srcDb.close(); } catch { /* ignore */ }
    logger.debug('[opencode-store] sidecar build could not be opened', { errorType: errorType(err) });
    return { status: 'error', path: dest, indexedParts: 0 };
  }

  try {
    const completedBuild = (() => {
      try {
        return destDb?.query('SELECT source_fingerprint, indexed_parts, content_version FROM index_meta WHERE id = 1').get() as {
          source_fingerprint: string;
          indexed_parts: number;
          content_version: number;
        } | null;
      } catch {
        return null;
      }
    })();
    if (completedBuild?.source_fingerprint === fingerprint
      && completedBuild.content_version === OPENCODE_SIDECAR_CONTENT_VERSION) {
      destDb.close(); destDb = null;
      srcDb.close(); srcDb = null;
      if (sourceFingerprint(src) !== fingerprint) {
        removeSqliteFiles(buildingPath);
        return { status: 'source_changed', path: dest, indexedParts: completedBuild.indexed_parts };
      }
      promoteBuildingSidecar(buildingPath, dest);
      return sidecarMatchesSource(src, dest)
        ? { status: 'complete', path: dest, indexedParts: completedBuild.indexed_parts }
        : { status: 'source_changed', path: dest, indexedParts: completedBuild.indexed_parts };
    }

    let state = readBuildState(destDb);
    if (!state || state.source_fingerprint !== fingerprint || state.build_version !== SIDECAR_BUILD_VERSION) {
      initializeBuildingSidecar(destDb, fingerprint);
      state = readBuildState(destDb);
    }
    if (!state) throw new Error('OpenCode sidecar build state unavailable');

    const requestedBatchSize = Number.isInteger(opts.indexBatchSize) ? opts.indexBatchSize as number : DEFAULT_INDEX_BATCH_SIZE;
    const batchSize = Math.max(1, Math.min(requestedBatchSize, 2_000));
    const insert = destDb.query(
      'INSERT OR REPLACE INTO part_fts (session_id, message_id, part_id, ptype, text) VALUES (?, ?, ?, ?, ?)',
    );
    const page = srcDb.query(`
      SELECT id AS part_id, session_id, message_id,
             json_extract(data, '$.type') AS ptype,
             TRIM(COALESCE(json_extract(data, '$.text'), '') || ' ' || COALESCE(json_extract(data, '$.path'), '')) AS text
      FROM part
      WHERE (? IS NULL OR id > ?)
      ORDER BY id
      LIMIT ?
    `);
    const batchLimit = Number.isFinite(maxBatches) ? Math.max(1, Math.min(Math.trunc(maxBatches), 100)) : 1;
    let indexedParts = state.indexed_parts;

    for (let batch = 0; batch < batchLimit; batch++) {
      const rows = page.all(state.cursor, state.cursor, batchSize) as Array<{
        part_id: string;
        session_id: string;
        message_id: string;
        ptype: string | null;
        text: string | null;
      }>;
      if (rows.length === 0) {
        if (sourceFingerprint(src) !== fingerprint) {
          destDb.close(); destDb = null;
          srcDb.close(); srcDb = null;
          removeSqliteFiles(buildingPath);
          return { status: 'source_changed', path: dest, indexedParts };
        }
        destDb.exec('BEGIN IMMEDIATE');
        try {
          destDb.exec('DROP TABLE build_state');
          destDb.query('INSERT OR REPLACE INTO index_meta (id, source_fingerprint, indexed_parts, content_version) VALUES (1, ?, ?, ?)')
            .run(fingerprint, indexedParts, OPENCODE_SIDECAR_CONTENT_VERSION);
          destDb.exec('COMMIT');
        } catch (error) {
          try { destDb.exec('ROLLBACK'); } catch { /* ignore */ }
          throw error;
        }
        destDb.close(); destDb = null;
        srcDb.close(); srcDb = null;
        if (sourceFingerprint(src) !== fingerprint) {
          removeSqliteFiles(buildingPath);
          return { status: 'source_changed', path: dest, indexedParts };
        }
        promoteBuildingSidecar(buildingPath, dest);
        fs.utimesSync(dest, new Date(), new Date());
        return sidecarMatchesSource(src, dest)
          ? { status: 'complete', path: dest, indexedParts }
          : { status: 'source_changed', path: dest, indexedParts };
      }

      if (sourceFingerprint(src) !== fingerprint) {
        destDb.close(); destDb = null;
        srcDb.close(); srcDb = null;
        removeSqliteFiles(buildingPath);
        return { status: 'source_changed', path: dest, indexedParts };
      }

      destDb.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          const text = (row.text ?? '').toString().slice(0, 8_000);
          if (text.length > 0) {
            insert.run(row.session_id, row.message_id, row.part_id, row.ptype ?? '', text);
            indexedParts++;
          }
        }
        const cursor: string | null = rows[rows.length - 1]?.part_id ?? state.cursor;
        destDb.query('UPDATE build_state SET cursor = ?, indexed_parts = ? WHERE id = 1').run(cursor, indexedParts);
        destDb.exec('COMMIT');
        state = { ...state, cursor, indexed_parts: indexedParts };
      } catch (error) {
        try { destDb.exec('ROLLBACK'); } catch { /* ignore */ }
        throw error;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    return { status: 'building', path: dest, indexedParts };
  } catch (err) {
    logger.debug('[opencode-store] sidecar batch failed', { errorType: errorType(err) });
    return { status: 'error', path: dest, indexedParts: 0 };
  } finally {
    try { destDb?.close(); } catch { /* ignore */ }
    try { srcDb?.close(); } catch { /* ignore */ }
  }
}

/**
 * Explicitly build the full FTS sidecar. Each source page is bounded and yields
 * to the event loop; committed progress is stored in the `.building` database
 * so a later invocation can resume after interruption. Search never invokes
 * this function implicitly.
 */
export async function ensureSidecarFts(opts: OpenCodeStoreOptions = {}): Promise<string | null> {
  const dest = opts.sidecarPath ?? defaultSidecarPath();
  let sourceRestarts = 0;
  while (true) {
    const progress = await buildOpenCodeSidecarBatch(opts, 100);
    if (progress.status === 'complete') return dest;
    if (progress.status === 'error') return null;
    if (progress.status === 'source_changed') {
      sourceRestarts++;
      if (sourceRestarts > 2) return null;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Search using a prebuilt sidecar index when available. Building the index
 * is deliberately kept out of the request path because it reads the entire
 * source database and can block an interactive search for several minutes.
 */
export function searchOpenCodeSessionsFts(
  input: SearchOpenCodeInput,
  opts: OpenCodeStoreOptions = {},
  resolvedScope?: OpenCodeResolvedScope | null,
): ChunkResult[] {
  const source = opts.dbPath ?? defaultOpenCodeDbPath();
  const sidecar = opts.sidecarPath ?? defaultSidecarPath();
  if (!fs.existsSync(sidecar) || !sidecarMatchesSource(source, sidecar)) {
    return [];
  }

  let destDb: Database;
  try {
    destDb = new (DatabaseCtor as any)(sidecar, { readonly: true });
  } catch {
    return [];
  }

  try {
    const sourceDb = getDb(opts);
    if (!sourceDb) return [];
    const scope = resolvedScope !== undefined
      ? resolvedScope
      : input.directory_glob ? resolveOpenCodeProjectScope(input.directory_glob, sourceDb) : null;
    const scopeFilter = scope ? sqliteOpenCodeScope(scope, 's') : null;
    if (scopeFilter) {
      destDb.exec('CREATE TEMP TABLE scoped_sessions (id TEXT PRIMARY KEY) WITHOUT ROWID');
      const insertScope = destDb.query('INSERT INTO temp.scoped_sessions (id) VALUES (?)');
      const sessionIds = sourceDb.query(`SELECT s.id FROM session s WHERE ${scopeFilter.clause}`)
        .all(...scopeFilter.params) as Array<{ id: string }>;
      for (const session of sessionIds) insertScope.run(session.id);
      if (sessionIds.length === 0) return [];
    }
    const limit = Math.max(1, Math.min(input.limit ?? 8, 10));
    const queryTerms = tokenizeSessionSearchQuery(input.query);
    const terms = queryTerms.map((t) => `"${t}"*`);
    if (terms.length === 0) return [];
    // A session can answer a multi-term query across separate turns/parts.
    // Retrieve every matching part in ranked pages. Current source session
    // metadata filters each page before results are grouped or limited; paging
    // to exhaustion avoids false negatives from cross-project candidate crowding.
    const matchExpr = terms.join(' OR ');
    const pageSize = scope ? 250 : Math.max(limit * 100, 1_000);
    const candidatesSql = `
      SELECT part_fts.session_id, part_fts.message_id, part_fts.part_id, part_fts.ptype
      FROM part_fts ${scopeFilter ? 'JOIN temp.scoped_sessions scoped ON scoped.id = part_fts.session_id' : ''}
      WHERE part_fts MATCH ?
      ORDER BY rank, part_fts.part_id
      LIMIT ? OFFSET ?
    `;
    const sourceScopeSql = scopeFilter ? `AND ${scopeFilter.clause}` : '';
    const hits: HitRow[] = [];
    const deadline = input.scanBudget?.deadlineMs ?? Date.now() + 7_000;
    for (let offset = 0; ; offset += pageSize) {
      if (Date.now() >= deadline) {
        if (input.scanBudget) markSessionSearchTruncated(input.scanBudget, 'time_limit');
        break;
      }
      if (!scope && offset >= MAX_GLOBAL_FTS_CANDIDATES) {
        const hasMore = destDb.query(candidatesSql).get(
          matchExpr, 1, offset,
        );
        if (hasMore && input.scanBudget) {
          markSessionSearchTruncated(input.scanBudget, 'history_index_limit');
        }
        break;
      }
      const candidates = destDb.query(candidatesSql).all(
        matchExpr, pageSize, offset,
      ) as Array<{ session_id: string; message_id: string; part_id: string; ptype: string }>;
      if (candidates.length === 0) break;
      const sourceParts = sourceDb.query(`
        SELECT p.session_id, p.message_id, p.id AS part_id,
               json_extract(p.data, '$.type') AS ptype,
               TRIM(COALESCE(json_extract(p.data, '$.text'), '') || ' ' || COALESCE(json_extract(p.data, '$.path'), '')) AS text,
               json_extract(p.data, '$.path') AS file_path,
               s.title AS session_title, s.directory AS session_directory,
               s.agent AS session_agent, s.time_created AS session_time_created,
               s.time_updated AS session_time_updated
        FROM part p JOIN session s ON s.id = p.session_id
        WHERE p.id IN (${candidates.map(() => '?').join(',')}) ${sourceScopeSql}
      `).all(...candidates.map((candidate) => candidate.part_id), ...(scopeFilter?.params ?? [])) as HitRow[];
      const currentByPartId = new Map(sourceParts.map((part) => [part.part_id, part]));
      for (const candidate of candidates) {
        const current = currentByPartId.get(candidate.part_id);
        if (!current || current.session_id !== candidate.session_id || current.message_id !== candidate.message_id) continue;
        const currentText = String(current.text ?? '').toLowerCase();
        if (!queryTerms.some((term) => currentText.includes(term))) continue;
        hits.push({ ...candidate, ...current });
      }
      if (candidates.length < pageSize) break;
    }
    if (hits.length === 0) return [];
    const bySession = new Map<string, typeof hits>();
    for (const r of hits) {
      const list = bySession.get(r.session_id) ?? [];
      list.push(r);
      bySession.set(r.session_id, list);
    }

    const out: ChunkResult[] = [];
    for (const [sessionId, hits] of bySession) {
      const coveredTerms = new Set(hits.flatMap((hit) => {
        const text = String(hit.text ?? '').toLowerCase();
        return queryTerms.filter((term) => text.includes(term));
      }));
      if (!queryTerms.every((term) => coveredTerms.has(term))) continue;

      const perSession = Math.max(1, Math.min(input.per_session_chunks ?? 2, 5));
      const selected: typeof hits = [];
      const selectedIds = new Set<string>();
      const selectedTerms = new Set<string>();
      for (const hit of hits) {
        const text = String(hit.text ?? '').toLowerCase();
        const newTerms = queryTerms.filter((term) => text.includes(term) && !selectedTerms.has(term));
        if (newTerms.length === 0) continue;
        selected.push(hit);
        selectedIds.add(hit.part_id);
        newTerms.forEach((term) => selectedTerms.add(term));
        if (selected.length >= perSession) break;
      }
      for (const hit of hits) {
        if (selected.length >= perSession) break;
        if (selectedIds.has(hit.part_id)) continue;
        selected.push(hit);
        selectedIds.add(hit.part_id);
      }

      const first = selected[0];
      const group = sessionRowToGroup({
        id: sessionId,
        project_id: '',
        parent_id: null,
        slug: '',
        directory: first.session_directory,
        title: first.session_title,
        version: '',
        summary_additions: null,
        summary_deletions: null,
        summary_files: null,
        time_created: first.session_time_created,
        time_updated: first.session_time_updated,
        agent: first.session_agent,
        model: null,
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      }, selected.length);

      for (let i = 0; i < selected.length; i++) {
        const hit = selected[i];
        const content = (hit.text ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, 500);
        if (content.length === 0) continue;
        out.push({
          chunk: {
            type: i === 0 ? 'summary' : 'file',
            content,
            session_id: hit.session_id,
            session_title: group.title,
            project: group.project,
            repo_path: group.repo_path,
            branch: '',
            agent: 'opencode',
            agent_session_id: hit.session_id,
            files: [hit.file_path || hit.session_directory],
            timestamp: epochToIso(first.session_time_created),
          },
          score: 1 / (i + 1),
          memory_id: hit.part_id,
          why: `FTS match in ${hit.ptype} part of session "${group.title}"`,
        });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    logger.debug('[opencode-store] sidecar search failed', { errorType: errorType(err) });
    return [];
  } finally {
    try { destDb.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// AgentSessionStore implementation
// ---------------------------------------------------------------------------

/**
 * OpenCode-backed implementation of `AgentSessionStore`.
 *
 * Prefers the persistent FTS5 sidecar when its source fingerprint matches.
 * Stale or absent sidecars use bounded pages against the source database;
 * interactive search never scans the whole parts table in one query.
 */
export class OpenCodeSessionStore implements AgentSessionStore {
  readonly name: AgentName = 'opencode';

  /** Map adapter-level options to the opencode store's options. */
  private optsFor(input: { directory_glob?: string; opencode_db_path?: string }): OpenCodeStoreOptions {
    return { readonly: true, ...(input.opencode_db_path ? { dbPath: input.opencode_db_path } : {}) };
  }

  async available(input: { opencode_db_path?: string } = {}): Promise<{ ok: boolean; reason?: string; meta?: Record<string, unknown> }> {
    if (process.env.SQUISH_OPENCODE_DISABLED === '1') {
      return { ok: false, reason: 'opencode disabled via SQUISH_OPENCODE_DISABLED=1' };
    }
    const availability = opencodeDbAvailability(this.optsFor(input));
    if (!availability.ok) {
      return { ok: false, reason: availability.error ?? 'opencode.db not available' };
    }
    return {
      ok: true,
      meta: {
        path: availability.path,
      },
    };
  }

  async status(): Promise<{ path: string; size: number; sessions: number; messages: number; parts: number } | null> {
    const s = opencodeDbStatus();
    if (!s.ok || !s.path || s.size_bytes == null) return null;
    return {
      path: s.path,
      size: s.size_bytes,
      sessions: s.session_count ?? 0,
      messages: s.message_count ?? 0,
      parts: s.part_count ?? 0,
    };
  }

  async listSessions(opts?: { limit?: number; offset?: number; directory_glob?: string }): Promise<SessionGroup[]> {
    return listOpenCodeSessions({ limit: opts?.limit, directory_glob: opts?.directory_glob }, this.optsFor(opts ?? {}));
  }

  async searchSessions(input: { query: string; limit?: number; depth?: 'text' | 'deep'; directory_glob?: string; opencode_db_path?: string; per_session_chunks?: number; scanBudget?: SessionSearchBudget }): Promise<Chunk[]> {
    const results = await searchOpenCodeSessionsBudgeted(
      {
        query: input.query,
        limit: input.limit,
        depth: input.depth,
        directory_glob: input.directory_glob,
        per_session_chunks: input.per_session_chunks,
        scanBudget: input.scanBudget,
      },
      this.optsFor(input)
    );
    return results.map((r) => r.chunk);
  }

  async getSession(id: string, input: { opencode_db_path?: string } = {}): Promise<{ group: SessionGroup; chunks: Chunk[] } | null> {
    const detail = getOpenCodeSession(id, this.optsFor(input));
    if (!detail) return null;
    const group: SessionGroup = {
      session_id: detail.session_id,
      title: detail.title,
      project: detail.project,
      repo_path: detail.repo_path,
      branch: detail.branch,
      agent: detail.agent,
      started_at: detail.started_at,
      ended_at: detail.ended_at,
      status: detail.status,
      chunk_count: detail.chunk_count,
    };
    return { group, chunks: detail.chunks };
  }

  async findRelatedSessions(input: { repo_path?: string; files?: string[]; limit?: number }): Promise<Array<{ group: SessionGroup; score: number; reason: string }>> {
    if (!input.repo_path) return [];
    const results = findOpenCodeRelatedSessions(
      { repo_path: input.repo_path, files: input.files, limit: input.limit },
      this.optsFor({})
    );
    return results.map((r) => {
      const fileOverlap = (input.files ?? []).filter((f) => r.matching_chunks.some((c) => (c.files ?? []).some((cf) => cf.includes(f)))).length;
      const reason = fileOverlap > 0
        ? `directory match + ${fileOverlap} file overlap(s)`
        : `directory match (${input.repo_path})`;
      return {
        group: r.session,
        score: r.score,
        reason,
      };
    });
  }
}
