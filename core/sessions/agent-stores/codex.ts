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
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { isWithinDirectoryScope, sqliteDirectoryScope } from './path-scope.js';

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
import { allowSessionFileSize, consumeSessionSearchBudget, tokenizeSessionSearchQuery, type AgentSessionStore, type AgentName, type SessionSearchBudget } from './types.js';
import { readSessionCache, statSessionFile, writeSessionCache } from './cache.js';
import { recordParsedSessionSignals } from '../../session/working-set.js';

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

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
  return process.env.SQUISH_CODEX_DIR?.trim() || path.join(os.homedir(), '.codex');
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
  sourceToken: string;
}

let cached: CachedDb | null = null;

function getDb(opts: CodexStoreOptions = {}): Database | null {
  const dbPath = opts.dbPath ?? defaultCodexDbPath();
  if (!fs.existsSync(dbPath)) return null;

  const readonly = opts.readonly !== false;
  const stat = fs.statSync(dbPath, { bigint: true });
  // The host may atomically replace state_5.sqlite while preserving its
  // millisecond mtime. A cached SQLite handle would then keep reading the old
  // inode even though the configured path points at a new database.
  const sourceToken = JSON.stringify([
    stat.mtimeNs.toString(),
    stat.size.toString(),
    stat.ctimeNs.toString(),
    String(stat.dev),
    String(stat.ino),
  ]);

  if (cached && cached.dbPath === dbPath && cached.readonly === readonly && cached.sourceToken === sourceToken) {
    return cached.db;
  }

  try {
    if (cached) {
      try { cached.db.close(); } catch { /* ignore */ }
      cached = null;
    }
    const db = new (DatabaseCtor as any)(dbPath, readonly ? { readonly: true } : undefined);
    cached = { db, dbPath, readonly, sourceToken };
    return db;
  } catch (err) {
    logger.debug('[codex-store] failed to open database', { errorType: errorType(err) });
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

/** Cheap readiness check for searches; detailed thread counts belong to status calls. */
export function codexDbAvailability(opts: CodexStoreOptions = {}) {
  const dbPath = opts.dbPath ?? defaultCodexDbPath();
  if (!fs.existsSync(dbPath)) return { ok: false as const, path: dbPath, error: 'Codex db not found' };
  const db = getDb(opts);
  if (!db) return { ok: false as const, path: dbPath, error: 'failed to open Codex db' };
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'").all() as Array<{ name: string }>;
    if (tables.length === 0) return { ok: false as const, path: dbPath, error: 'Codex db is missing threads table' };
    return { ok: true as const, path: dbPath };
  } catch {
    return { ok: false as const, path: dbPath, error: 'failed to inspect Codex db schema' };
  }
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

export interface CodexTranscriptMessage {
  role: string;
  content: string;
  messageIndex: number;
  sourceFingerprint: string;
}

export interface CodexTranscriptSnapshot {
  sessionId: string;
  projectPath: string;
  messages: CodexTranscriptMessage[];
}

/** Read a bounded, uncached transcript snapshot for internal role-aware capture. */
export function readCodexTranscript(sessionId: string): CodexTranscriptSnapshot | null {
  if (!sessionId.trim() || sessionId.length > 256) return null;
  const base = path.resolve(defaultCodexDir());
  const db = getDb({ readonly: true });
  if (!db) return null;
  const row = db.query('SELECT id, rollout_path, cwd FROM threads WHERE id = ?').get(sessionId) as
    { id: string; rollout_path: string; cwd: string } | null;
  if (!row || !row.rollout_path) return null;
  const transcriptPath = path.resolve(base, row.rollout_path);
  if (!isWithinDirectoryScope(transcriptPath, base)) return null;
  try {
    const realBase = fs.realpathSync(base);
    const realTranscriptPath = fs.realpathSync(transcriptPath);
    if (!isWithinDirectoryScope(realTranscriptPath, realBase)) return null;
    const stat = fs.statSync(realTranscriptPath);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return null;
    const raw = fs.readFileSync(realTranscriptPath, 'utf8');
    const rollout = parseRolloutContent(raw);
    if (!rollout || rollout.session?.id && rollout.session.id !== sessionId || !rollout.items) return null;
    const messages: CodexTranscriptMessage[] = [];
    for (const [messageIndex, item] of rollout.items.entries()) {
      const role = item.role;
      // Session capture persists user, assistant, and system turns. Tool and
      // unknown roles are not part of that policy and must never be promoted
      // into captured memories or analysis jobs.
      if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
      const content = extractText(item.content).trim();
      if (!role || !content || content.length > 20_000) continue;
      const sourceFingerprint = createHash('sha256')
        .update(JSON.stringify(['codex-message-v1', sessionId, messageIndex, role, content]))
        .digest('hex');
      messages.push({ role, content, messageIndex, sourceFingerprint });
      if (messages.length >= 200) break;
    }
    return { sessionId, projectPath: row.cwd ?? '', messages };
  } catch {
    return null;
  }
}

/**
 * Read either a legacy JSON rollout or the current newline-delimited event log.
 */
function readRolloutFile(filePath: string): RolloutData | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseRolloutContent(content);
  } catch (err) {
    logger.debug('[codex-store] failed to read rollout', { errorType: errorType(err) });
    return null;
  }
}

function parseRolloutContent(content: string): RolloutData | null {
  try {
    try {
      const legacy = JSON.parse(content) as RolloutData;
      if (Array.isArray(legacy.items)) return legacy;
    } catch {
      // Current rollout files contain one JSON record per line.
    }

    const items: RolloutItem[] = [];
    let session: RolloutSession | undefined;
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record: { type?: string; payload?: Record<string, unknown> };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        continue;
      }
      const payload = record.payload;
      if (!payload) continue;
      if (record.type === 'session_meta') {
        session = {
          id: typeof payload.id === 'string' ? payload.id : undefined,
          timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : undefined,
        };
      } else if (record.type === 'response_item' && payload.type === 'message') {
        const role = typeof payload.role === 'string' ? payload.role : undefined;
        const blocks = Array.isArray(payload.content)
          ? payload.content as Array<{ type: string; text?: string }>
          : undefined;
        if (role && blocks) items.push({ role, content: blocks });
      } else if (record.type === 'event_msg' && payload.type === 'user_message') {
        const message = typeof payload.message === 'string' ? payload.message : undefined;
        if (message) items.push({ role: 'user', content: message });
      }
    }
    return { session, items };
  } catch {
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

/** Search a current event-log rollout incrementally so one session cannot be loaded in full. */
async function findRolloutMatch(filePath: string, terms: string[], metadataText = ''): Promise<{ text: string; sourceRole?: string } | null> {
  if (!fs.existsSync(filePath)) return null;
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const evidenceByTerm = new Map<string, { text: string; sourceRole?: string }>();
  const addEvidence = (text: string, sourceRole?: string): boolean => {
    const lower = text.toLowerCase();
    for (const term of terms) {
      if (evidenceByTerm.has(term)) continue;
      const index = lower.indexOf(term);
      if (index < 0) continue;
      const start = Math.max(0, index - 160);
      const end = Math.min(text.length, index + term.length + 160);
      evidenceByTerm.set(term, { text: text.slice(start, end).trim(), sourceRole });
    }
    return evidenceByTerm.size === terms.length;
  };
  addEvidence(metadataText);
  const matchedEvidence = () => {
    const evidence = [...new Map([...evidenceByTerm.values()].map((item) => [item.text, item])).values()];
    const roles = new Set(evidence.map((item) => item.sourceRole).filter((role): role is string => Boolean(role)));
    const hasUnattributedEvidence = evidence.some((item) => !item.sourceRole);
    const sourceRole = !hasUnattributedEvidence && roles.size === 1 ? [...roles][0] : undefined;
    return { text: evidence.map((item) => item.text).join(' … '), ...(sourceRole ? { sourceRole } : {}) };
  };
  let firstRecord = true;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        firstRecord = false;
        continue;
      }

      if (firstRecord) {
        firstRecord = false;
        const legacy = parsed as RolloutData;
        if (legacy && Array.isArray(legacy.items)) {
          lines.close();
          input.destroy();
          for (const item of legacy.items) {
            if (addEvidence(extractText(item.content), item.role)) return matchedEvidence();
          }
          return null;
        }
      }

      const record = parsed as { type?: string; payload?: Record<string, unknown> };
      const payload = record.payload;
      if (!payload) continue;
      let item: RolloutItem | null = null;
      if (record.type === 'response_item' && payload.type === 'message') {
        const role = typeof payload.role === 'string' ? payload.role : undefined;
        const blocks = Array.isArray(payload.content)
          ? payload.content as Array<{ type: string; text?: string }>
          : undefined;
        if (role && blocks) item = { role, content: blocks };
      } else if (record.type === 'event_msg' && payload.type === 'user_message') {
        const message = typeof payload.message === 'string' ? payload.message : undefined;
        if (message) item = { role: 'user', content: message };
      }
      const text = extractText(item?.content);
      if (addEvidence(text, item?.role)) return matchedEvidence();
    }
  } catch (error) {
    logger.debug('[codex-store] failed to stream rollout', { errorType: errorType(error) });
  } finally {
    lines.close();
    input.destroy();
  }
  return null;
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
      sourceRole: role,
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

function resolveCodexRolloutPath(baseDir: string, rolloutPath: string): string | null {
  try {
    const base = path.resolve(baseDir);
    const candidate = path.resolve(base, rolloutPath);
    if (!isWithinDirectoryScope(candidate, base)) return null;
    const realBase = fs.realpathSync(base);
    const realCandidate = fs.realpathSync(candidate);
    if (!isWithinDirectoryScope(realCandidate, realBase) || !fs.statSync(realCandidate).isFile()) return null;
    return realCandidate;
  } catch {
    return null;
  }
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
    const scope = sqliteDirectoryScope('cwd', input.directory_glob);
    where.push(scope.clause);
    params.push(...scope.params);
  }

  const sql = `
    SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
           cwd, title, first_user_message, tokens_used, git_sha, git_branch,
           git_origin_url, model_provider, source, cli_version, model,
           archived, has_user_event, preview
    FROM threads
    WHERE ${where.join(' AND ')}
    ORDER BY updated_at_ms DESC, id DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  try {
    const rows = db.query(sql).all(...params) as CodexThreadRow[];
    return rows.map((r) => threadRowToGroup(r));
  } catch (err) {
    logger.debug('[codex-store] list sessions failed', { errorType: errorType(err) });
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
  scanBudget?: SessionSearchBudget;
}

export async function searchCodexSessions(
  input: SearchCodexInput,
  opts: CodexStoreOptions = {}
): Promise<ChunkResult[]> {
  const db = getDb(opts);
  if (!db) return [];
  if (!input.query || input.query.trim().length === 0) return [];

  const limit = Math.max(1, Math.min(input.limit ?? 8, 10));
  const perSession = Math.max(1, Math.min(input.per_session_chunks ?? 2, 5));

  // Split query into terms; require ALL terms (AND)
  const terms = tokenizeSessionSearchQuery(input.query);
  if (terms.length === 0) return [];

  // Search project-scoped thread pages from newest to oldest, inspecting
  // rollout transcripts when indexed title/preview metadata does not match.
  // Archived threads still point to durable rollout transcripts and are
  // searchable history. Keep active-only filtering for list/related views.
  const whereParts: string[] = ['1 = 1'];
  const params: any[] = [];
  if (input.directory_glob) {
    const scope = sqliteDirectoryScope('cwd', input.directory_glob);
    whereParts.push(scope.clause);
    params.push(...scope.params);
  }

  const pageSize = Math.max(limit * 50, 500);
  const sql = `
    SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
           cwd, title, first_user_message, tokens_used, git_sha, git_branch,
           git_origin_url, model_provider, source, cli_version, model,
           archived, has_user_event, preview
    FROM threads
    WHERE ${whereParts.join(' AND ')}
    ORDER BY updated_at_ms DESC
    LIMIT ? OFFSET ?
  `;

  const out: ChunkResult[] = [];
  let offset = 0;
  while (out.length < limit) {
    let rows: CodexThreadRow[];
    try {
      rows = db.query(sql).all(...params, pageSize, offset) as CodexThreadRow[];
    } catch (err) {
      logger.debug('[codex-store] search sessions failed', { errorType: errorType(err) });
      return out;
    }
    if (rows.length === 0) break;
    offset += rows.length;

    for (const row of rows) {
      if (out.length >= limit) break;
      if (!consumeSessionSearchBudget(input.scanBudget)) return out;

      const group = threadRowToGroup(row);
      const title = (row.title || '').toLowerCase();
      const preview = (row.preview || '').toLowerCase();
      const firstMsg = (row.first_user_message || '').toLowerCase();

      const metadataText = `${title} ${preview} ${firstMsg}`;
      let matched = terms.every((term) => metadataText.includes(term));
      let matchText = matched ? row.preview || row.first_user_message || row.title : '';
      let matchRole: string | undefined;

      // Read actual transcript content when the lightweight SQLite fields miss.
      if (!matched && row.rollout_path) {
        const rolloutPath = resolveCodexRolloutPath(codexBase(opts), row.rollout_path);
        if (!rolloutPath) continue;
        try {
          if (fs.existsSync(rolloutPath) && !allowSessionFileSize(input.scanBudget, fs.statSync(rolloutPath).size)) continue;
        } catch {
          // Let the streaming reader handle missing or inaccessible rollout files.
        }
        const found = await findRolloutMatch(rolloutPath, terms, metadataText);
        if (found) {
          matched = true;
          matchText = found.text;
          matchRole = found.sourceRole;
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
          ...(matchRole ? { sourceRole: matchRole } : {}),
          timestamp: group.started_at,
        },
        score: 1,
        memory_id: row.id,
        why: `matched in thread "${group.title}"`,
      });
    }
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
  const cached = await readSessionCache('codex', sessionId, rolloutPath, stat);
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
    const rolloutPath = resolveCodexRolloutPath(codexBase(opts), row.rollout_path);
    if (rolloutPath) {
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
    const scope = sqliteDirectoryScope('cwd', input.repo_path);
    const sql = `
      SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
             cwd, title, first_user_message, tokens_used, git_sha, git_branch,
             git_origin_url, model_provider, source, cli_version, model,
             archived, has_user_event, preview
      FROM threads
      WHERE archived = 0 AND ${scope.clause}
      ORDER BY updated_at_ms DESC
      LIMIT ?
    `;
    try {
      const rows = db.query(sql).all(...scope.params, limit * 2) as CodexThreadRow[];
      for (const row of rows) {
        if (out.length >= limit) break;
        const group = threadRowToGroup(row);
        if (isWithinDirectoryScope(row.cwd || '', input.repo_path)) {
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
      logger.debug('[codex-store] related-session directory search failed', { errorType: errorType(err) });
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
      logger.debug('[codex-store] related-session origin search failed', { errorType: errorType(err) });
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

  private readonly storeOpts: CodexStoreOptions;

  constructor(opts: CodexStoreOptions = {}) {
    this.storeOpts = opts;
  }

  private optsFor(_input?: { directory_glob?: string }): CodexStoreOptions {
    return { ...this.storeOpts, readonly: true };
  }

  async available(): Promise<{ ok: boolean; reason?: string; meta?: Record<string, unknown> }> {
    if (process.env.SQUISH_CODEX_DISABLED === '1') {
      return { ok: false, reason: 'codex disabled via SQUISH_CODEX_DISABLED=1' };
    }
    const availability = codexDbAvailability(this.optsFor());
    if (!availability.ok) {
      return { ok: false, reason: availability.error ?? 'state_5.sqlite not available' };
    }
    return {
      ok: true,
      meta: { path: availability.path },
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

  async searchSessions(input: { query: string; limit?: number; depth?: 'text' | 'deep'; directory_glob?: string; per_session_chunks?: number; scanBudget?: SessionSearchBudget }): Promise<Chunk[]> {
    const results = await searchCodexSessions(
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
