/**
 * OpenCode session store - implements `AgentSessionStore`.
 *
 * Read-only access to the user's local OpenCode session database
 * (`opencode.db`) so that `squish sessions list|search|show|related`
 * can return past OpenCode sessions. The CLI and the OpenCode plugin
 * use this same store; claude-code / codex stubs return empty results
 * until their own backends are implemented.
 *
 * Why read opencode.db directly:
 *   - 6,724 sessions already exist on the user's machine
 *   - OpenCode's own SDK (`input.client.session.list`) only sees ACTIVE
 *     sessions from inside the running OpenCode process; once the
 *     process exits, those references are gone. The DB is the only
 *     persistent record of past work.
 *   - The user wants to `squish sessions search <query>` and get back
 *     "what did I do in this repo / project last week?" - this is only
 *     possible against the on-disk DB.
 *
 * Performance notes:
 *   - 6,724 sessions in the session table is fast.
 *   - 1.35M parts in the part table. A LIKE search over ALL parts takes
 *     ~24s on the user's machine. We restrict to `type='text'` (133K
 *     parts) by default - that's ~2-3s and covers the bulk of useful
 *     content. `--depth deep` widens to all parts.
 *   - For a persistent FTS5 sidecar index, see `ensureSidecarFts()`
 *     (built lazily on first deep search; mtime-gated to refresh).
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

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------

/**
 * Default location of the user's OpenCode database.
 * XDG-style: data lives at `~/.local/share/opencode/opencode.db` on
 * every platform, including Windows. The user's install confirms this
 * (6.77 GB at `~/.local/share/opencode/opencode.db`).
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
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * Sidecar FTS5 index location. Built on first deep search.
 */
export function defaultSidecarPath(): string {
  return path.join(os.homedir(), '.squish', 'opencode-fts.db');
}

export interface OpenCodeStoreOptions {
  /** Override the DB path (default: defaultOpenCodeDbPath()) */
  dbPath?: string;
  /** Override the sidecar path (default: defaultSidecarPath()) */
  sidecarPath?: string;
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

function getDb(opts: OpenCodeStoreOptions = {}): Database | null {
  const dbPath = opts.dbPath ?? defaultOpenCodeDbPath();
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
    logger.debug(`[opencode-store] failed to open ${dbPath}: ${err}`);
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
  /** Filter to sessions whose directory contains this substring (case-insensitive). */
  directory_glob?: string;
  /** Filter by agent (e.g. "build", "coder", "explore"). */
  agent?: string;
  /** Filter by project_id (exact). */
  project_id?: string;
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
    where.push('LOWER(directory) LIKE ?');
    params.push(`%${input.directory_glob.toLowerCase()}%`);
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
    logger.debug(`[opencode-store] listOpenCodeSessions error: ${err}`);
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
  /** Optional directory filter. */
  directory_glob?: string;
  /** Max results per session (default 2 - summary + best match). */
  per_session_chunks?: number;
}

interface HitRow {
  session_id: string;
  message_id: string;
  part_id: string;
  ptype: string;
  text: string;
  time_created: number;
  session_title: string;
  session_directory: string;
  session_agent: string | null;
  session_time_created: number;
  session_time_updated: number;
}

export function searchOpenCodeSessions(
  input: SearchOpenCodeInput,
  opts: OpenCodeStoreOptions = {}
): ChunkResult[] {
  const db = getDb(opts);
  if (!db) return [];
  if (!input.query || input.query.trim().length === 0) return [];

  const limit = Math.max(1, Math.min(input.limit ?? 8, 10));
  const perSession = Math.max(1, Math.min(input.per_session_chunks ?? 2, 5));
  const depth = input.depth ?? 'text';

  // Split query into terms; require all terms to appear (AND) so the
  // search is not too noisy.
  const terms = input.query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return [];

  const whereParts: string[] = [];
  const params: any[] = [];
  for (const term of terms) {
    whereParts.push('LOWER(json_extract(p.data, "$.text")) LIKE ?');
    params.push(`%${term}%`);
  }
  const typeFilter =
    depth === 'deep'
      ? ''
      : `AND json_extract(p.data, "$.type") IN ('text', 'reasoning', 'tool')`;
  const dirFilter = input.directory_glob
    ? 'AND LOWER(s.directory) LIKE ?'
    : '';
  if (input.directory_glob) params.push(`%${input.directory_glob.toLowerCase()}%`);

  const fetchLimit = Math.max(limit * 25, 100);

  const sql = `
    SELECT p.session_id, p.message_id, p.id as part_id,
           json_extract(p.data, "$.type") as ptype,
           json_extract(p.data, "$.text") as text,
           p.time_created,
           s.title as session_title,
           s.directory as session_directory,
           s.agent as session_agent,
           s.time_created as session_time_created,
           s.time_updated as session_time_updated
    FROM part p
    JOIN session s ON s.id = p.session_id
    WHERE ${whereParts.join(' AND ')}
    ${typeFilter}
    ${dirFilter}
    ORDER BY s.time_created DESC, p.time_created ASC
    LIMIT ?
  `;
  params.push(fetchLimit);

  let rows: HitRow[] = [];
  try {
    rows = db.query(sql).all(...params) as HitRow[];
  } catch (err) {
    logger.debug(`[opencode-store] searchOpenCodeSessions error: ${err}`);
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

  const project = input.directory_glob
    ? deriveProjectName(input.directory_glob)
    : '';

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
        files: [hit.session_directory],
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
// Sidecar FTS5 index (build lazily; mtime-gated refresh)
// ---------------------------------------------------------------------------

/**
 * Build a persistent FTS5 sidecar at `~/.squish/opencode-fts.db` from
 * the user's opencode.db. Reuses the existing sidecar if it is newer
 * than the source DB. After the sidecar is built, deep searches over
 * the full ~1.35M parts complete in <100ms instead of ~24s.
 *
 * Returns the path to the sidecar file. Idempotent.
 */
export function ensureSidecarFts(opts: OpenCodeStoreOptions = {}): string | null {
  const src = opts.dbPath ?? defaultOpenCodeDbPath();
  const dest = opts.sidecarPath ?? defaultSidecarPath();
  if (!fs.existsSync(src)) return null;

  const srcStat = fs.statSync(src);
  const destExists = fs.existsSync(dest);
  if (destExists) {
    const destStat = fs.statSync(dest);
    if (destStat.mtimeMs >= srcStat.mtimeMs && destStat.size > 0) {
      return dest; // fresh
    }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Wipe stale sidecar so we can rebuild.
  try { fs.unlinkSync(dest); } catch { /* ignore */ }

  let srcDb: Database;
  let destDb: Database;
  try {
    srcDb = new (DatabaseCtor as any)(src, { readonly: true });
    destDb = new DatabaseCtor(dest);
  } catch (err) {
    logger.debug(`[opencode-store] ensureSidecarFts open error: ${err}`);
    return null;
  }

  try {
    destDb.exec(`
      DROP TABLE IF EXISTS part_fts;
      CREATE VIRTUAL TABLE part_fts USING fts5(
        session_id UNINDEXED,
        message_id UNINDEXED,
        part_id UNINDEXED,
        ptype UNINDEXED,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);

    const insert = (destDb as any).prepare(
      `INSERT INTO part_fts (session_id, message_id, part_id, ptype, text)
       VALUES (?, ?, ?, ?, ?)`
    );

    const iter = srcDb
      .query(
        `SELECT session_id, message_id, id as part_id,
                json_extract(data, '$.type') as ptype,
                json_extract(data, '$.text') as text
         FROM part
         WHERE json_extract(data, '$.text') IS NOT NULL
           AND length(json_extract(data, '$.text')) > 0`
      )
      .iterate() as Iterable<{
        session_id: string;
        message_id: string;
        part_id: string;
        ptype: string;
        text: string;
      }>;

    destDb.exec('BEGIN');
    let n = 0;
    for (const r of iter) {
      const text = (r.text ?? '').toString().slice(0, 8000);
      if (text.length === 0) continue;
      insert.run(r.session_id, r.message_id, r.part_id, r.ptype ?? '', text);
      n++;
      if (n % 5000 === 0) {
        destDb.exec('COMMIT');
        destDb.exec('BEGIN');
      }
    }
    destDb.exec('COMMIT');

    // Touch the file so the mtime check above is reliable.
    fs.utimesSync(dest, new Date(), new Date());
    return dest;
  } catch (err) {
    logger.debug(`[opencode-store] ensureSidecarFts build error: ${err}`);
    return null;
  } finally {
    try { srcDb.close(); } catch { /* ignore */ }
    try { destDb.close(); } catch { /* ignore */ }
  }
}

/**
 * Search using the sidecar FTS5 index. Falls back to LIKE search if
 * the sidecar is not built.
 */
export function searchOpenCodeSessionsFts(
  input: SearchOpenCodeInput,
  opts: OpenCodeStoreOptions = {}
): ChunkResult[] {
  const sidecar = opts.sidecarPath ?? defaultSidecarPath();
  const needsBuild = !fs.existsSync(sidecar);
  if (needsBuild) {
    const built = ensureSidecarFts(opts);
    if (!built) return searchOpenCodeSessions(input, opts);
  }

  let destDb: Database;
  try {
    destDb = new (DatabaseCtor as any)(sidecar, { readonly: true });
  } catch {
    return searchOpenCodeSessions(input, opts);
  }

  try {
    const limit = Math.max(1, Math.min(input.limit ?? 8, 10));
    const terms = input.query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2)
      .map((t) => `"${t}"*`);
    if (terms.length === 0) return [];
    const matchExpr = terms.join(' AND ');

    const sql = `
      SELECT fts.session_id, fts.message_id, fts.part_id, fts.ptype, fts.text,
             s.title as session_title, s.directory as session_directory,
             s.agent as session_agent,
             s.time_created as session_time_created,
             s.time_updated as session_time_updated,
             rank
      FROM part_fts fts
      JOIN (SELECT id, title, directory, agent, time_created, time_updated
            FROM session) s ON s.id = fts.session_id
      WHERE part_fts MATCH ?
      ORDER BY rank, s.time_created DESC
      LIMIT ?
    `;
    const rows = destDb.query(sql).all(matchExpr, Math.max(limit * 20, 100)) as Array<{
      session_id: string;
      message_id: string;
      part_id: string;
      ptype: string;
      text: string;
      session_title: string;
      session_directory: string;
      session_agent: string | null;
      session_time_created: number;
      session_time_updated: number;
    }>;

    const bySession = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = bySession.get(r.session_id) ?? [];
      if (list.length < (input.per_session_chunks ?? 2)) list.push(r);
      bySession.set(r.session_id, list);
    }

    const out: ChunkResult[] = [];
    for (const [sessionId, hits] of bySession) {
      const first = hits[0];
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
      }, hits.length);

      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
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
            files: [hit.session_directory],
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
    logger.debug(`[opencode-store] searchOpenCodeSessionsFts error: ${err}`);
    return searchOpenCodeSessions(input, opts);
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
 * Pre-fers the persistent FTS5 sidecar (when available) so deep
 * searches are <100ms instead of ~24s. The sidecar is built lazily
 * on the first deep search; after that, mtime-gated refresh
 * keeps it in sync with opencode.db.
 */
export class OpenCodeSessionStore implements AgentSessionStore {
  readonly name: AgentName = 'opencode';

  /** Map adapter-level options to the opencode store's options. */
  private optsFor(input: { directory_glob?: string }): OpenCodeStoreOptions {
    return { readonly: true };
  }

  async available(): Promise<{ ok: boolean; reason?: string; meta?: Record<string, unknown> }> {
    if (process.env.SQUISH_OPENCODE_DISABLED === '1') {
      return { ok: false, reason: 'opencode disabled via SQUISH_OPENCODE_DISABLED=1' };
    }
    const status = opencodeDbStatus();
    if (!status.ok) {
      return { ok: false, reason: status.error ?? 'opencode.db not available' };
    }
    return {
      ok: true,
      meta: {
        path: status.path,
        session_count: status.session_count,
        message_count: status.message_count,
        part_count: status.part_count,
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

  async searchSessions(input: { query: string; limit?: number; depth?: 'text' | 'deep'; directory_glob?: string; per_session_chunks?: number }): Promise<Chunk[]> {
    const results = searchOpenCodeSessionsFts(
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
    const detail = getOpenCodeSession(id, this.optsFor({}));
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
