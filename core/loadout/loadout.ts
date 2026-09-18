import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDbClient } from '../lib/db-client.js';
import { logger } from '../logger.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentLoadoutRecord {
  id: string;
  agentId: string;
  assetType: string;
  assetId: string;
  priority: number;
  enabled: boolean;
  injectionMode: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface VisibilityRuleRecord {
  id: string;
  assetType: string;
  assetId: string;
  ruleType: string;
  granteeType: string;
  granteeId: string;
  permission: string;
  createdAt: Date;
}

// ============================================================================
// Agent Loadout CRUD
// ============================================================================

export async function addLoadout(input: {
  agentId: string;
  assetType: string;
  assetId: string;
  priority?: number;
  injectionMode?: string;
  metadata?: Record<string, unknown>;
}): Promise<AgentLoadoutRecord> {
  const { db, schema } = await getDbClient();
  const id = randomUUID();

  await db.insert(schema.agentLoadouts).values({
    id,
    agentId: input.agentId,
    assetType: input.assetType,
    assetId: input.assetId,
    priority: input.priority ?? 0,
    enabled: true,
    injectionMode: input.injectionMode ?? 'append',
    metadata: input.metadata ?? null,
    createdAt: new Date(),
  } as any);

  const rows = await db.select().from(schema.agentLoadouts).where(eq(schema.agentLoadouts.id, id)).limit(1);
  return normalizeLoadout(rows[0]);
}

export async function removeLoadout(agentId: string, assetType: string, assetId: string): Promise<void> {
  const { db, schema } = await getDbClient();
  await db
    .delete(schema.agentLoadouts)
    .where(
      and(
        eq(schema.agentLoadouts.agentId, agentId),
        eq(schema.agentLoadouts.assetType, assetType),
        eq(schema.agentLoadouts.assetId, assetId),
      ),
    );
}

export async function getAgentLoadout(agentId: string): Promise<AgentLoadoutRecord[]> {
  const { db, schema } = await getDbClient();
  const rows = await db
    .select()
    .from(schema.agentLoadouts)
    .where(and(eq(schema.agentLoadouts.agentId, agentId), eq(schema.agentLoadouts.enabled, true)))
    .orderBy(desc(schema.agentLoadouts.priority));
  return rows.map(normalizeLoadout);
}

export async function updateLoadoutPriority(
  agentId: string,
  assetType: string,
  assetId: string,
  priority: number,
): Promise<void> {
  const { db, schema } = await getDbClient();
  await db
    .update(schema.agentLoadouts)
    .set({ priority })
    .where(
      and(
        eq(schema.agentLoadouts.agentId, agentId),
        eq(schema.agentLoadouts.assetType, assetType),
        eq(schema.agentLoadouts.assetId, assetId),
      ),
    );
}

export async function toggleLoadout(
  agentId: string,
  assetType: string,
  assetId: string,
  enabled: boolean,
): Promise<void> {
  const { db, schema } = await getDbClient();
  await db
    .update(schema.agentLoadouts)
    .set({ enabled })
    .where(
      and(
        eq(schema.agentLoadouts.agentId, agentId),
        eq(schema.agentLoadouts.assetType, assetType),
        eq(schema.agentLoadouts.assetId, assetId),
      ),
    );
}

// ============================================================================
// Visibility Rules
// ============================================================================

export async function setVisibilityRule(input: {
  assetType: string;
  assetId: string;
  ruleType: string;
  granteeType: string;
  granteeId: string;
  permission?: string;
}): Promise<VisibilityRuleRecord> {
  const { db, schema } = await getDbClient();
  const id = randomUUID();

  await db.insert(schema.visibilityRules).values({
    id,
    assetType: input.assetType,
    assetId: input.assetId,
    ruleType: input.ruleType,
    granteeType: input.granteeType,
    granteeId: input.granteeId,
    permission: input.permission ?? 'read',
    createdAt: new Date(),
  } as any);

  const rows = await db.select().from(schema.visibilityRules).where(eq(schema.visibilityRules.id, id)).limit(1);
  return normalizeVisibilityRule(rows[0]);
}

export async function removeVisibilityRule(
  assetType: string,
  assetId: string,
  granteeType: string,
  granteeId: string,
): Promise<void> {
  const { db, schema } = await getDbClient();
  await db
    .delete(schema.visibilityRules)
    .where(
      and(
        eq(schema.visibilityRules.assetType, assetType),
        eq(schema.visibilityRules.assetId, assetId),
        eq(schema.visibilityRules.granteeType, granteeType),
        eq(schema.visibilityRules.granteeId, granteeId),
      ),
    );
}

export async function getVisibilityRules(
  assetType: string,
  assetId: string,
): Promise<VisibilityRuleRecord[]> {
  const { db, schema } = await getDbClient();
  const rows = await db
    .select()
    .from(schema.visibilityRules)
    .where(
      and(
        eq(schema.visibilityRules.assetType, assetType),
        eq(schema.visibilityRules.assetId, assetId),
      ),
    );
  return rows.map(normalizeVisibilityRule);
}

/**
 * Cheap existence check: are there ANY visibility rules for a given asset type?
 * Single indexed lookup used by search paths to skip ACL work entirely
 * when no rules exist.
 */
export async function hasVisibilityRules(assetType: string): Promise<boolean> {
  const { db, schema } = await getDbClient();
  const rows = await db
    .select({ id: schema.visibilityRules.id })
    .from(schema.visibilityRules)
    .where(eq(schema.visibilityRules.assetType, assetType))
    .limit(1);
  return rows.length > 0;
}

export async function checkVisibility(
  assetType: string,
  assetId: string,
  userId: string,
  teamIds: string[],
): Promise<{ allowed: boolean; permission: string }> {
  const rules = await getVisibilityRules(assetType, assetId);

  // No rules = private (owner only)
  if (rules.length === 0) {
    return { allowed: false, permission: 'none' };
  }

  for (const rule of rules) {
    if (rule.granteeType === 'user' && rule.granteeId === userId) {
      return { allowed: true, permission: rule.permission };
    }
    if (rule.granteeType === 'team' && teamIds.includes(rule.granteeId)) {
      return { allowed: true, permission: rule.permission };
    }
    if (rule.granteeType === 'everyone') {
      return { allowed: true, permission: rule.permission };
    }
  }

  return { allowed: false, permission: 'none' };
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeLoadout(row: any): AgentLoadoutRecord {
  return {
    id: row.id,
    agentId: row.agentId ?? row.agent_id,
    assetType: row.assetType ?? row.asset_type,
    assetId: row.assetId ?? row.asset_id,
    priority: row.priority ?? 0,
    enabled: row.enabled ?? true,
    injectionMode: row.injectionMode ?? row.injection_mode ?? 'append',
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata ?? null,
    createdAt: row.createdAt ?? row.created_at ?? new Date(),
  };
}

function normalizeVisibilityRule(row: any): VisibilityRuleRecord {
  return {
    id: row.id,
    assetType: row.assetType ?? row.asset_type,
    assetId: row.assetId ?? row.asset_id,
    ruleType: row.ruleType ?? row.rule_type,
    granteeType: row.granteeType ?? row.grantee_type,
    granteeId: row.granteeId ?? row.grantee_id,
    permission: row.permission ?? 'read',
    createdAt: row.createdAt ?? row.created_at ?? new Date(),
  };
}
