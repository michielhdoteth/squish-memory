/**
 * Places Rules Engine - Auto-assignment logic
 * 
 * Evaluates which place a memory should be assigned to based on:
 * - Tool used (Write, Edit, Task, etc.)
 * - Content keywords
 * - Tags
 * - Memory type
 */

import { randomUUID } from 'crypto';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';
import type { PlaceType } from './places.js';
import { ensureGlobalProject } from './places.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyUnscopedPlaceOperation } from './strict-gates.js';

export interface PlaceCandidate {
  type: PlaceType;
  weight: number;
  reason?: string;
  source: 'heuristic' | 'llm' | 'manual' | 'dream';
}

export interface PlaceRule {
  id: string;
  projectId: string;
  name: string;
  placeType: PlaceType;
  matchTool: string | null;
  matchKeyword: string | null;
  matchTag: string | null;
  matchMemoryType: string | null;
  priority: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaceRuleCreateInput {
  projectId?: string;
  name: string;
  placeType: PlaceType;
  matchTool?: string;
  matchKeyword?: string;
  matchTag?: string;
  matchMemoryType?: string;
  priority?: number;
  enabled?: boolean;
}

export interface RuleMatchInput {
  toolName?: string;
  content?: string;
  tags?: string[];
  memoryType?: string;
}

/**
 * Default auto-assignment rules
 */
export const DEFAULT_RULES: Omit<PlaceRuleCreateInput, 'projectId'>[] = [
  // WIP - Implementation, code, fixes
  { name: 'Write to WIP', placeType: 'wip', matchTool: 'Write', priority: 100 },
  { name: 'Edit to WIP', placeType: 'wip', matchTool: 'Edit', priority: 100 },
  { name: 'MultiEdit to WIP', placeType: 'wip', matchTool: 'MultiEdit', priority: 100 },
  { name: 'Fix keyword to WIP', placeType: 'wip', matchKeyword: 'fix', priority: 80 },
  { name: 'Bug keyword to WIP', placeType: 'wip', matchKeyword: 'bug', priority: 80 },
  
  // Sandbox - Experiments, tests
  { name: 'Test to Sandbox', placeType: 'sandbox', matchTool: 'Bash', matchKeyword: 'test', priority: 90 },
  { name: 'Test tag to Sandbox', placeType: 'sandbox', matchTag: 'test', priority: 85 },
  
  // Board - Decisions, planning
  { name: 'Task to Board', placeType: 'board', matchTool: 'Task', priority: 100 },
  { name: 'TodoWrite to Board', placeType: 'board', matchTool: 'TodoWrite', priority: 100 },
  { name: 'Decision keyword to Board', placeType: 'board', matchKeyword: 'decided', priority: 70 },
  { name: 'Planning keyword to Board', placeType: 'board', matchKeyword: 'will implement', priority: 70 },
  
  // Ref - Research, patterns
  { name: 'Search to Ref', placeType: 'ref', matchTool: 'grep', priority: 90 },
  { name: 'WebFetch to Ref', placeType: 'ref', matchTool: 'WebFetch', priority: 85 },
  { name: 'Research keyword to Ref', placeType: 'ref', matchKeyword: 'research', priority: 80 },
  { name: 'Pattern keyword to Ref', placeType: 'ref', matchKeyword: 'pattern', priority: 75 },
  
  // Sparks - Ideas, future
  { name: 'Idea keyword to Sparks', placeType: 'sparks', matchKeyword: 'idea', priority: 80 },
  { name: 'Explore keyword to Sparks', placeType: 'sparks', matchKeyword: 'explore', priority: 75 },
  { name: 'Future keyword to Sparks', placeType: 'sparks', matchKeyword: 'will add', priority: 70 },
];

/**
 * Create a place rule
 */
export async function createPlaceRule(input: PlaceRuleCreateInput): Promise<PlaceRule> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('create_rule', input.projectId ?? 'global');
  const db = await getDb();
  if (!db) {
    throw new Error('Database unavailable');
  }

  const schema = await getSchema();
  const sqliteDb = db as any;
  const id = randomUUID();

  const resolvedProjectId = input.projectId || (await ensureGlobalProject()).id;

  await sqliteDb.insert(schema.placeRules).values({
    id,
    projectId: resolvedProjectId,
    name: input.name,
    placeType: input.placeType,
    matchTool: input.matchTool || null,
    matchKeyword: input.matchKeyword || null,
    matchTag: input.matchTag || null,
    matchMemoryType: input.matchMemoryType || null,
    priority: input.priority ?? 0,
    enabled: input.enabled !== false ? 1 : 0,
  });

  logger.info(`[PlaceRules] Created rule: ${input.name} -> ${input.placeType}`);

  return {
    id,
    projectId: resolvedProjectId,
    name: input.name,
    placeType: input.placeType,
    matchTool: input.matchTool || null,
    matchKeyword: input.matchKeyword || null,
    matchTag: input.matchTag || null,
    matchMemoryType: input.matchMemoryType || null,
    priority: input.priority ?? 0,
    enabled: input.enabled ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Get rules for a project or global scope
 */
export async function getProjectRules(projectId?: string): Promise<PlaceRule[]> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('list_rules', projectId ?? 'global');
  const db = await getDb();
  if (!db) return [];

  const schema = await getSchema();
  const sqliteDb = db as any;

  const resolvedProjectId = projectId || (await ensureGlobalProject()).id;

  const results = await sqliteDb.select()
    .from(schema.placeRules)
    .where(eq(schema.placeRules.projectId, resolvedProjectId))
    .orderBy(desc(schema.placeRules.priority));

  return results.map((row: any) => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    placeType: (row.place_type || row.placeType || 'custom') as PlaceType,
    matchTool: row.match_tool || row.matchTool,
    matchKeyword: row.match_keyword || row.matchKeyword,
    matchTag: row.match_tag || row.matchTag,
    matchMemoryType: row.match_memory_type || row.matchMemoryType,
    priority: row.priority ?? 0,
    enabled: row.enabled === 1 || row.enabled === true,
    createdAt: new Date(row.created_at || Date.now()),
    updatedAt: new Date(row.updated_at || Date.now()),
  }));
}

/**
 * Check if a rule matches the input
 * A rule matches only if ALL of its specified conditions are met.
 */
export function matchesRule(rule: PlaceRule, input: RuleMatchInput): boolean {
  const hasToolCondition = !!rule.matchTool;
  const hasKeywordCondition = !!rule.matchKeyword;
  const hasTagCondition = !!rule.matchTag;
  const hasMemoryTypeCondition = !!rule.matchMemoryType;

  // A rule must have at least one match condition
  if (!hasToolCondition && !hasKeywordCondition && !hasTagCondition && !hasMemoryTypeCondition) {
    return false;
  }

  // Check tool match - if rule requires tool, input must have a matching tool
  if (hasToolCondition) {
    if (!input.toolName) return false;
    if (input.toolName.toLowerCase() !== rule.matchTool!.toLowerCase()) {
      return false;
    }
  }

  // Check keyword match - if rule requires keyword, input must have matching content
  if (hasKeywordCondition) {
    if (!input.content) return false;
    const contentLower = input.content.toLowerCase();
    if (!contentLower.includes(rule.matchKeyword!.toLowerCase())) {
      return false;
    }
  }

  // Check tag match - if rule requires tag, input must have matching tag
  if (hasTagCondition) {
    if (!input.tags) return false;
    const hasTag = input.tags.some(t => 
      t.toLowerCase() === rule.matchTag!.toLowerCase()
    );
    if (!hasTag) {
      return false;
    }
  }

  // Check memory type match - if rule requires type, input must have matching type
  if (hasMemoryTypeCondition) {
    if (!input.memoryType) return false;
    if (input.memoryType.toLowerCase() !== rule.matchMemoryType!.toLowerCase()) {
      return false;
    }
  }

  return true;
}

/**
 * Find ALL matching places for a memory, ranked by priority/weight
 * Returns ranked candidates instead of a single place
 */
export async function findMatchingPlaces(
  projectId: string | undefined,
  input: RuleMatchInput
): Promise<PlaceCandidate[]> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('match_rules', projectId ?? 'global');
  let rules = await getProjectRules(projectId);
  
  // Fallback to DEFAULT_RULES if no rules exist in DB
  if (rules.length === 0) {
    rules = DEFAULT_RULES.map(r => ({
      id: 'default',
      projectId: projectId || '__squish_global__',
      name: r.name,
      placeType: r.placeType,
      matchTool: r.matchTool || null,
      matchKeyword: r.matchKeyword || null,
      matchTag: r.matchTag || null,
      matchMemoryType: r.matchMemoryType || null,
      priority: r.priority ?? 0,
      enabled: r.enabled !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  }
  
  const enabledRules = rules
    .filter(r => r.enabled)
    .sort((a, b) => b.priority - a.priority);

  const candidates: PlaceCandidate[] = [];
  const seenTypes = new Set<PlaceType>();

  for (const rule of enabledRules) {
    if (matchesRule(rule, input)) {
      if (!seenTypes.has(rule.placeType)) {
        seenTypes.add(rule.placeType);
        
        // Weight is normalized from priority (0-100 -> 0.0-1.0)
        const weight = Math.min(1.0, rule.priority / 100);
        
        // Build reason string
        const reasons: string[] = [];
        if (rule.matchTool) reasons.push(`tool=${rule.matchTool}`);
        if (rule.matchKeyword) reasons.push(`keyword="${rule.matchKeyword}"`);
        if (rule.matchTag) reasons.push(`tag=${rule.matchTag}`);
        if (rule.matchMemoryType) reasons.push(`type=${rule.matchMemoryType}`);
        
        candidates.push({
          type: rule.placeType,
          weight,
          reason: reasons.join(', ') || rule.name,
          source: 'heuristic',
        });
      }
    }
  }

  // If no rules matched, return inbox as fallback
  if (candidates.length === 0) {
    candidates.push({
      type: 'inbox',
      weight: 0.5,
      reason: 'no matching rules - default fallback',
      source: 'heuristic',
    });
  }

  return candidates;
}

/**
 * Find matching place for a memory based on rules (backward compatible)
 * Returns the single best match
 */
export async function findMatchingPlace(
  projectId: string | undefined,
  input: RuleMatchInput
): Promise<PlaceType | null> {
  const candidates = await findMatchingPlaces(projectId, input);
  return candidates.length > 0 ? candidates[0].type : null;
}

/**
 * Adjacent places for retrieval fallback
 */
export const ADJACENT_PLACES: Record<PlaceType, PlaceType[]> = {
  board: ['wip', 'ref'],
  wip: ['board', 'ref'],
  sparks: ['board', 'wip'],
  ref: ['board', 'wip'],
  inbox: ['board', 'wip', 'sparks', 'ref'],
  sandbox: ['wip', 'inbox'],
  archive: ['inbox'],
};

/**
 * Get adjacent places for fallback retrieval
 */
export function getAdjacentPlaces(place: PlaceType): PlaceType[] {
  return ADJACENT_PLACES[place] || ['inbox'];
}

/**
 * Initialize default rules for a project or global scope.
 * If no projectId provided, uses the global scope.
 */
export async function initializeDefaultRules(projectId?: string): Promise<PlaceRule[]> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('initialize_rules', projectId ?? 'global');
  const resolvedProjectId = projectId || (await ensureGlobalProject()).id;
  const created: PlaceRule[] = [];

  // Check if rules already exist for this project (skip if yes)
  const db = await getDb();
  if (db) {
    const schema = await getSchema();
    const sqliteDb = db as any;
    const existing = await sqliteDb.select()
      .from(schema.placeRules)
      .where(eq(schema.placeRules.projectId, resolvedProjectId))
      .limit(1);
    if (existing.length > 0) {
      logger.debug(`[PlaceRules] Rules already exist for project: ${resolvedProjectId}, skipping initialization`);
      return existing;
    }
  }

  for (const ruleConfig of DEFAULT_RULES) {
    const rule = await createPlaceRule({
      projectId: resolvedProjectId,
      ...ruleConfig,
    });
    created.push(rule);
  }

  logger.info(`[PlaceRules] Initialized ${created.length} default rules for project: ${resolvedProjectId}`);
  return created;
}

/**
 * Delete a rule
 */
export async function deletePlaceRule(id: string): Promise<boolean> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('delete_rule', id);
  const db = await getDb();
  if (!db) return false;

  const schema = await getSchema();
  const sqliteDb = db as any;

  await sqliteDb.delete(schema.placeRules).where(eq(schema.placeRules.id, id));
  logger.info(`[PlaceRules] Deleted rule: ${id}`);

  return true;
}

/**
 * Update a rule
 */
export async function updatePlaceRule(
  id: string, 
  updates: Partial<PlaceRuleCreateInput>
): Promise<PlaceRule | null> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('update_rule', id);
  const db = await getDb();
  if (!db) return null;

  const schema = await getSchema();
  const sqliteDb = db as any;

  const updateData: any = {};
  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.placeType !== undefined) updateData.placeType = updates.placeType;
  if (updates.matchTool !== undefined) updateData.matchTool = updates.matchTool;
  if (updates.matchKeyword !== undefined) updateData.matchKeyword = updates.matchKeyword;
  if (updates.matchTag !== undefined) updateData.matchTag = updates.matchTag;
  if (updates.matchMemoryType !== undefined) updateData.matchMemoryType = updates.matchMemoryType;
  if (updates.priority !== undefined) updateData.priority = updates.priority;
  if (updates.enabled !== undefined) updateData.enabled = updates.enabled;

  if (Object.keys(updateData).length === 0) return null;

  await sqliteDb.update(schema.placeRules)
    .set(updateData)
    .where(eq(schema.placeRules.id, id));

  const result = await sqliteDb.select()
    .from(schema.placeRules)
    .where(eq(schema.placeRules.id, id))
    .limit(1);

  if (result.length === 0) return null;

  const row = result[0];
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    placeType: row.place_type as PlaceType,
    matchTool: row.match_tool,
    matchKeyword: row.match_keyword,
    matchTag: row.match_tag,
    matchMemoryType: row.match_memory_type,
    priority: row.priority,
    enabled: row.enabled === 1 || row.enabled === true,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
