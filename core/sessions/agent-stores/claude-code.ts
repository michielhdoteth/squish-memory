/**
 * Claude Code session store - implements `AgentSessionStore`.
 *
 * Read-only access to the user's local Claude Code session logs
 * (`~/.claude/history.jsonl` and `~/.claude/projects/<hash>/*.jsonl`)
 * so that `squish sessions list|search|show|related` can return past
 * Claude Code sessions.
 *
 * Storage format:
 *   - `~/.claude/history.jsonl` — session index. Each line is:
 *       { display, pastedContents, timestamp (epoch ms), project (Windows path), sessionId }
 *   - `~/.claude/projects/<project-hash>/<session-id>.jsonl` — messages.
 *       Each line has: { type, message, uuid, timestamp, ... }
 *     User messages:      { type: "user", message: { role: "user", content: "..." } }
 *     Assistant messages: { type: "assistant", message: { role: "assistant", content: [...] } }
 *
 * Project hash: the project path with `:` and `\` replaced by `-`.
 *   e.g. `C:\Users\user\projects\my-app` -> `C--Users-user-projects-my-app`
 *
 * Public surface consumed by:
 *   - core/sessions/store.ts (the public sessions surface)
 *   - packages/cli/src/commands/sessions.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { logger } from '../../logger.js';
import type { Chunk, ChunkResult, SessionGroup } from '../types.js';
import { allowSessionFileSize, consumeSessionSearchBudget, markSessionSearchTruncated, tokenizeSessionSearchQuery, type AgentSessionStore, type AgentName, type SessionSearchBudget } from './types.js';
import { readSessionCache, statSessionFile, writeSessionCache } from './cache.js';
import { isWithinDirectoryScope } from './path-scope.js';
import { recordParsedSessionSignals } from '../../session/working-set.js';

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------

/**
 * Default location of the Claude Code data directory.
 * `~/.claude/` on all platforms including Windows.
 */
export function defaultClaudeDir(): string {
  const override = process.env.SQUISH_CLAUDE_DIR?.trim();
  if (override) return path.resolve(override);
  if (process.env.SQUISH_CLAUDE_DISABLED === '1') {
    return path.join(os.homedir(), '.squish', 'claude-disabled-for-tests');
  }
  return path.join(os.homedir(), '.claude');
}

export interface ClaudeTranscriptMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageIndex: number;
  sourceFingerprint: string;
}

export interface ClaudeTranscriptSnapshot {
  sessionId: string;
  projectPath: string;
  messages: ClaudeTranscriptMessage[];
}

/** Read a bounded, uncached snapshot whose role and project come from local structured records. */
export function readClaudeTranscript(sessionId: string): ClaudeTranscriptSnapshot | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  const claudeDir = path.resolve(defaultClaudeDir());
  const entry = readHistoryIndex(claudeDir).find((candidate) => candidate.sessionId === sessionId);
  if (!entry?.project) return null;
  const projectsDir = path.resolve(claudeDir, 'projects');
  const projectDir = path.resolve(projectsDir, projectHash(entry.project));
  const transcriptPath = path.resolve(projectDir, `${sessionId}.jsonl`);
  if (!isWithinDirectoryScope(projectDir, projectsDir) || !isWithinDirectoryScope(transcriptPath, projectDir)) return null;

  try {
    const realClaudeDir = fs.realpathSync(claudeDir);
    const realProjectsDir = fs.realpathSync(projectsDir);
    if (!isWithinDirectoryScope(realProjectsDir, realClaudeDir)) return null;
    const realProjectDir = fs.realpathSync(projectDir);
    const realTranscriptPath = fs.realpathSync(transcriptPath);
    if (!isWithinDirectoryScope(realProjectDir, realProjectsDir)
      || !isWithinDirectoryScope(realTranscriptPath, realProjectDir)) return null;
    const stat = fs.statSync(realTranscriptPath);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return null;
    const raw = fs.readFileSync(realTranscriptPath, 'utf8');
    const messages: ClaudeTranscriptMessage[] = [];
    for (const [messageIndex, line] of raw.split('\n').entries()) {
      if (!line.trim()) continue;
      let parsed: RawMessage;
      try { parsed = JSON.parse(line) as RawMessage; } catch { continue; }
      if (parsed.sessionId && parsed.sessionId !== sessionId) return null;
      if (parsed.type !== 'user' && parsed.type !== 'assistant' && parsed.type !== 'system') continue;
      if (!transcriptCwdMatchesProject(parsed.cwd, entry.project)) continue;
      const role = parsed.message?.role;
      if (role !== parsed.type) continue;
      const content = extractText(parsed.message?.content).trim();
      if (!content || content.length > 20_000) continue;
      const sourceFingerprint = createHash('sha256')
        .update(JSON.stringify(['claude-message-v1', sessionId, messageIndex, role, content]))
        .digest('hex');
      messages.push({ role, content, messageIndex, sourceFingerprint });
      if (messages.length >= 200) break;
    }
    return messages.length ? { sessionId, projectPath: entry.project, messages } : null;
  } catch {
    return null;
  }
}

export interface ClaudeCodeStoreOptions {
  /** Override the base directory (default: defaultClaudeDir()) */
  claudeDir?: string;
  /** Bound history index reads; defaults to 8 MiB and cannot exceed 32 MiB. */
  maxHistoryIndexBytes?: number;
}

const DEFAULT_HISTORY_INDEX_MAX_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_INDEX_BYTES = 32 * 1024 * 1024;

function historyIndexByteLimit(value?: number): number {
  if (!Number.isInteger(value)) return DEFAULT_HISTORY_INDEX_MAX_BYTES;
  return Math.max(1024, Math.min(value!, MAX_HISTORY_INDEX_BYTES));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function epochToIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Compute the project-hash directory name used in `~/.claude/projects/`.
 * Claude Code replaces `:` and `\` with `-` in the absolute path.
 */
function projectHash(projectPath: string): string {
  return projectPath.replace(/:/g, '-').replace(/\\/g, '-');
}

/** A transcript cwd must overlap the history index project before attribution. */
function transcriptCwdMatchesProject(cwd: unknown, projectPath: string): boolean {
  if (typeof cwd !== 'string' || !cwd.trim()) return true;
  return isWithinDirectoryScope(cwd, projectPath) || isWithinDirectoryScope(projectPath, cwd);
}

/**
 * Extract the leaf project name from a path (e.g. `C:\Users\user\projects\foo` -> `foo`).
 */
function deriveProjectName(projectPath: string): string {
  if (!projectPath) return '';
  const norm = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm === '/' || /^[A-Z]:$/.test(norm)) return projectPath;
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

/**
 * Trim and collapse whitespace in a string for chunk content.
 */
function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// History.jsonl parsing (session index)
// ---------------------------------------------------------------------------

interface HistoryEntry {
  display: string;
  pastedContents?: Record<string, unknown>;
  timestamp: number;
  project: string;
  sessionId: string;
}

/**
 * Read and parse `~/.claude/history.jsonl`. Returns all history entries
 * sorted by timestamp descending (newest first).
 */
function readHistoryIndex(
  claudeDir: string,
  maxBytes = DEFAULT_HISTORY_INDEX_MAX_BYTES,
  budget?: SessionSearchBudget,
): HistoryEntry[] {
  const historyPath = path.join(claudeDir, 'history.jsonl');
  if (!fs.existsSync(historyPath)) return [];

  try {
    const limit = historyIndexByteLimit(maxBytes);
    const stat = fs.statSync(historyPath);
    const truncated = stat.size > limit;
    const bytesToRead = Math.min(stat.size, limit);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const fd = fs.openSync(historyPath, 'r');
    let bytesRead = 0;
    try {
      while (bytesRead < bytesToRead) {
        const count = fs.readSync(fd, buffer, bytesRead, bytesToRead - bytesRead, stat.size - bytesToRead + bytesRead);
        if (count === 0) break;
        bytesRead += count;
      }
    } finally {
      fs.closeSync(fd);
    }
    let content = buffer.toString('utf-8', 0, bytesRead);
    if (truncated) {
      const firstLineEnd = content.indexOf('\n');
      content = firstLineEnd < 0 ? '' : content.slice(firstLineEnd + 1);
      if (budget) markSessionSearchTruncated(budget, 'history_index_limit');
    }
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as HistoryEntry;
        if (parsed.sessionId && parsed.timestamp) {
          entries.push(parsed);
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }
    // Sort newest first
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries;
  } catch (err) {
    logger.debug('[claude-code-store] failed to read history index', { errorType: errorType(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Session message parsing
// ---------------------------------------------------------------------------

interface RawMessage {
  type: 'user' | 'assistant' | 'mode' | 'permission-mode' | 'file-history-snapshot' | 'attachment' | 'ai-title' | 'last-prompt' | 'system' | 'queue-operation' | string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string; name?: string; input?: unknown }>;
    model?: string;
    stop_reason?: string;
  };
  uuid?: string;
  // Batch 7 review (M-6): real transcripts carry both epoch-ms numbers and
  // ISO strings depending on Claude Code version. Normalize on parse.
  timestamp?: string | number;
  cwd?: string;
  sessionId?: string;
  version?: string;
  gitBranch?: string;
}

/**
 * Locate the JSONL file for a specific session.
 * Looks in `~/.claude/projects/<hash>/<sessionId>.jsonl`.
 */
function findSessionFile(claudeDir: string, sessionId: string, projectPath?: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  const resolveTranscript = (candidate: string, expectedProjectDir: string): string | null => {
    try {
      const realClaudeDir = fs.realpathSync(claudeDir);
      const realProjectsDir = fs.realpathSync(projectsDir);
      const realProjectDir = fs.realpathSync(expectedProjectDir);
      const canonicalProjectDir = path.resolve(realProjectsDir, path.basename(expectedProjectDir));
      const realTranscriptPath = fs.realpathSync(candidate);
      if (!isWithinDirectoryScope(realProjectsDir, realClaudeDir)
        || realProjectDir.toLowerCase().replace(/\\/g, '/') !== canonicalProjectDir.toLowerCase().replace(/\\/g, '/')
        || !isWithinDirectoryScope(realTranscriptPath, realProjectDir)
        || !fs.statSync(realTranscriptPath).isFile()) return null;
      return realTranscriptPath;
    } catch {
      return null;
    }
  };

  // If we know the project path, check that specific directory first
  if (projectPath) {
    const expectedProjectDir = path.join(projectsDir, projectHash(projectPath));
    const candidate = path.join(expectedProjectDir, `${sessionId}.jsonl`);
    return resolveTranscript(candidate, expectedProjectDir);
  }

  // Search all project directories only when the history index did not
  // provide a project. A scoped entry must never resolve to another
  // project's transcript when its expected file is missing.
  try {
    const dirs = fs.readdirSync(projectsDir);
    for (const dir of dirs) {
      const expectedProjectDir = path.join(projectsDir, dir);
      const candidate = path.join(expectedProjectDir, `${sessionId}.jsonl`);
      const resolved = resolveTranscript(candidate, expectedProjectDir);
      if (resolved) return resolved;
    }
  } catch (err) {
    logger.debug('[claude-code-store] failed to search session directories', { errorType: errorType(err) });
  }

  return null;
}

/**
 * Read all messages from a session JSONL file.
 */
function readSessionMessages(filePath: string): RawMessage[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const messages: RawMessage[] = [];
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as RawMessage);
      } catch {
        // Skip malformed lines
        continue;
      }
    }
    return messages;
  } catch (err) {
    logger.debug('[claude-code-store] failed to read session file', { errorType: errorType(err) });
    return [];
  }
}

/**
 * Extract plain text content from a message's content field.
 * Content can be a string or an array of content blocks. Tool-use blocks
 * are summarized conservatively (name + one-line target) and huge tool
 * payloads are skipped.
 */
function extractText(content: string | Array<{ type: string; text?: string; name?: string; input?: unknown }> | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  // Array of content blocks — extract text blocks, summarize tool_use
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      texts.push(block.text);
    } else if (block.type === 'tool_use' && block.name) {
      const input = block.input as Record<string, unknown> | undefined;
      const target =
        input?.filePath ?? input?.path ?? input?.command ?? input?.description ?? '';
      texts.push(
        `[tool:${block.name}] ${String(target).slice(0, 120)}`
      );
    }
  }
  return texts.join('\n');
}

/**
 * Build a SessionGroup from a history entry.
 */
function historyEntryToGroup(
  entry: HistoryEntry,
  firstUserMessage?: string,
  messageCount?: number
): SessionGroup {
  const project = deriveProjectName(entry.project);
  const started = epochToIso(entry.timestamp);
  return {
    session_id: entry.sessionId,
    title: entry.display || firstUserMessage || entry.sessionId,
    project,
    repo_path: entry.project,
    branch: '',
    agent: 'claude-code',
    started_at: started,
    ended_at: null,
    status: 'completed',
    chunk_count: messageCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function claudeBase(opts: ClaudeCodeStoreOptions = {}): string {
  return opts.claudeDir ?? defaultClaudeDir();
}

function historyPath(opts: ClaudeCodeStoreOptions = {}): string {
  return path.join(claudeBase(opts), 'history.jsonl');
}

/** Check only that the host index exists; parsing it belongs to bounded search/status paths. */
function claudeCodeAvailability(opts: ClaudeCodeStoreOptions = {}) {
  const indexPath = historyPath(opts);
  try {
    if (fs.statSync(indexPath).isFile()) return { ok: true as const, path: indexPath };
  } catch {
    // Missing or unreadable indexes are reported as unavailable.
  }
  return { ok: false as const, path: indexPath, error: 'history.jsonl not available' };
}

// ---------------------------------------------------------------------------
// Status / availability
// ---------------------------------------------------------------------------

export interface ClaudeCodeDbStatus {
  ok: boolean;
  path: string | null;
  size_bytes: number | null;
  session_count: number | null;
  message_count: number | null;
  part_count: number | null;
  error?: string;
}

export function claudeCodeDbStatus(opts: ClaudeCodeStoreOptions = {}): ClaudeCodeDbStatus {
  const hp = historyPath(opts);
  if (!fs.existsSync(hp)) {
    return {
      ok: false,
      path: null,
      size_bytes: null,
      session_count: null,
      message_count: null,
      part_count: null,
      error: `history.jsonl not found at ${hp}`,
    };
  }

  const stat = fs.statSync(hp);
  const entries = readHistoryIndex(claudeBase(opts), historyIndexByteLimit(opts.maxHistoryIndexBytes));

  return {
    ok: true,
    path: hp,
    size_bytes: stat.size,
    session_count: entries.length,
    // We don't eagerly count all messages; 0 is a safe placeholder
    message_count: null,
    part_count: null,
  };
}

// ---------------------------------------------------------------------------
// List sessions
// ---------------------------------------------------------------------------

export interface ListClaudeCodeSessionsInput {
  limit?: number;
  offset?: number;
  directory_glob?: string;
}

export function listClaudeCodeSessions(
  input: ListClaudeCodeSessionsInput = {},
  opts: ClaudeCodeStoreOptions = {}
): SessionGroup[] {
  const entries = readHistoryIndex(claudeBase(opts), historyIndexByteLimit(opts.maxHistoryIndexBytes));
  if (entries.length === 0) return [];

  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
  const offset = Math.max(0, input.offset ?? 0);

  // Deduplicate by sessionId (keep first / most recent entry)
  const seen = new Set<string>();
  const unique: HistoryEntry[] = [];
  for (const e of entries) {
    if (!seen.has(e.sessionId)) {
      seen.add(e.sessionId);
      unique.push(e);
    }
  }

  // Filter by directory if requested
  let filtered = unique;
  if (input.directory_glob) {
    filtered = unique.filter((e) => e.project && isWithinDirectoryScope(e.project, input.directory_glob!));
  }

  // Apply offset + limit
  const sliced = filtered.slice(offset, offset + limit);
  return sliced.map((e) => historyEntryToGroup(e));
}

// ---------------------------------------------------------------------------
// Search sessions (text search in JSONL message content)
// ---------------------------------------------------------------------------

export interface SearchClaudeCodeInput {
  query: string;
  limit?: number;
  depth?: 'text' | 'deep';
  directory_glob?: string;
  per_session_chunks?: number;
  scanBudget?: SessionSearchBudget;
}

export async function searchClaudeCodeSessions(
  input: SearchClaudeCodeInput,
  opts: ClaudeCodeStoreOptions = {}
): Promise<ChunkResult[]> {
  if (!input.query || input.query.trim().length === 0) return [];

  const entries = readHistoryIndex(claudeBase(opts), historyIndexByteLimit(opts.maxHistoryIndexBytes), input.scanBudget);
  if (entries.length === 0) return [];

  const limit = Math.max(1, Math.min(input.limit ?? 8, 10));
  const perSession = Math.max(1, Math.min(input.per_session_chunks ?? 2, 5));

  // Split query into terms; require ALL terms (AND)
  const terms = tokenizeSessionSearchQuery(input.query);
  if (terms.length === 0) return [];

  // Deduplicate entries by sessionId
  const seen = new Set<string>();
  const unique: HistoryEntry[] = [];
  for (const e of entries) {
    if (!seen.has(e.sessionId)) {
      seen.add(e.sessionId);
      unique.push(e);
    }
  }

  // Filter by directory if requested
  let candidates = unique;
  if (input.directory_glob) {
    candidates = unique.filter((e) => e.project && isWithinDirectoryScope(e.project, input.directory_glob!));
  }

  const out: ChunkResult[] = [];

  for (const entry of candidates) {
    if (out.length >= limit) break;
    if (!consumeSessionSearchBudget(input.scanBudget)) break;

    const transcriptPath = findSessionFile(claudeBase(opts), entry.sessionId, entry.project);
    if (transcriptPath) {
      try {
        if (!allowSessionFileSize(input.scanBudget, fs.statSync(transcriptPath).size)) continue;
      } catch {
        // The parser handles files removed between discovery and read.
      }
    }

    // Bulk search must not initialize the durable DB just to read a parse cache.
    const parsed = await loadParsedSession(claudeBase(opts), entry.sessionId, entry, { cacheRead: false, cacheWrite: false });
    if (!parsed) continue;

    const group = parsed.group;

    // Collect hits from this session's normalized texts
    const sessionHits: Array<{ text: SessionText; matchIdx: number }> = [];

    for (const text of parsed.texts) {
      if (sessionHits.length >= perSession) break;

      const lowerText = text.text.toLowerCase();
      const allMatch = terms.every((term) => lowerText.includes(term));
      if (!allMatch) continue;

      sessionHits.push({ text, matchIdx: 0 });
    }

    if (sessionHits.length === 0) {
      const evidenceByTerm = new Map<string, string>();
      for (const text of parsed.texts) {
        const lowerText = text.text.toLowerCase();
        for (const term of terms) {
          if (evidenceByTerm.has(term)) continue;
          const index = lowerText.indexOf(term);
          if (index < 0) continue;
          evidenceByTerm.set(term, text.text.slice(Math.max(0, index - 160), index + term.length + 160).trim());
        }
        if (evidenceByTerm.size === terms.length) break;
      }
      if (evidenceByTerm.size === terms.length && parsed.texts[0]) {
        sessionHits.push({
          text: { ...parsed.texts[0], text: [...new Set(evidenceByTerm.values())].join(' … ') },
          matchIdx: 0,
        });
      }
    }

    // Build chunks from hits
    for (let i = 0; i < sessionHits.length; i++) {
      const hit = sessionHits[i];
      const content = hit.text.text.slice(0, 500);
      if (content.length === 0) continue;

      const role = hit.text.role;
      const memoryId = hit.text.uuid ?? `${entry.sessionId}-${i}`;
      const msgTs = hit.text.ts || entry.timestamp;

      out.push({
        chunk: {
          type: i === 0 ? 'summary' : 'file',
          content,
          session_id: entry.sessionId,
          session_title: group.title,
          project: group.project,
          repo_path: group.repo_path,
          branch: hit.text.branch ?? '',
          agent: 'claude-code',
          agent_session_id: entry.sessionId,
          sourceRole: role,
          timestamp: epochToIso(msgTs),
        },
        score: 1 / (i + 1),
        memory_id: memoryId,
        why: `matched in ${role} message of session "${group.title}"`,
      });

      if (out.length >= limit) break;
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Get a single session (with chunks)
// ---------------------------------------------------------------------------

export interface ClaudeCodeSessionDetail extends SessionGroup {
  chunks: Chunk[];
  message_count: number;
}

export async function getClaudeCodeSession(
  sessionId: string,
  opts: ClaudeCodeStoreOptions = {}
): Promise<ClaudeCodeSessionDetail | null> {
  const entries = readHistoryIndex(claudeBase(opts), historyIndexByteLimit(opts.maxHistoryIndexBytes));
  const entry = entries.find((e) => e.sessionId === sessionId) ?? null;

  // Show/get path: reads through the parse cache and writes on miss.
  const parsed = await loadParsedSession(claudeBase(opts), sessionId, entry);
  if (!parsed) return null;

  return {
    ...parsed.group,
    chunks: parsed.chunks,
    message_count: parsed.texts.length,
  };
}

// ---------------------------------------------------------------------------
// Find related sessions (by path/file keyword overlap)
// ---------------------------------------------------------------------------

export async function findClaudeCodeRelatedSessions(
  input: { repo_path?: string; files?: string[]; limit?: number },
  opts: ClaudeCodeStoreOptions = {}
): Promise<Array<{ group: SessionGroup; score: number; reason: string }>> {
  if (!input.repo_path && (!input.files || input.files.length === 0)) return [];

  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const entries = readHistoryIndex(claudeBase(opts), historyIndexByteLimit(opts.maxHistoryIndexBytes));
  if (entries.length === 0) return [];

  // Deduplicate
  const seen = new Set<string>();
  const unique: HistoryEntry[] = [];
  for (const e of entries) {
    if (!seen.has(e.sessionId)) {
      seen.add(e.sessionId);
      unique.push(e);
    }
  }

  const out: Array<{ group: SessionGroup; score: number; reason: string }> = [];

  for (const entry of unique) {
    if (out.length >= limit) break;

    let score = 0;
    const reasons: string[] = [];

    // Score by path overlap
    if (input.repo_path) {
      const entryNorm = entry.project.replace(/\\/g, '/').toLowerCase();
      const targetNorm = input.repo_path.replace(/\\/g, '/').toLowerCase();
      if (entryNorm.includes(targetNorm) || targetNorm.includes(entryNorm)) {
        score += 2;
        reasons.push(`directory match (${deriveProjectName(entry.project)})`);
      }
    }

    // Score by file overlap in session messages
    if (input.files && input.files.length > 0) {
      const parsed = await loadParsedSession(claudeBase(opts), entry.sessionId, entry, { cacheRead: false, cacheWrite: false });
      if (parsed) {
        const allText = parsed.texts.map((t) => t.text).join(' ').toLowerCase();
        let fileHits = 0;
        for (const f of input.files) {
          const leaf = path.basename(f).toLowerCase();
          if (leaf && allText.includes(leaf)) {
            fileHits++;
          }
        }
        if (fileHits > 0) {
          score += fileHits;
          reasons.push(`${fileHits} file overlap(s)`);
        }
      }
    }

    if (score === 0) continue;

    const group = historyEntryToGroup(entry);
    out.push({
      group,
      score,
      reason: reasons.join('; '),
    });
  }

  out.sort((a, b) => b.score - a.score || b.group.started_at.localeCompare(a.group.started_at));
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Cached parse layer (Batch 7)
// ---------------------------------------------------------------------------

/** Normalized message text used for search + chunk building. */
interface SessionText {
  role: string;
  text: string;
  ts: number;
  uuid?: string;
  branch?: string;
}

interface ParsedSession {
  group: SessionGroup;
  chunks: Chunk[];
  texts: SessionText[];
}

const MAX_CACHED_TEXT_CHARS = 24_000;

/**
 * Batch 7 review (M-1): derive the real project directory for a transcript
 * file under `~/.claude/projects/<hash>/`.
 *
 * The hash directory name is NOT a usable project path (its basename is
 * literally "projects"), so naively using `basename(dirname(dirname(file)))`
 * synthesized a bogus "projects" project and `recordParsedSessionSignals`
 * then created a junk project row via ensureProject.
 *
 * Resolution order:
 *   1. Exact match against history.jsonl entries whose project hashes to
 *      the same directory (lossless).
 *   2. Lossy reconstruction of the hashed absolute path ('-' -> '\' after
 *      the drive letter), accepted only when the reconstructed path is a
 *      real directory on disk.
 *   3. Empty string - callers treat this as "no project attribution".
 */
export function deriveProjectForTranscript(claudeDir: string, filePath: string): string {
  const projectsDir = path.join(claudeDir, 'projects');
  const parentDir = path.dirname(path.dirname(filePath));
  if (parentDir !== projectsDir) return '';
  const hashDirName = path.basename(path.dirname(filePath));
  if (!hashDirName || hashDirName === 'projects') return '';

  for (const entry of readHistoryIndex(claudeDir)) {
    if (entry.project && projectHash(entry.project) === hashDirName) {
      try {
        if (fs.statSync(entry.project).isDirectory()) return entry.project;
      } catch {
        // History points at a deleted project; keep looking.
      }
    }
  }

  const winStyle = /^([A-Za-z])--(.+)$/.exec(hashDirName);
  if (winStyle) {
    const candidate = `${winStyle[1]}:\\${winStyle[2].replace(/-/g, '\\')}`;
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Reversal is ambiguous for paths containing literal '-'; fall through.
    }
  }
  return '';
}

/**
 * Batch 7 review (M-6): normalize a raw transcript timestamp to epoch ms.
 * Accepts epoch-ms numbers, numeric strings, and ISO-8601 strings; returns
 * 0 when the value is unusable so downstream `ts || fallback` logic works.
 */
function normalizeMessageEpoch(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && trimmed !== '') return asNumber;
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Build the parsed `{ group, chunks, texts }` payload for a session file.
 * Pure parsing — no cache interaction.
 */
function parseSessionFile(
  filePath: string,
  group: SessionGroup
): ParsedSession {
  const messages = readSessionMessages(filePath);
  const texts: SessionText[] = [];

  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue;
    if (!transcriptCwdMatchesProject(msg.cwd, group.repo_path)) continue;
    // The outer JSONL record type is the trusted role discriminator. Reject
    // contradictory nested role metadata so search cannot label assistant
    // content as a user turn (capture applies the same check).
    if (msg.message?.role && msg.message.role !== msg.type) continue;
    const raw = extractText(msg.message?.content);
    const text = cleanText(raw);
    if (!text) continue;
    texts.push({
      role: msg.type,
      text,
      ts: normalizeMessageEpoch(msg.timestamp),
      uuid: msg.uuid,
      branch: msg.gitBranch,
    });
  }

  const chunks: Chunk[] = [];

  // Summary chunk from the first user message
  const firstUser = texts.find((t) => t.role === 'user');
  if (firstUser) {
    chunks.push({
      type: 'summary',
      content: firstUser.text.slice(0, 500),
      session_id: group.session_id,
      session_title: group.title,
      project: group.project,
      repo_path: group.repo_path,
      branch: firstUser.branch ?? '',
      agent: 'claude-code',
      agent_session_id: group.session_id,
      sourceRole: firstUser.role,
      timestamp: epochToIso(firstUser.ts || Date.parse(group.started_at)),
    });
  }

  // A few assistant chunks
  let assistantChunks = 0;
  for (const t of texts) {
    if (assistantChunks >= 5) break;
    if (t.role !== 'assistant') continue;
    chunks.push({
      type: 'file',
      content: t.text.slice(0, 500),
      session_id: group.session_id,
      session_title: group.title,
      project: group.project,
      repo_path: group.repo_path,
      branch: t.branch ?? '',
      agent: 'claude-code',
      agent_session_id: group.session_id,
      sourceRole: t.role,
      timestamp: epochToIso(t.ts || Date.parse(group.started_at)),
    });
    assistantChunks++;
  }

  return { group, chunks, texts };
}

/**
 * Read a parsed session through the mtime-invalidated cache.
 *
 * - Cache hit: payload served from the squish DB (no file read).
 * - Cache miss: parse the JSONL transcript, write the cache, and (best
 *   effort) record working-set signals from the parse. `cacheWrite`
 *   controls whether a miss writes back — bulk scans (search/related)
 *   read without writing so one sweep cannot bloat the DB.
 */
async function loadParsedSession(
  claudeDir: string,
  sessionId: string,
  entry: HistoryEntry | null,
  opts: { cacheRead?: boolean; cacheWrite?: boolean } = {}
): Promise<ParsedSession | null> {
  // No history entry and no way to locate the file: unknown session.
  if (!entry) {
    const found = findSessionFile(claudeDir, sessionId);
    if (!found) return null;
  }

  const filePath =
    findSessionFile(claudeDir, sessionId, entry?.project) ?? undefined;

  // Transcript file gone but the history entry survives: keep the old
  // behavior of returning the group with an empty chunk list.
  if (!filePath) {
    const groupOnly = historyEntryToGroup(entry!);
    return { group: groupOnly, chunks: [], texts: [] };
  }

  const stat = statSessionFile(filePath);
  const cached = opts.cacheRead === false
    ? null
    : await readSessionCache('claude-code', sessionId, filePath, stat);
  if (cached && Array.isArray((cached as any).texts)) {
    return cached as unknown as ParsedSession;
  }

  let entry_ = entry;
  if (!entry_) {
    // No history entry: synthesize a minimal group from the file itself.
    // Batch 7 review (M-1): the parent-of-parent directory is the project
    // HASH dir, not a project path - derive a real directory or use none
    // instead of attributing sessions to a bogus "projects" project.
    const derivedProject = deriveProjectForTranscript(claudeDir, filePath);
    entry_ = {
      display: '',
      timestamp: stat ? Math.floor(stat.mtimeMs) : Date.now(),
      project: derivedProject,
      sessionId,
    };
  }

  const group = historyEntryToGroup(entry_, undefined, undefined);
  const parsed = parseSessionFile(filePath, group);

  if (opts.cacheWrite !== false && stat) {
    // Truncate cached texts so pathological transcripts stay bounded.
    const boundedTexts: SessionText[] = [];
    let budget = MAX_CACHED_TEXT_CHARS;
    for (const t of parsed.texts) {
      if (budget <= 0) break;
      const text = t.text.length > 2000 ? `${t.text.slice(0, 2000)}…` : t.text;
      budget -= text.length;
      boundedTexts.push({ ...t, text });
    }
    await writeSessionCache('claude-code', sessionId, filePath, stat, {
      group: parsed.group,
      chunks: parsed.chunks,
      texts: boundedTexts,
    } as any);
    // Batch 7 review (I-1): awaited, not fire-and-forget. Short-lived CLI
    // processes (`squish sessions show`) exit before dangling promises
    // resolve, silently dropping the signals. This path only runs on
    // single-session cache misses (bulk scans pass cacheWrite:false), so
    // awaiting costs nothing and keeps long-lived MCP servers correct too.
    await recordParsedSessionSignals({
      sessionId: `claude-code:${sessionId}`,
      projectPath: entry_.project || undefined,
      chunks: parsed.chunks.map((c) => ({ type: c.type, content: c.content })),
    });
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// AgentSessionStore implementation
// ---------------------------------------------------------------------------

/**
 * Claude Code-backed implementation of `AgentSessionStore`.
 *
 * Reads the user's local Claude Code history index and per-session
 * JSONL message files to provide the same session search surface as
 * the OpenCode store.
 */
export class ClaudeCodeSessionStore implements AgentSessionStore {
  readonly name: AgentName = 'claude-code';

  private readonly storeOpts: ClaudeCodeStoreOptions;

  constructor(opts: ClaudeCodeStoreOptions = {}) {
    this.storeOpts = opts;
  }

  private optsFor(_input?: { directory_glob?: string }): ClaudeCodeStoreOptions {
    return this.storeOpts;
  }

  async available(): Promise<{ ok: boolean; reason?: string; meta?: Record<string, unknown> }> {
    if (process.env.SQUISH_CLAUDE_DISABLED === '1') {
      return { ok: false, reason: 'claude-code disabled via SQUISH_CLAUDE_DISABLED=1' };
    }
    const availability = claudeCodeAvailability(this.storeOpts);
    if (!availability.ok) {
      return { ok: false, reason: availability.error };
    }
    return {
      ok: true,
      meta: { path: availability.path },
    };
  }

  async status(): Promise<{ path: string; size: number; sessions: number; messages: number; parts: number } | null> {
    const s = claudeCodeDbStatus(this.storeOpts);
    if (!s.ok || !s.path || s.size_bytes == null) return null;
    return {
      path: s.path,
      size: s.size_bytes,
      sessions: s.session_count ?? 0,
      messages: 0, // Not pre-counted for JSONL format
      parts: 0,
    };
  }

  async listSessions(opts?: { limit?: number; offset?: number; directory_glob?: string }): Promise<SessionGroup[]> {
    return listClaudeCodeSessions(
      { limit: opts?.limit, offset: opts?.offset, directory_glob: opts?.directory_glob },
      this.optsFor(opts)
    );
  }

  async searchSessions(input: { query: string; limit?: number; depth?: 'text' | 'deep'; directory_glob?: string; per_session_chunks?: number; scanBudget?: SessionSearchBudget }): Promise<Chunk[]> {
    const results = await searchClaudeCodeSessions(
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
    const detail = await getClaudeCodeSession(id, this.optsFor({}));
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
    return await findClaudeCodeRelatedSessions(
      { repo_path: input.repo_path, files: input.files, limit: input.limit },
      this.optsFor({})
    );
  }
}
