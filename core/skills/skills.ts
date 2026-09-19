import { eq, and, desc, asc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDbClient } from '../lib/db-client.js';
import { logger } from '../logger.js';

// ============================================================================
// Types
// ============================================================================

export interface SkillRecord {
  id: string;
  projectId: string | null;
  userId: string | null;
  name: string;
  description: string | null;
  skillType: string;
  status: string;
  visibility: string;
  triggerConditions: Record<string, unknown> | null;
  steps: Array<{ step: number; action: string; description: string; tool?: string }> | null;
  resources: string[] | null;
  validationRules: Record<string, unknown> | null;
  successCriteria: string | null;
  failureIndicators: string | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  usageCount: number;
  successCount: number;
  failureCount: number;
  lastUsedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  version: number;
  supersedes: string | null;
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillVersionRecord {
  id: string;
  skillId: string;
  version: number;
  name: string;
  description: string | null;
  triggerConditions: Record<string, unknown> | null;
  steps: Array<{ step: number; action: string; description: string; tool?: string }> | null;
  resources: string[] | null;
  validationRules: Record<string, unknown> | null;
  changeSummary: string | null;
  createdAt: Date;
}

export interface SkillAssignmentRecord {
  id: string;
  skillId: string;
  agentId: string;
  priority: number;
  enabled: boolean;
  contextFilter: Record<string, unknown> | null;
  assignedBy: string | null;
  createdAt: Date;
}

export interface CreateSkillInput {
  projectId?: string;
  userId?: string;
  name: string;
  description?: string;
  skillType?: string;
  visibility?: string;
  triggerConditions?: Record<string, unknown>;
  steps?: Array<{ step: number; action: string; description: string; tool?: string }>;
  resources?: string[];
  validationRules?: Record<string, unknown>;
  successCriteria?: string;
  failureIndicators?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  agentId?: string;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  skillType?: string;
  status?: string;
  visibility?: string;
  triggerConditions?: Record<string, unknown>;
  steps?: Array<{ step: number; action: string; description: string; tool?: string }>;
  resources?: string[];
  validationRules?: Record<string, unknown>;
  successCriteria?: string;
  failureIndicators?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  agentId?: string;
  changeSummary?: string;
}

// ============================================================================
// Errors
// ============================================================================

export class SkillNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Skill not found: ${identifier}`);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillConflictError extends Error {
  constructor(name: string) {
    super(`Skill with name "${name}" already exists in this project`);
    this.name = 'SkillConflictError';
  }
}

// ============================================================================
// Normalizers
// ============================================================================

function normalizeSkill(row: any): SkillRecord {
  return {
    id: row.id,
    projectId: row.projectId ?? row.project_id ?? null,
    userId: row.userId ?? row.user_id ?? null,
    name: row.name,
    description: row.description ?? null,
    skillType: row.skillType ?? row.skill_type ?? 'workflow',
    status: row.status ?? 'draft',
    visibility: row.visibility ?? 'private',
    triggerConditions: parseJsonField(row.triggerConditions ?? row.trigger_conditions),
    steps: parseJsonField(row.steps),
    resources: parseJsonField(row.resources),
    validationRules: parseJsonField(row.validationRules ?? row.validation_rules),
    successCriteria: row.successCriteria ?? row.success_criteria ?? null,
    failureIndicators: row.failureIndicators ?? row.failure_indicators ?? null,
    tags: parseJsonField(row.tags),
    metadata: parseJsonField(row.metadata),
    usageCount: row.usageCount ?? row.usage_count ?? 0,
    successCount: row.successCount ?? row.success_count ?? 0,
    failureCount: row.failureCount ?? row.failure_count ?? 0,
    lastUsedAt: row.lastUsedAt ?? row.last_used_at ?? null,
    lastSuccessAt: row.lastSuccessAt ?? row.last_success_at ?? null,
    lastFailureAt: row.lastFailureAt ?? row.last_failure_at ?? null,
    version: row.version ?? 1,
    supersedes: row.supersedes ?? null,
    agentId: row.agentId ?? row.agent_id ?? null,
    createdAt: row.createdAt ?? row.created_at ?? new Date(),
    updatedAt: row.updatedAt ?? row.updated_at ?? new Date(),
  };
}

function normalizeSkillVersion(row: any): SkillVersionRecord {
  return {
    id: row.id,
    skillId: row.skillId ?? row.skill_id,
    version: row.version,
    name: row.name,
    description: row.description ?? null,
    triggerConditions: parseJsonField(row.triggerConditions ?? row.trigger_conditions),
    steps: parseJsonField(row.steps),
    resources: parseJsonField(row.resources),
    validationRules: parseJsonField(row.validationRules ?? row.validation_rules),
    changeSummary: row.changeSummary ?? row.change_summary ?? null,
    createdAt: row.createdAt ?? row.created_at ?? new Date(),
  };
}

function normalizeAssignment(row: any): SkillAssignmentRecord {
  return {
    id: row.id,
    skillId: row.skillId ?? row.skill_id,
    agentId: row.agentId ?? row.agent_id,
    priority: row.priority ?? 0,
    enabled: row.enabled ?? true,
    contextFilter: parseJsonField(row.contextFilter ?? row.context_filter),
    assignedBy: row.assignedBy ?? row.assigned_by ?? null,
    createdAt: row.createdAt ?? row.created_at ?? new Date(),
  };
}

function parseJsonField(value: any): any {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

// ============================================================================
// Skill CRUD
// ============================================================================

export async function createSkill(input: CreateSkillInput): Promise<SkillRecord> {
  const { db, schema } = await getDbClient();
  const id = randomUUID();
  const now = new Date();

  await db.insert(schema.skills).values({
    id,
    projectId: input.projectId ?? null,
    userId: input.userId ?? null,
    name: input.name,
    description: input.description ?? null,
    skillType: input.skillType ?? 'workflow',
    status: 'draft',
    visibility: input.visibility ?? 'private',
    triggerConditions: input.triggerConditions ?? null,
    steps: input.steps ?? null,
    resources: input.resources ?? null,
    validationRules: input.validationRules ?? null,
    successCriteria: input.successCriteria ?? null,
    failureIndicators: input.failureIndicators ?? null,
    tags: input.tags ?? null,
    metadata: input.metadata ?? null,
    agentId: input.agentId ?? null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as any);

  // Auto-create initial version snapshot
  await db.insert(schema.skillVersions).values({
    id: randomUUID(),
    skillId: id,
    version: 1,
    name: input.name,
    description: input.description ?? null,
    triggerConditions: input.triggerConditions ?? null,
    steps: input.steps ?? null,
    resources: input.resources ?? null,
    validationRules: input.validationRules ?? null,
    changeSummary: 'Initial creation',
    createdAt: now,
  } as any);

  logger.info(`Created skill: ${input.name} (${id})`);
  const skill = await getSkillById(id);
  if (!skill) throw new Error('Failed to retrieve created skill');
  return skill;
}

export async function getSkillById(id: string): Promise<SkillRecord | null> {
  const { db, schema } = await getDbClient();
  const rows = await db.select().from(schema.skills).where(eq(schema.skills.id, id)).limit(1);
  return rows[0] ? normalizeSkill(rows[0]) : null;
}

export async function getSkillByName(projectId: string | null, name: string): Promise<SkillRecord | null> {
  const { db, schema } = await getDbClient();
  const conditions = [eq(schema.skills.name, name)];
  if (projectId) {
    conditions.push(eq(schema.skills.projectId, projectId));
  } else {
    conditions.push(eq(schema.skills.projectId, null as any));
  }
  const rows = await db.select().from(schema.skills).where(and(...conditions)).limit(1);
  return rows[0] ? normalizeSkill(rows[0]) : null;
}

export async function listSkills(options: {
  projectId?: string;
  userId?: string;
  status?: string;
  visibility?: string;
  skillType?: string;
  agentId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<SkillRecord[]> {
  const { db, schema } = await getDbClient();
  const conditions: any[] = [];

  if (options.projectId) conditions.push(eq(schema.skills.projectId, options.projectId));
  if (options.userId) conditions.push(eq(schema.skills.userId, options.userId));
  if (options.status) conditions.push(eq(schema.skills.status, options.status));
  if (options.visibility) conditions.push(eq(schema.skills.visibility, options.visibility));
  if (options.skillType) conditions.push(eq(schema.skills.skillType, options.skillType));
  if (options.agentId) conditions.push(eq(schema.skills.agentId, options.agentId));

  const query = db.select().from(schema.skills);
  const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;
  const ordered = filtered.orderBy(desc(schema.skills.updatedAt));

  const limited = options.limit ? ordered.limit(options.limit) : ordered;
  const final = options.offset ? limited.offset(options.offset) : limited;

  const rows = await final;
  return rows.map(normalizeSkill);
}

export async function updateSkill(id: string, input: UpdateSkillInput): Promise<SkillRecord> {
  const { db, schema } = await getDbClient();
  const now = new Date();

  const existing = await getSkillById(id);
  if (!existing) throw new SkillNotFoundError(id);

  const setValues: Record<string, any> = { updatedAt: now };
  if (input.name !== undefined) setValues.name = input.name;
  if (input.description !== undefined) setValues.description = input.description;
  if (input.skillType !== undefined) setValues.skillType = input.skillType;
  if (input.status !== undefined) setValues.status = input.status;
  if (input.visibility !== undefined) setValues.visibility = input.visibility;
  if (input.triggerConditions !== undefined) setValues.triggerConditions = input.triggerConditions;
  if (input.steps !== undefined) setValues.steps = input.steps;
  if (input.resources !== undefined) setValues.resources = input.resources;
  if (input.validationRules !== undefined) setValues.validationRules = input.validationRules;
  if (input.successCriteria !== undefined) setValues.successCriteria = input.successCriteria;
  if (input.failureIndicators !== undefined) setValues.failureIndicators = input.failureIndicators;
  if (input.tags !== undefined) setValues.tags = input.tags;
  if (input.metadata !== undefined) setValues.metadata = input.metadata;
  if (input.agentId !== undefined) setValues.agentId = input.agentId;

  // Auto-increment version if content changed
  const contentChanged = input.steps || input.triggerConditions || input.name || input.description;
  if (contentChanged) {
    setValues.version = existing.version + 1;
  }

  await db.update(schema.skills).set(setValues).where(eq(schema.skills.id, id));

  // Create version snapshot if content changed
  if (contentChanged) {
    const newVersion = existing.version + 1;
    await db.insert(schema.skillVersions).values({
      id: randomUUID(),
      skillId: id,
      version: newVersion,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      triggerConditions: input.triggerConditions ?? existing.triggerConditions,
      steps: input.steps ?? existing.steps,
      resources: input.resources ?? existing.resources,
      validationRules: input.validationRules ?? existing.validationRules,
      changeSummary: input.changeSummary ?? `Updated to version ${newVersion}`,
      createdAt: now,
    } as any);
  }

  const skill = await getSkillById(id);
  if (!skill) throw new Error('Failed to retrieve updated skill');
  return skill;
}

export async function deleteSkill(id: string): Promise<void> {
  const { db, schema } = await getDbClient();
  await db.delete(schema.skills).where(eq(schema.skills.id, id));
  logger.info(`Deleted skill: ${id}`);
}

export async function requireSkill(id: string): Promise<SkillRecord> {
  const skill = await getSkillById(id);
  if (!skill) throw new SkillNotFoundError(id);
  return skill;
}

// ============================================================================
// Skill Versions
// ============================================================================

export async function getSkillVersions(skillId: string): Promise<SkillVersionRecord[]> {
  const { db, schema } = await getDbClient();
  const rows = await db
    .select()
    .from(schema.skillVersions)
    .where(eq(schema.skillVersions.skillId, skillId))
    .orderBy(asc(schema.skillVersions.version));
  return rows.map(normalizeSkillVersion);
}

export async function getSkillVersion(skillId: string, version: number): Promise<SkillVersionRecord | null> {
  const { db, schema } = await getDbClient();
  const rows = await db
    .select()
    .from(schema.skillVersions)
    .where(and(eq(schema.skillVersions.skillId, skillId), eq(schema.skillVersions.version, version)))
    .limit(1);
  return rows[0] ? normalizeSkillVersion(rows[0]) : null;
}

// ============================================================================
// Skill Assignments
// ============================================================================

export async function assignSkill(
  skillId: string,
  agentId: string,
  options: { priority?: number; contextFilter?: Record<string, unknown>; assignedBy?: string } = {},
): Promise<SkillAssignmentRecord> {
  const { db, schema } = await getDbClient();
  const id = randomUUID();

  await db.insert(schema.skillAssignments).values({
    id,
    skillId,
    agentId,
    priority: options.priority ?? 0,
    enabled: true,
    contextFilter: options.contextFilter ?? null,
    assignedBy: options.assignedBy ?? null,
    createdAt: new Date(),
  } as any);

  const rows = await db.select().from(schema.skillAssignments).where(eq(schema.skillAssignments.id, id)).limit(1);
  if (!rows[0]) throw new Error('Failed to create assignment');
  return normalizeAssignment(rows[0]);
}

export async function unassignSkill(skillId: string, agentId: string): Promise<void> {
  const { db, schema } = await getDbClient();
  await db
    .delete(schema.skillAssignments)
    .where(and(eq(schema.skillAssignments.skillId, skillId), eq(schema.skillAssignments.agentId, agentId)));
}

export async function getAgentSkills(agentId: string): Promise<{ skill: SkillRecord; assignment: SkillAssignmentRecord }[]> {
  const { db, schema } = await getDbClient();

  const assignments = await db
    .select()
    .from(schema.skillAssignments)
    .where(and(eq(schema.skillAssignments.agentId, agentId), eq(schema.skillAssignments.enabled, true)))
    .orderBy(desc(schema.skillAssignments.priority));

  const results: { skill: SkillRecord; assignment: SkillAssignmentRecord }[] = [];
  for (const assignment of assignments) {
    const skill = await getSkillById(assignment.skillId ?? (assignment as any).skill_id);
    if (skill) {
      results.push({ skill, assignment: normalizeAssignment(assignment) });
    }
  }
  return results;
}

// ============================================================================
// Skill Usage Tracking
// ============================================================================

export async function recordSkillUsage(
  skillId: string,
  success: boolean,
): Promise<void> {
  const { db, schema } = await getDbClient();
  const now = new Date();

  const updates: Record<string, any> = {
    usageCount: { increment: 1 } as any,
    lastUsedAt: now,
    updatedAt: now,
  };

  if (success) {
    updates.successCount = { increment: 1 } as any;
    updates.lastSuccessAt = now;
  } else {
    updates.failureCount = { increment: 1 } as any;
    updates.lastFailureAt = now;
  }

  // Simple increment approach (Drizzle doesn't support increment natively in all drivers)
  const skill = await getSkillById(skillId);
  if (!skill) return;

  await db.update(schema.skills).set({
    usageCount: skill.usageCount + 1,
    successCount: skill.successCount + (success ? 1 : 0),
    failureCount: skill.failureCount + (success ? 0 : 1),
    lastUsedAt: now,
    lastSuccessAt: success ? now : skill.lastSuccessAt,
    lastFailureAt: success ? skill.lastFailureAt : now,
    updatedAt: now,
  } as any).where(eq(schema.skills.id, skillId));
}

// ============================================================================
// Skill Search
// ============================================================================

export async function searchSkills(
  query: string,
  options: { projectId?: string; limit?: number } = {},
): Promise<SkillRecord[]> {
  const { db, schema } = await getDbClient();

  // Simple LIKE search - can be enhanced with FTS5 later
  const conditions: any[] = [];
  if (options.projectId) conditions.push(eq(schema.skills.projectId, options.projectId));

  const rows = await db
    .select()
    .from(schema.skills)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.skills.usageCount));

  const limit = options.limit ?? 20;
  return rows
    .map(normalizeSkill)
    .filter((skill: SkillRecord) => {
      const q = query.toLowerCase();
      return (
        skill.name.toLowerCase().includes(q) ||
        (skill.description && skill.description.toLowerCase().includes(q)) ||
        (skill.tags && skill.tags.some((t: string) => t.toLowerCase().includes(q)))
      );
    })
    .slice(0, limit);
}
