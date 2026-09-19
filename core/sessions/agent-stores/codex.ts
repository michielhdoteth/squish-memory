/**
 * Codex session store - implements `AgentSessionStore`.
 *
 * Read-only access to the user's local Codex session database
 * (`~/.codex/state_5.sqlite`) so that `squish sessions list|search|show|related`
 * can return past Codex sessions.
 *
 * Storage format:
 *   - `~/.codex/state_5.sqlite` — SQLite database with `threads` table containing:
 *       id (TEXT, UUID), rollout_path (TEXT), created_at (REAL), updated_at (REAL),
 *       created_at_ms (INTEGER), updated_at_ms (INTEGER), cwd (TEXT), title (TEXT),
 *       first_user_message (TEXT), tokens_used (INTEGER), git_sha (TEXT),
 *       git_branch (TEXT), git_origin_url (TEXT), model_provider (TEXT),
 *       source (TEXT), cli_version (TEXT), model (TEXT), archived (INTEGER),
 *       has_user_event (INTEGER), preview (TEXT)
 *   - `~/.codex/sessions/<year>/<month>/<day>/rollout-*.json` — Full session data with:
 *       { session: { timestamp, id, instructions }, items: [{ role, content, type }] }
 *
 * The `rollout_path` in SQLite is a relative path from `~/.codex/`.
 *
 * Public surface consumed by:
 *   - core/sessions/store.ts (the public sessions surface)
 *   - packages/cli/src/commands/sessions.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
import type { AgentSessionStore, AgentName } from './types.js';
import { readSessionCache, statSessionFile, writeSessionCache } from './cache.js';
import { recordParsedSessionSignals } from '../../session/working-set.js';

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------

/**
 * Default location of the Codex data directory.
 * `~/.codex/` on all platforms including Windows.
 */
export function defaultCodexDir(): string {
  if (process.env.SQUISH_CODEX_DISABLED === '1') {
    return path.join(os.homedir(), '.squish', 'codex-disabled-for-tests');
  }
  return path.join(os.homedir(), '.codex');
}

/**
 * Path to the Codex SQLite database.
 */
export function defaultCodexDbPath(): string {
  return path.join(defaultCodexDir(), 'state_5.sqlite');
}

export interface CodexStoreOptions {
  /** Override the base directory (default: defaultCodexDir()) */
  codexDir?: string;
  /** Override the DB path (default: defaultCodexDbPath()) */
  dbPath?: string;
  /** Read-only connection (default: true) */
  readonly?: boolean;
}

// ---------------------------------------------------------------------------
// Connection cache
// ---------------------------------------------------------------------------

interface CachedDb {
  db: Database;
  dbPath: string;
  readonly: boolean;
  mtimeMs: number;
}

let cached: CachedDb | null = null;

function getDb(opts: CodexStoreOptions = {}): Database | null {
  const dbPath = opts.dbPath ?? defaultCodexDbPath();
  if (!fs.existsSync(dbPath)) return null;

  const readonly = opts.readonly !== false;
  const stat = fs.statSync(dbPath);
  const mtimeMs = stat.mtimeMs;

  if (cached && cached.dbPath === dbPath && cached.readonly === readonly && cached.mtimeMs === mtimeMs) {
    return cached.db;
  }

  try {
    if (cached) {
      try { cached.db.close(); } catch { /* ignore */ }
      cached = null;
    }
    const db = new (DatabaseCtor as any)(dbPath, readonly ? { readonly: true } : undefined);
    cached = { db, dbPath, readonly, mtimeMs };
    return db;
  } catch (err) {
    logger.debug(`[codex-store] failed to open ${dbPath}: ${err}`);
    return null;
  }
}

export function closeCodexDb(): void {
  if (cached) {
    try { cached.db.close(); } catch { /* ignore */ }
    cached = null;
  }
}

// ---------------------------------------------------------------------------
// Health / discovery
// ---------------------------------------------------------------------------

export interface CodexDbStatus {
  ok: boolean;
  path: string | null;
  size_bytes: number | null;
  session_count: number | null;
  message_count: number | null;
  part_count: number | null;
  error?: string;
}

export function codexDbStatus(opts: CodexStoreOptions = {}): CodexDbStatus {
  const dbPath = opts.dbPath ?? defaultCodexDbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      path: null,
      size_bytes: null,
      session_count: null,
      message_count: null,
      part_count: null,
      error: `Codex db not found at ${dbPath}`,
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
    const sessions = db.query('SELECT COUNT(*) as n FROM threads').get() as { n: number } | null;
    return {
      ok: true,
      path: dbPath,
      size_bytes: stat.size,
      session_count: sessions?.n ?? 0,
      // Codex doesn't have a separate messages table in state_5.sqlite
      message_count: 0,
      part_count: 0,
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

// ---------------------------------------------------------------------------
// Row -> SessionGroup mapping
// ---------------------------------------------------------------------------

interface CodexThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  created_at_ms: number;
  updated_at_ms: number;
  cwd: string;
  title: string;
  first_user_message: string;
  tokens_used: number;
  git_sha: string;
  git_branch: string;
  git_origin_url: string;
  model_provider: string;
  source: string;
  cli_version: string;
  model: string;
  archived: number;
  has_user_event: number;
  preview: string;
}

function epochToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function deriveProjectName(directory: string): string {
  // Extract the last meaningful directory name from a path
  if (!directory) return '';
  const norm = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm === '/' || /^[A-Z]:$/.test(norm)) return directory;
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] || directory;
}

function threadRowToGroup(row: CodexThreadRow, chunkCount?: number): SessionGroup {
  const project = deriveProjectName(row.cwd);
  // created_at_ms is epoch milliseconds; convert to ISO string
  const started = epochToIso(row.created_at_ms || row.created_at * 1000);
  const updated = epochToIso(row.updated_at_ms || row.updated_at * 1000);
  return {
    session_id: row.id,
    title: row.title || row.first_user_message?.slice(0, 200) || row.id,
    project,
    repo_path: row.cwd || '',
    branch: row.git_branch || '',
    agent: 'codex' as SessionGroup['agent'],
    started_at: started,
    ended_at: updated !== started ? updated : null,
    status: 'completed',
    chunk_count: chunkCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Rollout JSON parsing
// ---------------------------------------------------------------------------

interface RolloutSession {
  timestamp?: string;
  id?: string;
  instructions?: string;
}

interface RolloutItem {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  type?: string;
}

interface RolloutData {
  session?: RolloutSession;
  items?: RolloutItem[];
}

/**
 * Read and parse a rollout JSON file.
 */
function readRolloutFile(filePath: string): RolloutData | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as RolloutData;
  } catch (err) {
    logger.debug(`[codex-store] failed to read rollout ${filePath}: ${err}`);
    return null;
  }
}

/**
 * Extract text from a rollout item's content field.
 * Content can be a string or an array of content blocks.
 */
function extractText(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  // Array of content blocks — extract text blocks
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
      if (block.text) texts.push(block.text);
    }
  }
  return texts.join('\n');
}

/**
 * Build chunks from rollout data.
 */
function rolloutToChunks(
  rollout: RolloutData,
  group: SessionGroup,
  opts: { maxChunks?: number } = {}
): Chunk[] {
  const maxChunks = opts.maxChunks ?? 10;
  const chunks: Chunk[] = [];
  if (!rollout.items) return chunks;

  let chunkCount = 0;
  for (const item of rollout.items) {
    if (chunkCount >= maxChunks) break;

    const text = extractText(item.content);
    if (!text || text.trim().length === 0) continue;

    const content = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (content.length === 0) continue;

    const role = item.role ?? 'unknown';
    const isUser = role === 'user';

    chunks.push({
      type: isUser && chunkCount === 0 ? 'summary' : 'file',
      content,
      session_id: group.session_id,
      session_title: group.title,
      project: group.project,
      repo_path: group.repo_path,
      branch: group.branch,
      agent: 'codex',
      agent_session_id: group.session_id,
      timestamp: group.started_at,
    });
    chunkCount++;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function codexBase(opts: CodexStoreOptions = {}): string {
  return opts.codexDir ?? defaultCodexDir();
}

// ---------------------------------------------------------------------------
// List sessions
// ---------------------------------------------------------------------------

export interface ListCodexSessionsInput {
  limit?: number;
  offset?: number;
  directory_glob?: string;
}

export function listCodexSessions(
  input: ListCodexSessionsInput = {},
  opts: CodexStoreOptions = {}
): SessionGroup[] {
  const db = getDb(opts);
  if (!db) return [];

  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
  const offset = Math.max(0, input.offset ?? 0);
  const where: string[] = ['archived = 0'];
  const params: any[] = [];

  if (input.directory_glob) {
    where.push('LOWER(cwd) LIKE ?');
    params.push(`%${input.directory_glob.toLowerCase()}%`);
  }

  const sql = `
    SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
           cwd, title, first_user_message, tokens_used, git_sha, git_branch,
           git_origin_url, model_provider, source, cli_version, model,
           archived, has_user_event, preview
    FROM threads
    WHERE ${where.join(' AND ')}
    ORDER BY updated_at_ms DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  try {
    const rows = db.query(sql).all(...params) as CodexThreadRow[];
    return rows.map((r) => threadRowToGroup(r));
  } catch (err) {
    logger.debug(`[codex-store] listCodexSessions error: ${err}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Search sessions (text search)
// ---------------------------------------------------------------------------

export interface SearchCodexInput {
  query: string;
  limit?: number;
  depth?: 'text' | 'deep';
  directory_glob?: string;
  per_session_chunks?: number;
}

export function searchCodexSessions(
  input: SearchCodexInput,
  opts: CodexStoreOptions = {}
): ChunkResult[] {
  const db = getDb(opts);
  if (!db) return [];
  if (!input.query || input.query.trim().length === 0) return [];

  const limit = Math.max(1, Math.min(input.limit ?? 8, 10));
  const perSession = Math.max(1, Math.min(input.per_session_chunks ?? 2, 5));

  // Split query into terms; require ALL terms (AND)
  const terms = input.query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return [];

  // First, search the threads table by title and first_user_message
  const whereParts: string[] = ['archived = 0'];
  const params: any[] = [];
  for (const term of terms) {
    whereParts.push('(LOWER(title) LIKE ? OR LOWER(first_user_message) LIKE ?)');
    params.push(`%${term}%`, `%${term}%`);
  }
  if (input.directory_glob) {
    whereParts.push('LOWER(cwd) LIKE ?');
    params.push(`%${input.directory_glob.toLowerCase()}%`);
  }

  const fetchLimit = Math.max(limit * 5, 50);
  const sql = `
    SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
           cwd, title, first_user_message, tokens_used, git_sha, git_branch,
           git_origin_url, model_provider, source, cli_version, model,
           archived, has_user_event, preview
    FROM threads
    WHERE ${whereParts.join(' AND ')}
    ORDER BY updated_at_ms DESC
    LIMIT ?
  `;
  params.push(fetchLimit);

  let rows: CodexThreadRow[] = [];
  try {
    rows = db.query(sql).all(...params) as CodexThreadRow[];
  } catch (err) {
    logger.debug(`[codex-store] searchCodexSessions error: ${err}`);
    return [];
  }

  const out: ChunkResult[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;

    const group = threadRowToGroup(row);
    const title = (row.title || '').toLowerCase();
    const preview = (row.preview || '').toLowerCase();
    const firstMsg = (row.first_user_message || '').toLowerCase();

    // Check if title/preview match
    let matched = false;
    let matchText = '';
    for (const term of terms) {
      if (title.includes(term) || preview.includes(term) || firstMsg.includes(term)) {
        matched = true;
        matchText = row.preview || row.first_user_message || row.title;
        break;
      }
    }

    // If depth is 'deep', also try reading the rollout file
    if (!matched && input.depth === 'deep' && row.rollout_path) {
      const rolloutPath = path.join(codexBase(opts), row.rollout_path);
      const rollout = readRolloutFile(rolloutPath);
      if (rollout?.items) {
        for (const item of rollout.items) {
          const text = extractText(item.content).toLowerCase();
          const allMatch = terms.every((t) => text.includes(t));
          if (allMatch) {
            matched = true;
            matchText = extractText(item.content);
            break;
          }
        }
      }
    }

    if (!matched) continue;

    // Build a chunk from the match
    const content = matchText.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (content.length === 0) continue;

    out.push({
      chunk: {
        type: 'summary',
        content,
        session_id: row.id,
        session_title: group.title,
        project: group.project,
        repo_path: group.repo_path,
        branch: group.branch,
        agent: 'codex',
        agent_session_id: row.id,
        timestamp: group.started_at,
      },
      score: 1,
      memory_id: row.id,
      why: `matched in thread "${group.title}"`,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Get a single session (with chunks)
// ---------------------------------------------------------------------------

export interface CodexSessionDetail extends SessionGroup {
  chunks: Chunk[];
}

/**
 * Read a rollout file through the mtime-invalidated parse cache.
 * On miss, parse + write cache and (best effort) record working-set
 * signals from the parsed chunks.
 */
async function loadRolloutChunksCached(
  sessionId: string,
  rolloutPath: string,
  group: SessionGroup
): Promise<Chunk[] | null> {
  const stat = statSessionFile(rolloutPath);
  const cached = await readSessionCache('codex', sessionId, stat);
  if (cached && Array.isArray(cached.chunks) && cached.chunks.length > 0) {
    return cached.chunks;
  }

  const rollout = readRolloutFile(rolloutPath);
  if (!rollout || !stat) return null;

  const chunks = rolloutToChunks(rollout, group);
  if (chunks.length > 0) {
    await writeSessionCache('codex', sessionId, rolloutPath, stat, { group, chunks });
    // Batch 7 review (I-1): awaited so short-lived CLI processes
    // (`squish sessions show`) persist signals before exit. Only reached
    // on single-session cache misses.
    await recordParsedSessionSignals({
      sessionId: `codex:${sessionId}`,
      projectPath: group.repo_path || undefined,
      chunks: chunks.map((c) => ({ type: c.type, content: c.content })),
    });
  }
  return chunks;
}

export async function getCodexSession(
  sessionId: string,
  opts: CodexStoreOptions = {}
): Promise<CodexSessionDetail | null> {
  const db = getDb(opts);
  if (!db) return null;

  const row = db
    .query(
      `SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
              cwd, title, first_user_message, tokens_used, git_sha, git_branch,
              git_origin_url, model_provider, source, cli_version, model,
              archived, has_user_event, preview
       FROM threads WHERE id = ?`
    )
    .get(sessionId) as CodexThreadRow | null;
  if (!row) return null;

  const group = threadRowToGroup(row);
  let chunks: Chunk[] = [];

  // Try to read the rollout file for full session data (cache-backed)
  if (row.rollout_path) {
    const rolloutPath = path.join(codexBase(opts), row.rollout_path);
    const cachedChunks = await loadRolloutChunksCached(sessionId, rolloutPath, group);
    if (cachedChunks) {
      chunks = cachedChunks;
    } else {
      const rollout = readRolloutFile(rolloutPath);
      if (rollout) {
        chunks = rolloutToChunks(rollout, group);
      }
    }
  }

  // If no chunks from rollout, build a summary from the row data
  if (chunks.length === 0) {
    const summaryContent = row.first_user_message || row.preview || row.title || '';
    if (summaryContent) {
      chunks.push({
        type: 'summary',
        content: summaryContent.replace(/\s+/g, ' ').trim().slice(0, 500),
        session_id: row.id,
        session_title: group.title,
        project: group.project,
        repo_path: group.repo_path,
        branch: group.branch,
        agent: 'codex',
        agent_session_id: row.id,
        timestamp: group.started_at,
      });
    }
  }

  return {
    ...group,
    chunks,
  };
}

// ---------------------------------------------------------------------------
// Find related sessions (by path, branch, or repo)
// ---------------------------------------------------------------------------

export interface FindCodexRelatedInput {
  repo_path?: string;
  files?: string[];
  limit?: number;
}

export function findCodexRelatedSessions(
  input: FindCodexRelatedInput,
  opts: CodexStoreOptions = {}
): Array<{ group: SessionGroup; score: number; reason: string }> {
  if (!input.repo_path && (!input.files || input.files.length === 0)) return [];

  const db = getDb(opts);
  if (!db) return [];

  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const out: Array<{ group: SessionGroup; score: number; reason: string }> = [];

  // Strategy 1: Find sessions with matching cwd
  if (input.repo_path) {
    const targetNorm = input.repo_path.replace(/\\/g, '/').toLowerCase();
    const sql = `
      SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
             cwd, title, first_user_message, tokens_used, git_sha, git_branch,
             git_origin_url, model_provider, source, cli_version, model,
             archived, has_user_event, preview
      FROM threads
      WHERE archived = 0 AND LOWER(cwd) LIKE ?
      ORDER BY updated_at_ms DESC
      LIMIT ?
    `;
    try {
      const rows = db.query(sql).all(`%${targetNorm}%`, limit * 2) as CodexThreadRow[];
      for (const row of rows) {
        if (out.length >= limit) break;
        const group = threadRowToGroup(row);
        const cwdNorm = (row.cwd || '').replace(/\\/g, '/').toLowerCase();
        if (cwdNorm.includes(targetNorm) || targetNorm.includes(cwdNorm)) {
          const reasons: string[] = [`directory match (${deriveProjectName(row.cwd)})`];
          let score = 2;

          // Bonus for matching git branch
          if (row.git_branch) {
            reasons.push(`branch: ${row.git_branch}`);
            score += 1;
          }

          out.push({
            group,
            score,
            reason: reasons.join('; '),
          });
        }
      }
    } catch (err) {
      logger.debug(`[codex-store] findCodexRelatedSessions cwd search error: ${err}`);
    }
  }

  // Strategy 2: Find sessions with matching git_origin_url
  if (input.repo_path && out.length < limit) {
    const sql = `
      SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
             cwd, title, first_user_message, tokens_used, git_sha, git_branch,
             git_origin_url, model_provider, source, cli_version, model,
             archived, has_user_event, preview
      FROM threads
      WHERE archived = 0 AND git_origin_url IS NOT NULL AND git_origin_url != ''
      ORDER BY updated_at_ms DESC
      LIMIT ?
    `;
    try {
      const rows = db.query(sql).all(limit * 2) as CodexThreadRow[];
      const targetLower = input.repo_path.toLowerCase();
      for (const row of rows) {
        if (out.length >= limit) break;
        // Skip if already added
        if (out.some((o) => o.group.session_id === row.id)) continue;

        const originLower = (row.git_origin_url || '').toLowerCase();
        if (originLower && (originLower.includes(targetLower) || targetLower.includes(originLower))) {
          const group = threadRowToGroup(row);
          out.push({
            group,
            score: 1,
            reason: `git origin match (${row.git_origin_url})`,
          });
        }
      }
    } catch (err) {
      logger.debug(`[codex-store] findCodexRelatedSessions origin search error: ${err}`);
    }
  }

  out.sort((a, b) => b.score - a.score || b.group.started_at.localeCompare(a.group.started_at));
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// AgentSessionStore implementation
// ---------------------------------------------------------------------------

/**
 * Codex-backed implementation of `AgentSessionStore`.
 *
 * Reads the user's local Codex SQLite database and rollout JSON files
 * to provide the same session search surface as the OpenCode and
 * Claude Code stores.
 */
export class CodexSessionStore implements AgentSessionStore {
  readonly name: AgentName = 'codex';

  private optsFor(_input?: { directory_glob?: string }): CodexStoreOptions {
    return { readonly: true };
  }

  async available(): Promise<{ ok: boolean; reason?: string; meta?: Record<string, unknown> }> {
    if (process.env.SQUISH_CODEX_DISABLED === '1') {
      return { ok: false, reason: 'codex disabled via SQUISH_CODEX_DISABLED=1' };
    }
    const status = codexDbStatus();
    if (!status.ok) {
      return { ok: false, reason: status.error ?? 'state_5.sqlite not available' };
    }
    return {
      ok: true,
      meta: {
        path: status.path,
        session_count: status.session_count,
        message_count: status.message_count,
      },
    };
  }

  async status(): Promise<{ path: string; size: number; sessions: number; messages: number; parts: number } | null> {
    const s = codexDbStatus();
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
    return listCodexSessions(
      { limit: opts?.limit, offset: opts?.offset, directory_glob: opts?.directory_glob },
      this.optsFor(opts)
    );
  }

  async searchSessions(input: { query: string; limit?: number; depth?: 'text' | 'deep'; directory_glob?: string; per_session_chunks?: number }): Promise<Chunk[]> {
    const results = searchCodexSessions(
      {
        query: input.query,
        limit: input.limit,
        depth: input.depth,
        directory_glob: input.directory_glob,
        per_session_chunks: input.per_session_chunks,
      },
      this.optsFor(input)
    );
    return results.map((r) => r.chunk);
  }

  async getSession(id: string): Promise<{ group: SessionGroup; chunks: Chunk[] } | null> {
    const detail = await getCodexSession(id, this.optsFor({}));
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
    return findCodexRelatedSessions(
      { repo_path: input.repo_path, files: input.files, limit: input.limit },
      this.optsFor({})
    );
  }
}
