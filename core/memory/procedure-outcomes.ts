import { getDbClient } from '../lib/db-client.js';
import { createKnowledgeEdge } from '../knowledge/store.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';

interface ProcedureOutcome {
  procedureKey: string;
  result: 'success' | 'failure';
  evidenceId: string;
  sourceId: string;
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Link opposite, explicitly attributed outcomes for the same scoped procedure. */
export async function linkConflictingProcedureOutcomes(input: {
  knowledgeId: string;
  projectId: string | null;
  userId: string | null;
  teamId: string | null;
  outcome: ProcedureOutcome;
}): Promise<number> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(input.knowledgeId, 'memory_lifecycle', 'Procedure outcome linking is disabled under strict trust until caller-scoped source authorization is implemented');
  }
  if (!input.outcome.sourceId.trim() || !input.outcome.evidenceId.trim() || !input.outcome.procedureKey.trim()) return 0;
  const { raw } = await getDbClient();
  const sqlite = (raw as { $client?: { prepare: (sql: string) => { all: (...params: (string | null | number)[]) => Array<{ id: string; metadata: string | null; team_id: string | null }> } } }).$client;
  if (!sqlite) return 0;
  const candidates = sqlite.prepare(`
    SELECT k.id, k.metadata, m.team_id
    FROM knowledge k
    JOIN memories m ON m.id = json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.sourceMemoryId')
    WHERE k.knowledge_kind = 'memory' AND k.status = 'active'
      AND k.project_id IS ? AND k.user_id IS ? AND m.team_id IS ?
    ORDER BY k.created_at DESC LIMIT 500
  `).all(input.projectId, input.userId, input.teamId);

  let linked = 0;
  for (const candidate of candidates) {
    if (candidate.id === input.knowledgeId) continue;
    const metadata = parseMetadata(candidate.metadata);
    const existingOutcome = parseMetadata(metadata?.procedureOutcome);
    const existing = existingOutcome && typeof metadata?.sourceId === 'string'
      ? { ...existingOutcome, sourceId: metadata.sourceId } as ProcedureOutcome
      : null;
    if (!existing || existing.procedureKey !== input.outcome.procedureKey || existing.result === input.outcome.result) continue;
    if (!existing.sourceId.trim() || !existing.evidenceId?.trim()) continue;

    await createKnowledgeEdge({
      fromId: input.knowledgeId,
      fromKind: 'knowledge',
      toId: candidate.id,
      toKind: 'knowledge',
      edgeType: 'contradicts',
      metadata: {
        reviewRequired: true,
        procedureKey: input.outcome.procedureKey,
        outcomes: [
          { result: input.outcome.result, sourceId: input.outcome.sourceId, evidenceId: input.outcome.evidenceId },
          { result: existing.result, sourceId: existing.sourceId, evidenceId: existing.evidenceId },
        ],
      },
    });
    linked++;
  }
  return linked;
}
