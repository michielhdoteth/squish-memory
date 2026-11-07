/**
 * Session Entity Tracker
 * 
 * Tracks "active" entities in conversation sessions to enable
 * reference resolution (e.g., resolving "she" to "Alice").
 */

import { eq, and, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';
import { deserializeMetadata, serializeMetadata } from '../memory/serialization.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionEntity {
  entityId: string;
  entityName: string;
  entityType: string;
  mentionCount: number;
  lastMentionedAt: Date;
  salience: number; // 0-1, higher = more relevant
}

export interface SessionEntityMap {
  sessionId: string;
  entities: Map<string, SessionEntity>;
  updatedAt: Date;
}

// ─── In-Memory Session Cache ─────────────────────────────────────────────────

const sessionCache = new Map<string, SessionEntityMap>();
const MAX_SESSIONS = 100;
const ENTITY_SALIENCE_DECAY = 0.85; // Per mention, older mentions decay
const MAX_SESSION_ENTITIES = 50;

function getSessionCachePrefix(): string {
  if (!isStrictTrustPolicy()) return '';
  const callerId = resolveTrustedCallerId();
  if (!callerId) throw new TrustBoundaryError('Strict session entity access requires an authenticated caller');
  const callerKey = createHash('sha256').update(callerId).digest('hex');
  return `strict:${callerKey}:`;
}

function getSessionCacheKey(sessionId: string): string {
  return `${getSessionCachePrefix()}${sessionId}`;
}

/**
 * Track an entity mention in a session.
 * Updates salience based on recency and frequency.
 */
export function trackEntityInSession(
  sessionId: string,
  entityId: string,
  entityName: string,
  entityType: string
): void {
  const cacheKey = getSessionCacheKey(sessionId);
  let session = sessionCache.get(cacheKey);
  
  if (!session) {
    session = {
      sessionId,
      entities: new Map(),
      updatedAt: new Date(),
    };
    sessionCache.set(cacheKey, session);
  }

  // Evict old sessions if cache is full
  if (sessionCache.size > MAX_SESSIONS) {
    const oldestKey = [...sessionCache.entries()]
      .sort(([, a], [, b]) => a.updatedAt.getTime() - b.updatedAt.getTime())[0][0];
    sessionCache.delete(oldestKey);
  }

  const existing = session.entities.get(entityId);
  const now = new Date();

  if (existing) {
    // Update existing entity: increase salience, update mention count
    existing.mentionCount += 1;
    existing.lastMentionedAt = now;
    // Salience increases with each mention, but decays for older mentions
    existing.salience = Math.min(1.0, existing.salience + 0.2);
  } else {
    // New entity for this session
    session.entities.set(entityId, {
      entityId,
      entityName,
      entityType,
      mentionCount: 1,
      lastMentionedAt: now,
      salience: 0.5, // Start at medium salience
    });
  }

  // Evict least salient entities if session has too many
  if (session.entities.size > MAX_SESSION_ENTITIES) {
    const leastSalient = [...session.entities.entries()]
      .sort(([, a], [, b]) => a.salience - b.salience)[0];
    if (leastSalient) {
      session.entities.delete(leastSalient[0]);
    }
  }

  session.updatedAt = now;
}

/**
 * Get active entities for a session, sorted by salience.
 * Applies time-based decay to salience scores.
 */
export function getActiveSessionEntities(
  sessionId: string,
  options?: {
    limit?: number;
    minSalience?: number;
    entityTypes?: string[];
  }
): SessionEntity[] {
  const { limit = 10, minSalience = 0.1, entityTypes } = options || {};

  const session = sessionCache.get(getSessionCacheKey(sessionId));
  if (!session) return [];

  const now = Date.now();
  const entities: SessionEntity[] = [];

  for (const [id, entity] of session.entities) {
    // Apply time-based decay
    const timeSinceMention = now - entity.lastMentionedAt.getTime();
    const minutesSinceMention = timeSinceMention / (1000 * 60);
    const timeDecay = Math.pow(ENTITY_SALIENCE_DECAY, minutesSinceMention / 5); // Decay every 5 minutes
    const adjustedSalience = entity.salience * timeDecay;

    // Filter by minimum salience
    if (adjustedSalience < minSalience) continue;

    // Filter by entity type
    if (entityTypes && entityTypes.length > 0 && !entityTypes.includes(entity.entityType)) continue;

    entities.push({
      ...entity,
      lastMentionedAt: new Date(entity.lastMentionedAt.getTime()),
      salience: adjustedSalience,
    });
  }

  // Sort by salience (most salient first)
  entities.sort((a, b) => b.salience - a.salience);

  return entities.slice(0, limit);
}

/**
 * Resolve a reference (pronoun, definite reference) to an entity in the session.
 * Returns the most salient entity matching the reference type.
 */
export function resolveReference(
  sessionId: string,
  reference: string
): SessionEntity | null {
  const session = sessionCache.get(getSessionCacheKey(sessionId));
  if (!session) return null;

  const lowerRef = reference.toLowerCase();

  // Pronoun mapping
  const pronounMap: Record<string, string[]> = {
    'he': ['person'],
    'him': ['person'],
    'his': ['person'],
    'she': ['person'],
    'her': ['person'],
    'hers': ['person'],
    'it': ['tool', 'concept', 'file', 'function', 'class'],
    'they': ['person', 'concept', 'tool'],
    'them': ['person', 'concept', 'tool'],
    'their': ['person', 'concept', 'tool'],
    'this': [], // Any type
    'that': [], // Any type
    'these': [],
    'those': [],
  };

  // Definite reference patterns
  const definitePatterns: Array<{ pattern: RegExp; types: string[] }> = [
    { pattern: /\bthe (?:project|app|application)\b/i, types: ['concept'] },
    { pattern: /\bthe (?:team|group)\b/i, types: ['concept'] },
    { pattern: /\bthe (?:database|db)\b/i, types: ['tool'] },
    { pattern: /\bthe (?:server|service|api)\b/i, types: ['tool'] },
    { pattern: /\bthe (?:issue|bug|problem|outage)\b/i, types: ['concept'] },
    { pattern: /\bthe (?:file|module|component)\b/i, types: ['file'] },
  ];

  // Check pronouns first
  const allowedTypes = pronounMap[lowerRef];
  if (allowedTypes !== undefined) {
    const candidates = getActiveSessionEntities(sessionId, {
      limit: 3,
      minSalience: 0.2,
      entityTypes: allowedTypes.length > 0 ? allowedTypes : undefined,
    });

    // For pronouns, return the most salient entity of the right type
    return candidates.length > 0 ? candidates[0] : null;
  }

  // Check definite references
  for (const { pattern, types } of definitePatterns) {
    if (pattern.test(reference)) {
      const candidates = getActiveSessionEntities(sessionId, {
        limit: 3,
        minSalience: 0.2,
        entityTypes: types,
      });
      return candidates.length > 0 ? candidates[0] : null;
    }
  }

  // Try to match by name (partial match)
  const nameMatch = [...session.entities.values()]
    .filter(e => e.entityName.toLowerCase().includes(lowerRef))
    .sort((a, b) => b.salience - a.salience)[0];

  return nameMatch ? { ...nameMatch, lastMentionedAt: new Date(nameMatch.lastMentionedAt.getTime()) } : null;
}

/**
 * Clear session entities (e.g., when a session ends).
 */
export function clearSessionEntities(sessionId: string): void {
  sessionCache.delete(getSessionCacheKey(sessionId));
}

/**
 * Get all active sessions.
 */
export function getActiveSessions(): string[] {
  const prefix = getSessionCachePrefix();
  return [...sessionCache.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, session]) => session.sessionId);
}

/**
 * Decay all session entities (call periodically).
 * Reduces salience of all entities across all sessions.
 */
export function decayAllSessionEntities(): void {
  const now = Date.now();
  const prefix = getSessionCachePrefix();

  for (const [cacheKey, session] of sessionCache) {
    if (!cacheKey.startsWith(prefix)) continue;
    for (const [entityId, entity] of session.entities) {
      const timeSinceMention = now - entity.lastMentionedAt.getTime();
      const minutesSinceMention = timeSinceMention / (1000 * 60);
      entity.salience *= Math.pow(ENTITY_SALIENCE_DECAY, minutesSinceMention / 5);
    }

    // Remove entities with very low salience
    for (const [entityId, entity] of session.entities) {
      if (entity.salience < 0.01) {
        session.entities.delete(entityId);
      }
    }

    // Remove empty sessions
    if (session.entities.size === 0) {
      sessionCache.delete(cacheKey);
    }
  }
}

/**
 * Persist session entities to the database for durability.
 * Called periodically or on session end.
 */
export async function persistSessionEntities(sessionId: string): Promise<void> {
  const strict = isStrictTrustPolicy();
  const callerId = strict ? resolveTrustedCallerId() : null;
  const cacheKey = getSessionCacheKey(sessionId);
  const session = sessionCache.get(cacheKey);
  if (!session || session.entities.size === 0) return;

  try {
    const db = await getDb();
    const schema = await getSchema();

    // Store session context in the context_sessions table
    const entities = [...session.entities.values()];
    const entityData = entities.map(e => ({
      id: e.entityId,
      name: e.entityName,
      type: e.entityType,
      salience: e.salience,
      mentionCount: e.mentionCount,
    }));

    // Check if session exists
    const existing = await (db as any)
      .select()
      .from(schema.contextSessions)
      .where(strict && callerId
        ? and(eq(schema.contextSessions.sessionId, sessionId), eq(schema.contextSessions.userId, callerId))
        : eq(schema.contextSessions.sessionId, sessionId))
      .limit(1);

    if (existing.length > 0) {
      await (db as any)
        .update(schema.contextSessions)
        .set({
          metadata: sql`${serializeMetadata({ entities: entityData })}`,
          updatedAt: new Date(),
        })
        .where(strict && callerId
          ? and(eq(schema.contextSessions.sessionId, sessionId), eq(schema.contextSessions.userId, callerId))
          : eq(schema.contextSessions.sessionId, sessionId));
    }
    // If session doesn't exist, we don't create it here
    // (it will be created by the normal session flow)

    logger.debug('Persisted session entities', {
      sessionId,
      entityCount: entities.length,
    });
  } catch (error) {
    logger.warn('Failed to persist session entities', { error: error as Error });
  }
}

/**
 * Load session entities from the database.
 * Called when a session starts.
 */
export async function loadSessionEntities(sessionId: string): Promise<void> {
  const strict = isStrictTrustPolicy();
  const callerId = strict ? resolveTrustedCallerId() : null;
  try {
    const db = await getDb();
    const schema = await getSchema();

    const session = await (db as any)
      .select()
      .from(schema.contextSessions)
      .where(strict && callerId
        ? and(eq(schema.contextSessions.sessionId, sessionId), eq(schema.contextSessions.userId, callerId))
        : eq(schema.contextSessions.sessionId, sessionId))
      .limit(1);

    if (session.length === 0 || !session[0].metadata) return;

    const metadata = deserializeMetadata(session[0].metadata);
    if (!metadata) return;
    const entityData = metadata.entities as Array<{
      id: string;
      name: string;
      type: string;
      salience: number;
      mentionCount: number;
    }>;

    if (!Array.isArray(entityData)) return;

    const sessionMap: SessionEntityMap = {
      sessionId,
      entities: new Map(),
      updatedAt: new Date(),
    };

    for (const e of entityData) {
      sessionMap.entities.set(e.id, {
        entityId: e.id,
        entityName: e.name,
        entityType: e.type,
        mentionCount: e.mentionCount,
        lastMentionedAt: new Date(), // Reset since we just loaded
        salience: e.salience * 0.8, // Decay on load
      });
    }

    sessionCache.set(getSessionCacheKey(sessionId), sessionMap);

    logger.debug('Loaded session entities', {
      sessionId,
      entityCount: entityData.length,
    });
  } catch (error) {
    logger.warn('Failed to load session entities', { error: error as Error });
  }
}
