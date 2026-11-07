/**
 * Agent Preferences - Accumulate and retrieve agent preferences from learnings
 * Enables agents to learn and evolve over time
 */

import { getDb } from '../db/index.js';
import { sqlLifecycleBound } from './lib/timestamps.js';

/** SQL bound for "is the row within its lifecycle window right now". */
const NOW_BOUND = "CAST(strftime('%s','now') AS INTEGER)";
import { eq, and } from 'drizzle-orm';
import { logger } from './logger.js';

type AgentPreferenceRow = { key: string; value: string };
type AgentPreferenceClient = {
  prepare?: (sql: string) => { all: (...params: unknown[]) => AgentPreferenceRow[] };
  query?: (sql: string, params: unknown[]) => Promise<{ rows: AgentPreferenceRow[] }>;
};

/**
 * Extract preference from learning content
 * E.g., "Prefer bun over npm" -> key: "prefer_bun", value: "bun"
 */
function extractPreference(content: string): { key: string; value: string } | null {
  const patterns = [
    // "Prefer X over Y"
    /prefer\s+(\w+)\s+over\s+(\w+)/i,
    // "Always use X"
    /always\s+use\s+(\w+)/i,
    // "Use X instead of Y"
    /use\s+(\w+)\s+instead\s+of\s+(\w+)/i,
    // "X is better than Y"
    /(\w+)\s+is\s+better\s+than\s+(\w+)/i,
    // "Don't use X"
    /(?:don't|do not|never)\s+use\s+(\w+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      const key = `prefer_${match[1].toLowerCase()}`;
      const value = match[2]?.toLowerCase() || 'true';
      return { key, value };
    }
  }
  
  return null;
}

/**
 * Update agent preference from a learning
 */
export async function updateAgentPreference(
  projectId: string,
  content: string,
  sourceMemoryId?: string
): Promise<void> {
  const preference = extractPreference(content);
  if (!preference) return;
  
  try {
    const db = await getDb();
    
    const existing = await db.query.agentPreferences?.findFirst(
      and(
        eq(db.schema.agentPreferences.projectId, projectId),
        eq(db.schema.agentPreferences.key, preference.key)
      )
    ).catch(() => null);
    
    if (existing) {
      await db.update(db.schema.agentPreferences)
        .set({
          value: preference.value,
          sourceMemoryId: sourceMemoryId,
          usageCount: (existing.usageCount ?? 0) + 1,
          lastUpdated: Math.floor(Date.now() / 1000)
        })
        .where(eq(db.schema.agentPreferences.id, existing.id))
        .catch(() => {
          // Fallback for SQLite which uses different table name
          const sqlite = (db as any)._?.sqlite || (db as any);
          if (sqlite) {
            sqlite.prepare(`
              UPDATE agent_preferences 
              SET value = ?, source_memory_id = ?, usage_count = usage_count + 1, last_updated = ?
              WHERE project_id = ? AND key = ?
            `).run(preference.value, sourceMemoryId, Math.floor(Date.now() / 1000), projectId, preference.key);
          }
        });
      logger.info(`[AgentPrefs] Updated preference: ${preference.key} = ${preference.value}`);
    } else {
      const id = `pref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await db.insert(db.schema.agentPreferences)
        .values({
          id,
          projectId,
          key: preference.key,
          value: preference.value,
          sourceMemoryId: sourceMemoryId ?? null,
          confidence: 0.5,
          usageCount: 1
        })
        .catch(() => {
          // Fallback for SQLite
          const sqlite = (db as any)._?.sqlite || (db as any);
          if (sqlite) {
            sqlite.prepare(`
              INSERT INTO agent_preferences (id, project_id, key, value, source_memory_id, confidence, usage_count)
              VALUES (?, ?, ?, ?, ?, 0.5, 1)
            `).run(id, projectId, preference.key, preference.value, sourceMemoryId ?? null);
          }
        });
      logger.info(`[AgentPrefs] Created preference: ${preference.key} = ${preference.value}`);
    }
  } catch (error: any) {
    logger.warn(`[AgentPrefs] Failed to update preference:`, error);
  }
}

/**
 * Get all agent preferences for a project
 */
export async function getAgentPreferences(projectId: string): Promise<Array<{key: string; value: string}>> {
  try {
    const db = await getDb();
    const client = (db as unknown as { $client?: AgentPreferenceClient }).$client;
    const activeSource = typeof client?.prepare === 'function'
      ? `(p.source_memory_id IS NULL OR EXISTS (
          SELECT 1 FROM memories m WHERE m.id = p.source_memory_id
            AND m.status = 'active' AND m.is_active = 1
            AND ${sqlLifecycleBound('m.valid_from', '<=', NOW_BOUND)}
            AND ${sqlLifecycleBound('m.valid_to', '>', NOW_BOUND)}
            AND ${sqlLifecycleBound('m.expires_at', '>', NOW_BOUND)}
        ))`
      : `(p.source_memory_id IS NULL OR EXISTS (
          SELECT 1 FROM memories m WHERE m.id = p.source_memory_id
            AND m.status = 'active' AND m.is_active = TRUE
            AND (m.valid_to IS NULL OR m.valid_to > NOW())
            AND (m.expires_at IS NULL OR m.expires_at > NOW())
        ))`;
    if (typeof client?.prepare === 'function') {
      return client.prepare(`SELECT p.key, p.value FROM agent_preferences p
        WHERE p.project_id = ? AND ${activeSource} ORDER BY p.key`).all(projectId);
    }
    if (typeof client?.query === 'function') {
      const result = await client.query(`SELECT p.key, p.value FROM agent_preferences p
        WHERE p.project_id = $1 AND ${activeSource} ORDER BY p.key`, [projectId]);
      return result.rows;
    }
    return [];
  } catch (error: any) {
    logger.warn(`[AgentPrefs] Failed to get preferences:`, error);
    return [];
  }
}
