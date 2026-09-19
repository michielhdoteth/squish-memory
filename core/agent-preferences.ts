/**
 * Agent Preferences - Accumulate and retrieve agent preferences from learnings
 * Enables agents to learn and evolve over time
 */

import { getDb } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { logger } from './logger.js';

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
    const results = await db.query.agentPreferences?.findMany({
      where: eq(db.schema.agentPreferences.projectId, projectId)
    }).catch(() => []);
    
    if (results && results.length > 0) {
      return results.map((p: any) => ({ key: p.key, value: p.value }));
    }
    
    // Fallback for SQLite
    const sqlite = (db as any)._?.sqlite || (db as any);
    if (sqlite) {
      const rows = sqlite.prepare('SELECT key, value FROM agent_preferences WHERE project_id = ?').all(projectId) as Array<{key: string; value: string}>;
      return rows.map(r => ({ key: r.key, value: r.value }));
    }
    
    return [];
  } catch (error: any) {
    logger.warn(`[AgentPrefs] Failed to get preferences:`, error);
    return [];
  }
}