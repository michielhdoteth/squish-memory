/**
 * Agent session cache - Batch 7.
 *
 * Read-through cache for parsed local agent histories. Transcript and
 * session database files can be large, so this module stores normalized
 * `{ group, chunks }` payloads in the local `agent_session_cache` table.
 * Each key is bound to the source name, session ID, resolved source path,
 * and (under strict trust) authenticated caller scope. Freshness also checks
 * mtime, size, ctime, and filesystem identity to reject replaced or edited
 * source files.
 *
 * Cached payloads are derived read-through data, separate from durable
 * captured memories. A source change invalidates the whole parsed payload;
 * source deletion or replacement is pruned opportunistically after reads.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { logger } from '../../logger.js';
import { getDbClient } from '../../lib/db-client.js';
import { isStrictTrustPolicy, resolveTrustedCallerId } from '../../acl/trust-policy.js';
import type { AgentName } from './types.js';
import type { Chunk, SessionGroup } from '../types.js';

export interface SessionCacheStat {
  mtimeMs: number;
  sizeBytes: number;
  sourceToken?: string;
}

export function statSessionFile(filePath: string): SessionCacheStat | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    // SQLite stores the compatibility mtime as integer milliseconds, but
    // freshness uses the filesystem's full timestamp precision. Flooring
    // both mtime and ctime can miss same-size edits made in one millisecond.
    const mtimeMs = Number(stat.mtimeNs / 1_000_000n);
    const sizeBytes = Number(stat.size);
    const sourceToken = JSON.stringify([
      stat.mtimeNs.toString(),
      stat.size.toString(),
      stat.ctimeNs.toString(),
      String(stat.dev),
      String(stat.ino),
    ]);
    return { mtimeMs, sizeBytes, sourceToken };
  } catch {
    return null;
  }
}

export interface CachedSessionPayload {
  group: SessionGroup;
  chunks: Chunk[];
  texts?: unknown[];
}

const SESSION_CACHE_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const lastSessionCachePruneAt = new Map<AgentName, number>();

interface StoredSessionPayload extends CachedSessionPayload {
  __squishSourceToken: string;
}

interface CacheRow {
  cache_key: string;
  agent: string;
  session_id: string;
  source_path: string;
  mtime_ms: number;
  size_bytes: number;
  payload: string;
}

function sourceIdentity(sourcePath: string): string {
  let absolutePath = path.resolve(sourcePath);
  try {
    absolutePath = fs.realpathSync.native(absolutePath);
  } catch {
    // Preserve a stable resolved identity for legacy callers that stat a
    // source which no longer exists; its cache entry will still fail freshness.
  }
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function sourceToken(stat: SessionCacheStat): string {
  // Compatibility for direct callers that supply only the legacy fields.
  return stat.sourceToken ?? JSON.stringify([stat.mtimeMs, stat.sizeBytes]);
}

function sourceStatStillCurrent(sourcePath: string, expected: SessionCacheStat): boolean {
  const current = statSessionFile(sourcePath);
  if (!current) return false;
  if (expected.sourceToken) return sourceToken(current) === sourceToken(expected);
  return current.mtimeMs === expected.mtimeMs && current.sizeBytes === expected.sizeBytes;
}

function cacheKey(agent: string, sessionId: string, sourcePath: string): string | null {
  let principalScope = 'local-compatible';
  if (isStrictTrustPolicy()) {
    const callerId = resolveTrustedCallerId();
    if (!callerId) return null;
    principalScope = `strict:${createHash('sha256').update(callerId).digest('hex')}`;
  }
  const identity = JSON.stringify([agent, sessionId, sourceIdentity(sourcePath), principalScope]);
  return `${agent}:${createHash('sha256').update(identity).digest('hex')}`;
}

/**
 * Read a cached parsed session if present and still fresh for the given
 * file stat. Returns null on miss or stale entry.
 */
export async function readSessionCache(
  agent: AgentName,
  sessionId: string,
  sourcePath: string,
  stat?: SessionCacheStat | null
): Promise<CachedSessionPayload | null> {
  if (!stat) return null;
  try {
    const key = cacheKey(agent, sessionId, sourcePath);
    if (!key) return null;
    const { raw } = await getDbClient();
    const sqlite = (raw as any).$client ?? raw;
    const row = sqlite
      .prepare('SELECT * FROM agent_session_cache WHERE cache_key = ?')
      .get(key) as CacheRow | undefined;
    if (!row) return null;
    if (sourceIdentity(row.source_path) !== sourceIdentity(sourcePath)) return null;
    if (row.mtime_ms !== stat.mtimeMs || row.size_bytes !== stat.sizeBytes) return null;

    const payload = JSON.parse(row.payload) as StoredSessionPayload;
    if (!payload?.group || !Array.isArray(payload.chunks)) return null;
    if (payload.__squishSourceToken !== sourceToken(stat)) return null;
    // Adapters stat before this async database read. Recheck at the read
    // boundary so an edit during that wait cannot return the old transcript.
    if (!sourceStatStillCurrent(sourcePath, stat)) return null;
    return {
      group: payload.group,
      chunks: payload.chunks,
      ...(Array.isArray(payload.texts) ? { texts: payload.texts } : {}),
    };
  } catch (err) {
    logger.debug(`[session-cache] read failed (${agent})`, { errorType: errorType(err) });
    return null;
  }
}

/** Read a fresh cached session when only its source path is known. */
export async function readSessionCacheBySource(
  agent: AgentName,
  sourcePath: string,
  stat?: SessionCacheStat | null
): Promise<CachedSessionPayload | null> {
  if (!stat) return null;
  try {
    const { raw } = await getDbClient();
    const sqlite = (raw as any).$client ?? raw;
    const rows = sqlite
      .prepare('SELECT * FROM agent_session_cache WHERE agent = ? AND source_path = ?')
      .all(agent, sourceIdentity(sourcePath)) as CacheRow[];
    for (const row of rows) {
      if (sourceIdentity(row.source_path) !== sourceIdentity(sourcePath)) continue;
      if (cacheKey(agent, row.session_id, sourcePath) !== row.cache_key) continue;
      if (row.mtime_ms !== stat.mtimeMs || row.size_bytes !== stat.sizeBytes) continue;
      const payload = JSON.parse(row.payload) as StoredSessionPayload;
      if (!payload?.group || !Array.isArray(payload.chunks)) continue;
      if (payload.__squishSourceToken !== sourceToken(stat)) continue;
      if (!sourceStatStillCurrent(sourcePath, stat)) return null;
      return {
        group: payload.group,
        chunks: payload.chunks,
        ...(Array.isArray(payload.texts) ? { texts: payload.texts } : {}),
      };
    }
    return null;
  } catch (err) {
    logger.debug(`[session-cache] path lookup failed (${agent})`, { errorType: errorType(err) });
    return null;
  }
}

/**
 * Write/refresh a cached parsed session. Returns true when a fresh row was
 * written (i.e. this was a genuine parse worth recording as activity).
 */
export async function writeSessionCache(
  agent: AgentName,
  sessionId: string,
  sourcePath: string,
  stat: SessionCacheStat | null,
  payload: CachedSessionPayload
): Promise<boolean> {
  if (!stat) return false;
  try {
    const key = cacheKey(agent, sessionId, sourcePath);
    if (!key) return false;
    const { raw } = await getDbClient();
    const sqlite = (raw as any).$client ?? raw;
    sqlite
      .prepare(
        `INSERT INTO agent_session_cache
           (cache_key, agent, session_id, source_path, mtime_ms, size_bytes, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
         ON CONFLICT(cache_key) DO UPDATE SET
           source_path = excluded.source_path,
           mtime_ms = excluded.mtime_ms,
           size_bytes = excluded.size_bytes,
           payload = excluded.payload,
           updated_at = excluded.updated_at`
      )
      .run(
        key,
        agent,
        sessionId,
        sourceIdentity(sourcePath),
        stat.mtimeMs,
        stat.sizeBytes,
        JSON.stringify({ ...payload, __squishSourceToken: sourceToken(stat) })
      );
    return true;
  } catch (err) {
    logger.debug(`[session-cache] write failed (${agent})`, { errorType: errorType(err) });
    return false;
  }
}

/**
 * Drop stale cache entries whose source file no longer exists or changed
 * beyond recognition. Called opportunistically; failures are ignored.
 */
export async function pruneSessionCache(agent: AgentName): Promise<void> {
  try {
    const { raw } = await getDbClient();
    const sqlite = (raw as any).$client ?? raw;
    const rows = sqlite
      .prepare('SELECT cache_key, source_path, payload FROM agent_session_cache WHERE agent = ?')
      .all(agent) as Array<Pick<CacheRow, 'cache_key' | 'source_path' | 'payload'>>;
    for (const row of rows) {
      const currentStat = statSessionFile(row.source_path);
      let cachedSourceToken: string | undefined;
      try {
        const payload = JSON.parse(row.payload) as Partial<StoredSessionPayload>;
        cachedSourceToken = payload.__squishSourceToken;
      } catch {
        // Invalid cache payloads are stale and should not retain transcript text.
      }
      if (!currentStat || cachedSourceToken !== sourceToken(currentStat)) {
        sqlite.prepare('DELETE FROM agent_session_cache WHERE cache_key = ?').run(row.cache_key);
      }
    }
  } catch (err) {
    logger.debug(`[session-cache] prune failed (${agent})`, { errorType: errorType(err) });
  }
}

/** Remove orphaned transcript caches in the background, at most once per agent per interval. */
export function scheduleSessionCachePrune(agent: AgentName): Promise<void> | null {
  const now = Date.now();
  const last = lastSessionCachePruneAt.get(agent) ?? 0;
  if (now - last < SESSION_CACHE_PRUNE_INTERVAL_MS) return null;
  lastSessionCachePruneAt.set(agent, now);
  return pruneSessionCache(agent);
}
