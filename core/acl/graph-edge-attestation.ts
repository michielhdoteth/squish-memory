import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from './trust-policy.js';
import { signGraphRelationProvenance } from './provenance.js';
import { writeTrustAudit } from './trust-audit.js';
import { filterStrictEntityEdges } from '../graph/strict-access.js';
import { toKnowledgeEdge } from '../knowledge/helpers.js';
import type { KnowledgeEdge } from '../knowledge/types.js';

interface SqlStatement {
  all(...params: Array<string | number | null>): Array<Record<string, unknown>>;
  get(...params: Array<string | number | null>): Record<string, unknown> | undefined;
  run(...params: Array<string | number | null>): { changes: number };
}

export interface GraphEdgeAttestationDatabase {
  exec(sql: string): unknown;
  inTransaction?: boolean;
  prepare(sql: string): SqlStatement;
}

export interface GraphEdgeSupportSelection {
  edgeId: string;
  sourceMemoryIds: string[];
}

export interface GraphEdgeAttestationOptions {
  apply: boolean;
  actorId: string;
  selections?: GraphEdgeSupportSelection[];
}

export interface UnattributedGraphEdge {
  edgeId: string;
  fromId: string;
  fromName: string | null;
  toId: string;
  toName: string | null;
  edgeType: string;
  weight: number;
  context: string | null;
}

export interface GraphEdgeAttestationResult {
  candidates: UnattributedGraphEdge[];
  selected: number;
  attested: number;
  dryRun: boolean;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function relationContext(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  if (typeof metadata.context === 'string' && metadata.context.trim()) return metadata.context.trim();
  const legacy = objectValue(metadata.legacyPayload);
  const properties = objectValue(metadata.properties) ?? objectValue(legacy?.properties);
  return typeof properties?.context === 'string' && properties.context.trim()
    ? properties.context.trim()
    : null;
}

function asCandidate(row: Record<string, unknown>): { edge: KnowledgeEdge; candidate: UnattributedGraphEdge; metadataRaw: string | null } | null {
  const edge = toKnowledgeEdge(row);
  if (edge.fromKind !== 'entity' || edge.toKind !== 'entity') return null;
  const metadata = edge.metadata;
  if (metadata?.__squishGraphProvenance || (Array.isArray(metadata?.sourceMemoryIds) && metadata.sourceMemoryIds.length > 0)) return null;
  return {
    edge,
    metadataRaw: row.metadata == null ? null : String(row.metadata),
    candidate: {
      edgeId: edge.id,
      fromId: edge.fromId,
      fromName: typeof row.from_entity_name === 'string' ? row.from_entity_name : null,
      toId: edge.toId,
      toName: typeof row.to_entity_name === 'string' ? row.to_entity_name : null,
      edgeType: edge.edgeType,
      weight: edge.weight,
      context: relationContext(metadata),
    },
  };
}

type Candidate = NonNullable<ReturnType<typeof asCandidate>>;

function readCandidates(database: GraphEdgeAttestationDatabase): Candidate[] {
  return database.prepare(`SELECT e.*, f.name AS from_entity_name, t.name AS to_entity_name
    FROM knowledge_edges e
    LEFT JOIN entities f ON f.id = e.from_id
    LEFT JOIN entities t ON t.id = e.to_id
    WHERE e.from_kind = 'entity' AND e.to_kind = 'entity' ORDER BY e.id`).all()
    .map(asCandidate).filter((row): row is NonNullable<typeof row> => row !== null);
}

function validateSelections(selections: GraphEdgeSupportSelection[] = []): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const selection of selections) {
    if (!selection || typeof selection !== 'object'
      || typeof selection.edgeId !== 'string' || !Array.isArray(selection.sourceMemoryIds)
      || selection.sourceMemoryIds.some((id) => typeof id !== 'string')) {
      throw new Error('Each graph-edge attestation requires an edge ID and source memory ID list');
    }
    const edgeId = selection.edgeId.trim();
    const sourceMemoryIds = [...new Set(selection.sourceMemoryIds.map((id) => id.trim()).filter(Boolean))].sort();
    if (!edgeId || sourceMemoryIds.length === 0) throw new Error('Each graph-edge attestation requires an edge ID and at least one source memory ID');
    if (result.has(edgeId)) throw new Error(`Duplicate graph-edge attestation selection: ${edgeId}`);
    result.set(edgeId, sourceMemoryIds);
  }
  return result;
}

/** Dry-run-first, source-verified adoption of explicitly selected unsigned entity relations. */
export async function attestUnattributedEntityEdges(
  database: GraphEdgeAttestationDatabase,
  options: GraphEdgeAttestationOptions,
): Promise<GraphEdgeAttestationResult> {
  if (!options.actorId.trim()) throw new Error('Graph-edge attestation requires an explicit operator identity');
  const selections = validateSelections(options.selections);
  const candidates = readCandidates(database);
  const byId = new Map(candidates.map((entry) => [entry.candidate.edgeId, entry]));
  for (const edgeId of selections.keys()) {
    if (!byId.has(edgeId)) throw new Error(`Selected graph edge is not an unsigned, unattributed entity relation: ${edgeId}`);
  }

  const result: GraphEdgeAttestationResult = {
    candidates: candidates.map(({ candidate }) => candidate),
    selected: selections.size,
    attested: 0,
    dryRun: !options.apply,
  };
  if (!options.apply) return result;
  if (selections.size === 0) throw new Error('Apply mode requires an explicit graph-edge support map');

  if (!isStrictTrustPolicy()) throw new Error('Graph-edge attestation apply requires strict trust and a bound caller identity');
  const actorId = resolveTrustedCallerId(options.actorId);
  if (!actorId) throw new TrustBoundaryError('Graph-edge attestation requires an authenticated caller');
  if (database.inTransaction) throw new Error('Graph-edge attestation must own its SQLite transaction');

  database.exec('BEGIN IMMEDIATE');
  try {
    const locked = new Map(readCandidates(database).map((entry) => [entry.candidate.edgeId, entry]));
    const authorized: Array<{ entry: Candidate; metadata: Record<string, unknown> }> = [];
    let denied = false;
    for (const [edgeId, sourceMemoryIds] of selections) {
      const entry = locked.get(edgeId);
      if (!entry) throw new Error(`Graph edge ${edgeId} changed during attestation`);
      const context = entry.candidate.context;
      if (!context) throw new Error(`Graph edge ${edgeId} has no preserved relation context to attest`);
      const metadata = { ...(entry.edge.metadata ?? {}), sourceMemoryIds, context };
      const unsignedEdge = { ...entry.edge, metadata };
      const signature = signGraphRelationProvenance({
        fromId: unsignedEdge.fromId,
        fromKind: unsignedEdge.fromKind,
        toId: unsignedEdge.toId,
        toKind: unsignedEdge.toKind,
        edgeType: unsignedEdge.edgeType,
        weight: unsignedEdge.weight,
        metadata,
      });
      if (!signature) throw new Error('Graph-edge attestation requires configured provenance signing keys');
      const signedMetadata = { ...metadata, __squishGraphProvenance: signature };
      const signedEdge = { ...unsignedEdge, metadata: signedMetadata };
      const allowed = await filterStrictEntityEdges([signedEdge], new Map(), actorId);
      if (allowed.length !== 1) {
        denied = true;
        continue;
      }
      authorized.push({ entry, metadata: signedMetadata });
    }

    // No edge is changed unless every selected edge has authorized source evidence.
    if (denied) {
      database.exec('COMMIT');
      throw new TrustBoundaryError('Graph-edge attestation denied because a selected source is unreadable, inactive, unsigned, or does not support the relation');
    }

    const update = database.prepare('UPDATE knowledge_edges SET metadata = ? WHERE id = ? AND metadata IS ?');
    for (const item of authorized) {
      const changed = update.run(JSON.stringify(item.metadata), item.entry.edge.id, item.entry.metadataRaw);
      if (changed.changes !== 1) throw new Error(`Graph edge ${item.entry.edge.id} changed during attestation`);
      await writeTrustAudit({ actorId, resourceId: item.entry.edge.id, assetType: 'knowledge_edge', decision: 'allow', reason: 'owner_attestation' });
      result.attested++;
    }
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
