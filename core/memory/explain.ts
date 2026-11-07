import { eq } from 'drizzle-orm';
import { getDbClient } from '../lib/db-client.js';
import { deserializeMetadata } from './serialization.js';
import { extractMemoryPolicy } from './policy.js';
import { getMemorySnapshot } from '../snapshots/retrieval.js';
import { getMemoryPlace } from '../places/memory-places.js';
import { getPlace } from '../places/places.js';
import { getBeliefsForMemory } from '../knowledge/store.js';
import type { StoredBelief } from '../knowledge/types.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';

export interface MemoryInspection {
  id: string;
  type: string;
  classification: string;
  reasons: string[];
  rawFallbackSnapshotId?: string | null;
  nuanceSuppressed: boolean;
  place?: string | null;
  placeType?: string | null;
  graphStatus?: string | null;
  content: string;
  legacyMetadata: boolean;
  memoryPolicy?: Record<string, unknown> | null;
  beliefs?: StoredBelief[];
}

export function summarizeInspection(input: MemoryInspection): string {
  const lines = [
    `Memory ${input.id}`,
    `Type: ${input.type}`,
    `Classification: ${input.classification}`,
    `Reasons: ${input.reasons.join('; ') || 'n/a'}`,
    `Raw fallback: ${input.rawFallbackSnapshotId ?? 'none'}`,
    `nuance suppressed: ${input.nuanceSuppressed ? 'yes' : 'no'}`,
    `Place: ${input.place ?? 'none'}${input.placeType ? ` (${input.placeType})` : ''}`,
    `Graph: ${input.graphStatus ?? 'none'}`,
    `Content: ${input.content}`,
    `Legacy metadata: ${input.legacyMetadata ? 'yes' : 'no'}`,
  ];
  if (input.beliefs && input.beliefs.length > 0) {
    lines.push('Beliefs:');
    for (const belief of input.beliefs) {
      const confidence = typeof belief.confidence === 'number' ? belief.confidence.toFixed(1) : '?';
      const sourceCount = belief.sourceMemoryIds?.length ?? 1;
      const origin = sourceCount > 1 ? `derived from ${sourceCount} memories` : 'derived from 1 memory';
      const evidence = belief.evidenceSummary 
        ? `\n  Evidence: ${belief.evidenceSummary.slice(0, 100)}${belief.evidenceSummary.length > 100 ? '...' : ''}`
        : '';
      lines.push(`- [${belief.type}] ${belief.statement}`);
      lines.push(`  Status: ${belief.status}, Confidence: ${confidence}/100, ${origin}${evidence}`);
      if (belief.status === 'superseded') {
        lines.push(`  Note: This belief supersedes a previous version`);
      }
      if (belief.status === 'disputed') {
        lines.push(`  Warning: This belief has been disputed`);
      }
    }
  } else {
    lines.push(`Beliefs: ${input.legacyMetadata ? 'No derived beliefs available for this legacy record' : 'none derived'}`);
  }
  return lines.join('\n');
}

export async function explainMemory(id: string): Promise<MemoryInspection | null> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(id, 'memory', 'Unscoped memory inspection is disabled under strict trust');
  }

  const { db, schema } = await getDbClient();
  const rows = await db.select().from(schema.memories).where(eq(schema.memories.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;

  const metadata = deserializeMetadata(row.metadata ?? null) as Record<string, any> | null;
  const signal = (metadata?.signal ?? {}) as Record<string, any>;
  // Rows written before key unification carry classification under the
  // memorySignals block instead; honor both so fresh and pre-unification
  // metadata classify correctly. 'legacy-durable' stays the last resort only.
  const memorySignals = (metadata?.memorySignals ?? {}) as Record<string, any>;
  const rawClassification =
    signal.classification ?? memorySignals.classification ?? metadata?.classification ?? null;
  const classification: string = typeof rawClassification === 'string' && rawClassification.trim().length > 0
    ? rawClassification
    : 'legacy-durable';
  const reasons: string[] = Array.isArray(signal.reasons)
    ? (signal.reasons as string[])
    : Array.isArray(metadata?.reasons)
      ? (metadata?.reasons as string[])
      : ['This record predates signal tracking, so detailed ingestion metadata is unavailable.'];
  const rawFallbackSnapshotId = typeof metadata?.rawFallbackSnapshotId === 'string'
    ? metadata.rawFallbackSnapshotId
    : null;
  const nuanceSuppressed: boolean = Boolean(signal.nuanceSuppressed ?? metadata?.nuanceSuppressed);
  const graphStatus =
    typeof metadata?.graphStatus === 'string'
      ? metadata.graphStatus
      : typeof metadata?.graph === 'object' && metadata.graph
        ? JSON.stringify(metadata.graph)
        : 'Unavailable for this legacy record';
  const legacyMetadata = rawClassification == null;
  const memoryPolicy = extractMemoryPolicy(metadata) as Record<string, unknown> | null;

  const placeId = await getMemoryPlace(id);
  const place = placeId ? await getPlace(placeId) : null;

  if (rawFallbackSnapshotId) {
    await getMemorySnapshot(rawFallbackSnapshotId);
  }
  const beliefs = await getBeliefsForMemory(id);

  return {
    id: row.id,
    type: row.type,
    classification,
    reasons,
    rawFallbackSnapshotId,
    nuanceSuppressed,
    place: place?.name ?? null,
    placeType: place?.placeType ?? null,
    graphStatus,
    content: row.content,
    legacyMetadata,
    memoryPolicy,
    beliefs,
  };
}
