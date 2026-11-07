/**
 * Audit Trail & Provenance Tracking
 *
 * Single responsibility: managing the audit_log table and providing
 * audit trail queries and provenance chain traversal.
 *
 * The audit_log table records every operation on knowledge records.
 * The provenance chain follows sourced_from, informed_by, and extends
 * edges to trace the origin of knowledge.
 */

import { getDbClient } from '../lib/db-client.js';
import { serializeJson, deserializeJson } from './helpers.js';
import { randomUUID } from 'node:crypto';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';
import type { DrizzleExecutor } from '../storage/database.js';
import type {
  AuditEntry,
  AuditAction,
  LogAuditInput,
  AuditTrailOptions,
  ProvenanceNode,
} from './types.js';

export type { AuditEntry, AuditAction, LogAuditInput, AuditTrailOptions, ProvenanceNode } from './types.js';

// ─── Table Creation ──────────────────────────────────────────────────────────

/**
 * Ensure the audit_log table exists.
 * Called lazily on first operation.
 */
export async function ensureAuditTable(): Promise<void> {
  const { raw } = await getDbClient();
  const sqlite = (raw as any).$client;
  if (!sqlite || typeof sqlite.prepare !== 'function') return;

  const tableCheck = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'"
  ).get() as { name: string } | undefined;

  if (!tableCheck) {
    try {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          knowledge_id TEXT NOT NULL,
          action TEXT NOT NULL,
          agent_id TEXT,
          project_id TEXT,
          session_id TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        )
      `);

      sqlite.exec(`CREATE INDEX IF NOT EXISTS audit_log_knowledge_idx ON audit_log(knowledge_id)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS audit_log_agent_idx ON audit_log(agent_id)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at)`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS audit_log_knowledge_action_idx ON audit_log(knowledge_id, action)`);
    } catch (error) {
      // Table may already exist or DB not ready; fail silently
    }
  }
}

// ─── Row Mapper ──────────────────────────────────────────────────────────────

function toAuditEntry(row: any): AuditEntry {
  const createdAt = row.createdAt ?? row.created_at;
  const parsedDetails = row.details;
  return {
    id: row.id,
    knowledgeId: row.knowledgeId ?? row.knowledge_id,
    action: row.action as AuditAction,
    agentId: row.agentId ?? row.agent_id ?? null,
    projectId: row.projectId ?? row.project_id ?? null,
    sessionId: row.sessionId ?? row.session_id ?? null,
    details: typeof parsedDetails === 'string' ? deserializeJson(parsedDetails) : parsedDetails ?? null,
    createdAt: createdAt instanceof Date ? createdAt : new Date(Number(createdAt ?? 0) * 1000),
  };
}

/** Check if a knowledge record exists. */
function knowledgeExists(sqlite: any, knowledgeId: string): boolean {
  const row = sqlite.prepare(
    "SELECT 1 FROM knowledge WHERE id = ?"
  ).get(knowledgeId);
  return !!row;
}

// ─── Audit Logging ───────────────────────────────────────────────────────────

/**
 * Log an audit entry for an operation on a knowledge record.
 */
export async function logAuditEntry(input: LogAuditInput, executor?: DrizzleExecutor): Promise<AuditEntry> {
  await ensureAuditTable();
  const { db: defaultDb, schema, raw } = await getDbClient();
  const db = executor ?? defaultDb;
  if (schema.knowledgeAuditLog) {
    const entry = {
      id: randomUUID(),
      knowledgeId: input.knowledgeId,
      action: input.action,
      agentId: input.agentId ?? null,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      details: input.details ?? null,
      createdAt: new Date(),
    };
    await db.insert(schema.knowledgeAuditLog).values(entry);
    return entry;
  }
  const sqlite = (raw as any).$client;
  if (!sqlite) throw new Error('Database not available');

  const now = Math.floor(Date.now() / 1000);

  const result = sqlite.prepare(`
    INSERT INTO audit_log (knowledge_id, action, agent_id, project_id, session_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.knowledgeId,
    input.action,
    input.agentId ?? null,
    input.projectId ?? null,
    input.sessionId ?? null,
    serializeJson(input.details ?? null),
    now,
  );

  const id = result.lastInsertRowid;

  return {
    id,
    knowledgeId: input.knowledgeId,
    action: input.action,
    agentId: input.agentId ?? null,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
    details: input.details ?? null,
    createdAt: new Date(now * 1000),
  };
}

// ─── Audit Trail Queries ─────────────────────────────────────────────────────

/**
 * Get the audit trail for a knowledge record.
 * Returns entries ordered by created_at descending (most recent first).
 */
export async function getAuditTrail(
  knowledgeId: string,
  options?: AuditTrailOptions
): Promise<AuditEntry[]> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(`knowledge_audit_trail:${knowledgeId}`, 'knowledge_audit', 'Unscoped knowledge audit reads are disabled under strict trust');
  }
  await ensureAuditTable();
  const { db, schema, raw } = await getDbClient();
  if (schema.knowledgeAuditLog) {
    const { and, desc, eq } = await import('drizzle-orm');
    const table = schema.knowledgeAuditLog;
    const conditions = [eq(table.knowledgeId, knowledgeId)];
    if (options?.action) conditions.push(eq(table.action, options.action));
    if (options?.agentId) conditions.push(eq(table.agentId, options.agentId));
    const rows = await db.select().from(table)
      .where(and(...conditions))
      .orderBy(desc(table.createdAt), desc(table.id))
      .limit(options?.limit ?? 100);
    return rows.map(toAuditEntry);
  }
  const sqlite = (raw as any).$client;
  if (!sqlite) return [];

  const where: string[] = ['knowledge_id = ?'];
  const params: any[] = [knowledgeId];

  if (options?.action) {
    where.push('action = ?');
    params.push(options.action);
  }

  if (options?.agentId) {
    where.push('agent_id = ?');
    params.push(options.agentId);
  }

  const limit = options?.limit ?? 100;

  const rows = sqlite.prepare(`
    SELECT * FROM audit_log
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params, limit);

  return rows.map(toAuditEntry);
}

// ─── Provenance Chain ────────────────────────────────────────────────────────

/** Edge types that indicate provenance relationships */
const PROVENANCE_EDGE_TYPES = ['sourced_from', 'informed_by', 'extends'];

/**
 * Get the provenance chain for a knowledge record.
 * Follows sourced_from, informed_by, and extends edges to trace
 * the origin of knowledge. Uses BFS to find all ancestors.
 */
export async function getProvenanceChain(
  knowledgeId: string,
  maxDepth: number = 10
): Promise<ProvenanceNode[]> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(`knowledge_provenance_chain:${knowledgeId}`, 'knowledge_provenance', 'Unscoped provenance-chain reads are disabled under strict trust');
  }
  await ensureAuditTable();
  const { db, schema, raw } = await getDbClient();
  if (schema.knowledgeAuditLog) {
    const { and, eq, gt, inArray, isNull, lte, or } = await import('drizzle-orm');
    const table = schema.knowledgeEdges;
    const [start] = await db.select({ id: schema.knowledge.id })
      .from(schema.knowledge)
      .where(eq(schema.knowledge.id, knowledgeId))
      .limit(1);
    if (!start) return [];

    const now = new Date();
    const result: ProvenanceNode[] = [{ knowledgeId, edgeType: null, depth: 0 }];
    const visited = new Set<string>([knowledgeId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: knowledgeId, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;
      const edges = await db.select({ toId: table.toId, edgeType: table.edgeType })
        .from(table)
        .where(and(
          eq(table.fromId, current.id),
          eq(table.fromKind, 'knowledge'),
          eq(table.toKind, 'knowledge'),
          inArray(table.edgeType, PROVENANCE_EDGE_TYPES),
          lte(table.validFrom, now),
          or(isNull(table.validTo), gt(table.validTo, now)),
          lte(table.recordedAt, now),
          or(isNull(table.recordedTo), gt(table.recordedTo, now)),
        ));
      for (const edge of edges) {
        if (visited.has(edge.toId)) continue;
        visited.add(edge.toId);
        result.push({ knowledgeId: edge.toId, edgeType: edge.edgeType, depth: current.depth + 1 });
        queue.push({ id: edge.toId, depth: current.depth + 1 });
      }
    }
    return result;
  }
  const sqlite = (raw as any).$client;
  if (!sqlite) return [];

  // Return empty array if the knowledge record doesn't exist
  if (!knowledgeExists(sqlite, knowledgeId)) return [];

  const result: ProvenanceNode[] = [{ knowledgeId, edgeType: null, depth: 0 }];
  const visited = new Set<string>([knowledgeId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: knowledgeId, depth: 0 }];

  const edgeTypePlaceholders = PROVENANCE_EDGE_TYPES.map(() => '?').join(',');

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    // Find all provenance edges from this node
    const edges = sqlite.prepare(`
    SELECT to_id, edge_type FROM knowledge_edges
      WHERE from_id = ? AND from_kind = 'knowledge' AND to_kind = 'knowledge'
        AND edge_type IN (${edgeTypePlaceholders})
        AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
        AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)
    `).all(current.id, ...PROVENANCE_EDGE_TYPES, Date.now(), Date.now(), Date.now(), Date.now()) as Array<{ to_id: string; edge_type: string }>;

    for (const edge of edges) {
      if (visited.has(edge.to_id)) continue;
      visited.add(edge.to_id);
      result.push({
        knowledgeId: edge.to_id,
        edgeType: edge.edge_type,
        depth: current.depth + 1,
      });
      queue.push({ id: edge.to_id, depth: current.depth + 1 });
    }
  }

  return result;
}
