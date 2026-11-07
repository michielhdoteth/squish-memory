/**
 * Agent-name source for session queries.
 *
 * v1.5.5: the sessions surface is now exclusively for past agent
 * sessions. Long-term memory is the job of `squish_recall` /
 * `squish_remember` — NOT the sessions CLI. The previous `squish`
 * source (captured-memories path) has been dropped from
 * `searchChunks` / `listSessions` / `getSessionChunks` /
 * `findRelatedSessions`.
 */
export type AgentName = 'opencode' | 'claude-code' | 'codex' | 'gemini';

/**
 * Source filter for chunk/session queries. `opencode` reads the
 * user's local opencode.db. `claude-code`, `codex` and `gemini` read
 * their respective agent stores. `all` iterates every registered agent
 * store.
 */
export type SessionSource = AgentName | 'all';

/** Tokenize session queries without dropping letters from non-Latin scripts. */
export function tokenizeSessionSearchQuery(query: string): string[] {
  return query.toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2 || /[^\p{Script=Latin}\p{N}]/u.test(term));
}

export interface SessionSearchBudget {
  mode?: 'indexed_query' | 'session_scan';
  maxSessions: number;
  maxTranscriptBytes: number;
  deadlineMs: number;
  scannedSessions: number;
  oversizedSessions: number;
  truncated: boolean;
  reason?: 'session_limit' | 'time_limit' | 'file_size_limit' | 'history_index_limit' | 'source_error';
  /** Safe, actionable error for an invalid OpenCode project alias. */
  scopeError?: string;
  truncationReasons: Array<'session_limit' | 'time_limit' | 'file_size_limit' | 'history_index_limit' | 'source_error'>;
}

export interface SessionSearchDiagnostics {
  mode: 'unavailable' | 'transcript_scan' | 'session_scan' | 'indexed_query';
  scannedSessions: number;
  oversizedSessions: number;
  fileSizeLimitBytes: number;
  truncated: boolean;
  reason?: SessionSearchBudget['truncationReasons'][number];
  scopeError?: string;
  truncationReasons: SessionSearchBudget['truncationReasons'];
  availability?: {
    status: 'unavailable';
    reasonCode: 'disabled' | 'not_found' | 'open_failed' | 'unavailable' | 'availability_check_failed' | 'timeout';
  };
}

export function createSessionSearchBudget(
  maxSessions = 5_000,
  timeoutMs = 7_000,
  maxTranscriptBytes = 5 * 1024 * 1024,
): SessionSearchBudget {
  const boundedMax = Number.isInteger(maxSessions) ? Math.max(1, Math.min(maxSessions, 5_000)) : 5_000;
  const boundedTimeout = Number.isInteger(timeoutMs) ? Math.max(100, Math.min(timeoutMs, 30_000)) : 7_000;
  return {
    maxSessions: boundedMax,
    maxTranscriptBytes: Number.isInteger(maxTranscriptBytes) ? Math.max(1024, Math.min(maxTranscriptBytes, 50 * 1024 * 1024)) : 5 * 1024 * 1024,
    deadlineMs: Date.now() + boundedTimeout,
    scannedSessions: 0,
    oversizedSessions: 0,
    truncated: false,
    truncationReasons: [],
  };
}

export function markSessionSearchTruncated(
  budget: SessionSearchBudget,
  reason: SessionSearchBudget['truncationReasons'][number],
): void {
  budget.truncated = true;
  if (!budget.truncationReasons.includes(reason)) budget.truncationReasons.push(reason);
  if (!budget.reason) budget.reason = reason;
}

/** Refuse oversized transcripts before any full-file parser or stream opens. */
export function allowSessionFileSize(budget: SessionSearchBudget | undefined, fileSizeBytes: number): boolean {
  if (!budget || fileSizeBytes <= budget.maxTranscriptBytes) return true;
  budget.oversizedSessions++;
  markSessionSearchTruncated(budget, 'file_size_limit');
  return false;
}

/** Reserve one source session before opening or parsing its transcript. */
export function consumeSessionSearchBudget(budget?: SessionSearchBudget): boolean {
  if (!budget) return true;
  if (Date.now() >= budget.deadlineMs) {
    markSessionSearchTruncated(budget, 'time_limit');
    return false;
  }
  if (budget.scannedSessions >= budget.maxSessions) {
    markSessionSearchTruncated(budget, 'session_limit');
    return false;
  }
  budget.scannedSessions++;
  return true;
}

/**
 * Interface for agent-specific session stores.
 * Each agent (opencode, claude-code, codex) implements this
 * to provide session/chunk search over its local data.
 */
export interface AgentSessionStore {
  readonly name: AgentName;
  available(input?: { opencode_db_path?: string }): Promise<{ ok: boolean; reason?: string; meta?: Record<string, unknown> }>;
  status(): Promise<{ path: string; size: number; sessions: number; messages: number; parts: number } | null>;
  listSessions(opts?: { limit?: number; offset?: number; directory_glob?: string }): Promise<import('../types.js').SessionGroup[]>;
  searchSessions(input: { query: string; limit?: number; depth?: 'text' | 'deep'; directory_glob?: string; opencode_db_path?: string; per_session_chunks?: number; scanBudget?: SessionSearchBudget }): Promise<import('../types.js').Chunk[]>;
  getSession(id: string, input?: { opencode_db_path?: string }): Promise<{ group: import('../types.js').SessionGroup; chunks: import('../types.js').Chunk[] } | null>;
  findRelatedSessions(input: { repo_path?: string; files?: string[]; limit?: number }): Promise<Array<{ group: import('../types.js').SessionGroup; score: number; reason: string }>>;
}
