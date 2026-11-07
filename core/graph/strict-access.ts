import { and, gt, inArray, isNull, lte, or, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { isSourceBackedKnowledgeEdgeType, type KnowledgeEdge, type KnowledgeEdgeAsOf } from '../knowledge/types.js';
import { applyAclReadGate } from '../acl/read-gate.js';
import { resolveTrustedCallerId } from '../acl/trust-policy.js';
import { verifyGraphRelationProvenance, verifyMemoryProvenance } from '../acl/provenance.js';
import { writeTrustAudit } from '../acl/trust-audit.js';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { toKnowledgeEdge } from '../knowledge/helpers.js';

export type StrictGraphEdgeCache = Map<string, boolean>;

interface SourceMemoryRow {
  id: string;
  projectId: string | null;
  content: string;
  type: string;
  userId: string | null;
  teamId: string | null;
  status: string;
  isActive: boolean;
  expiresAt: Date | null;
  metadata: Record<string, unknown> | null;
}

type SourceMemoryDatabaseRow = Omit<SourceMemoryRow, 'metadata'> & { metadata: unknown };

interface StrictPremiseEdgeRow {
  id: string;
  fromId: string;
  fromKind: string;
  toId: string;
  toKind: string;
  edgeType: string;
  weight: number;
  metadata: unknown;
  createdAt: Date;
  validFrom: Date;
  validTo: Date | null;
  recordedAt: Date;
  recordedTo: Date | null;
}

interface EntityScopeRow {
  id: string;
  name: string;
  projectId: string | null;
}

interface KnowledgeSourceProjectionRow {
  id: string;
  content: string;
  projectId: string | null;
  knowledgeKind: string;
  knowledgeType: string;
  status: string;
  isActive: boolean;
  metadata: unknown;
}

function supportedMemoryIds(edge: KnowledgeEdge): string[] {
  const sources = edge.metadata?.sourceMemoryIds;
  if (!Array.isArray(sources) || sources.length === 0
    || sources.some((id) => typeof id !== 'string' || !id.trim())) return [];
  return [...new Set(sources as string[])];
}

function callerEdgeCacheKey(
  callerId: string,
  edgeId: string,
  validAt: number,
  recordedAt: number,
  allowDerivedProof: boolean,
  edgeFingerprint: string,
): string {
  return createHash('sha256').update(JSON.stringify([
    callerId, edgeId, validAt, recordedAt, allowDerivedProof, edgeFingerprint,
  ])).digest('hex');
}

function edgeAuthorizationFingerprint(edge: KnowledgeEdge): string {
  // A caller may reuse a request-local cache while evaluating multiple graph
  // candidates. Bind the decision to every edge field used by authorization;
  // an edge object with a reused ID but altered evidence must be revalidated.
  return createHash('sha256').update(JSON.stringify([
    edge.fromId,
    edge.fromKind,
    edge.toId,
    edge.toKind,
    edge.edgeType,
    edge.weight,
    edge.metadata,
    edge.createdAt?.getTime() ?? null,
    edge.validFrom?.getTime() ?? null,
    edge.validTo?.getTime() ?? null,
    edge.recordedAt?.getTime() ?? null,
    edge.recordedTo?.getTime() ?? null,
  ])).digest('hex');
}

function isEdgeValidAtSnapshot(edge: KnowledgeEdge, validAt: number, recordedAt: number): boolean {
  const edgeValidFrom = edge.validFrom?.getTime();
  const edgeRecordedAt = edge.recordedAt?.getTime();
  if (edgeValidFrom === undefined || edgeRecordedAt === undefined
    || !Number.isFinite(edgeValidFrom) || !Number.isFinite(edgeRecordedAt)
    || edgeValidFrom > validAt || edgeRecordedAt > recordedAt) return false;
  const edgeValidTo = edge.validTo?.getTime();
  const edgeRecordedTo = edge.recordedTo?.getTime();
  return (edgeValidTo === undefined || Number.isFinite(edgeValidTo) && edgeValidTo > validAt)
    && (edgeRecordedTo === undefined || Number.isFinite(edgeRecordedTo) && edgeRecordedTo > recordedAt);
}

function normalizeEvidence(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function findWholeEntityName(text: string, name: string): number {
  if (!text || !name) return -1;
  const wordCharacter = /^[\p{L}\p{N}_]$/u;
  const characters = Array.from(name);
  const needsLeftBoundary = wordCharacter.test(characters[0]!);
  const needsRightBoundary = wordCharacter.test(characters.at(-1)!);
  let index = text.indexOf(name);
  while (index >= 0) {
    const previous = index > 0 ? Array.from(text.slice(0, index)).at(-1) ?? '' : '';
    const nextIndex = index + name.length;
    const nextCodePoint = nextIndex < text.length ? String.fromCodePoint(text.codePointAt(nextIndex)!) : '';
    if ((!needsLeftBoundary || !wordCharacter.test(previous))
      && (!needsRightBoundary || !wordCharacter.test(nextCodePoint))) return index;
    index = text.indexOf(name, index + 1);
  }
  return -1;
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
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

/**
 * Authorize source-backed knowledge-to-knowledge relations. Both endpoint
 * projections must resolve to active source memories, all support memories
 * must pass the caller ACL in the same project, and the signed context must
 * occur in one of those source memories.
 */
export async function filterStrictKnowledgeEdges(
  edges: KnowledgeEdge[],
  cache: StrictGraphEdgeCache = new Map(),
  requestedCallerId?: string,
  asOf: KnowledgeEdgeAsOf = {},
): Promise<KnowledgeEdge[]> {
  const candidates = edges.filter((edge) => edge.fromKind === 'knowledge'
    && edge.toKind === 'knowledge' && isSourceBackedKnowledgeEdgeType(edge.edgeType));
  if (candidates.length === 0) return [];
  const callerId = resolveTrustedCallerId(requestedCallerId);
  if (!callerId) throw new Error('Strict graph access requires a bound caller');
  const validAtDate = asOf.validAt ?? new Date();
  const recordedAtDate = asOf.recordedAt ?? new Date();
  const validAt = validAtDate.getTime();
  const recordedAt = recordedAtDate.getTime();
  if (!Number.isFinite(validAt) || !Number.isFinite(recordedAt)) {
    throw new Error('Strict graph access requires valid temporal snapshot values');
  }

  const active: KnowledgeEdge[] = [];
  for (const edge of candidates) {
    if (isEdgeValidAtSnapshot(edge, validAt, recordedAt)) active.push(edge);
    else await writeTrustAudit({ actorId: callerId, resourceId: edge.id, assetType: 'knowledge_edge', decision: 'deny', reason: 'private_default' });
  }
  const cacheKeyFor = (edge: KnowledgeEdge) => callerEdgeCacheKey(
    callerId, edge.id, validAt, recordedAt, false, edgeAuthorizationFingerprint(edge),
  );
  const unresolved = active.filter((edge) => !cache.has(cacheKeyFor(edge)));
  if (unresolved.length > 0) {
    const db = await getDb();
    const schema = await getSchema();
    const sourceIds = new Set<string>();
    const signedSources = new Map<string, string[]>();
    const endpointIds = new Set<string>();
    const contexts = new Map<string, string>();

    for (const edge of unresolved) {
      const validSignature = verifyGraphRelationProvenance({
        fromId: edge.fromId, fromKind: edge.fromKind, toId: edge.toId, toKind: edge.toKind,
        edgeType: edge.edgeType, weight: edge.weight, metadata: edge.metadata,
      });
      const sources = supportedMemoryIds(edge);
      const context = typeof edge.metadata?.context === 'string' ? edge.metadata.context.trim() : '';
      if (!validSignature || sources.length < 2 || !context || context.length > 2_000
        || edge.metadata?.derivationProof !== undefined) {
        cache.set(cacheKeyFor(edge), false);
        await writeTrustAudit({ actorId: callerId, resourceId: edge.id, assetType: 'knowledge_edge', decision: 'deny', reason: validSignature ? 'private_default' : 'unsigned_legacy' });
        continue;
      }
      signedSources.set(edge.id, sources);
      contexts.set(edge.id, context);
      for (const sourceId of sources) sourceIds.add(sourceId);
      endpointIds.add(edge.fromId);
      endpointIds.add(edge.toId);
    }

    const allSourceIds = [...sourceIds];
    const sourceRows: SourceMemoryDatabaseRow[] = allSourceIds.length === 0 ? [] : await db.select({
      id: schema.memories.id,
      projectId: schema.memories.projectId,
      content: schema.memories.content,
      type: schema.memories.type,
      userId: schema.memories.userId,
      teamId: schema.memories.teamId,
      status: schema.memories.status,
      isActive: schema.memories.isActive,
      expiresAt: schema.memories.expiresAt,
      metadata: schema.memories.metadata,
    }).from(schema.memories).where(inArray(schema.memories.id, allSourceIds)) as SourceMemoryDatabaseRow[];
    const normalizedSources: SourceMemoryRow[] = sourceRows.map((row) => ({ ...row, metadata: parseMetadata(row.metadata) }));
    const readableSources = await applyAclReadGate<SourceMemoryRow>(normalizedSources, { userId: callerId }, () => 'memory');
    const readableById = new Map(readableSources.map((source) => [source.id, source]));
    const endpointRows: KnowledgeSourceProjectionRow[] = endpointIds.size === 0 ? [] : await db.select({
      id: schema.knowledge.id,
      content: schema.knowledge.content,
      projectId: schema.knowledge.projectId,
      knowledgeKind: schema.knowledge.knowledgeKind,
      knowledgeType: schema.knowledge.knowledgeType,
      status: schema.knowledge.status,
      isActive: schema.knowledge.isActive,
      metadata: schema.knowledge.metadata,
    }).from(schema.knowledge).where(inArray(schema.knowledge.id, [...endpointIds])) as KnowledgeSourceProjectionRow[];
    const endpointById = new Map(endpointRows.map((row) => [row.id, row]));

    for (const edge of unresolved) {
      if (cache.has(cacheKeyFor(edge))) continue;
      const sources = signedSources.get(edge.id);
      const context = contexts.get(edge.id);
      const fromProjection = endpointById.get(edge.fromId);
      const toProjection = endpointById.get(edge.toId);
      const fromMetadata = parseMetadata(fromProjection?.metadata);
      const toMetadata = parseMetadata(toProjection?.metadata);
      const fromSourceId = fromMetadata?.sourceMemoryId;
      const toSourceId = toMetadata?.sourceMemoryId;
      const validEndpoints = fromProjection?.knowledgeKind === 'memory' && fromProjection.isActive && fromProjection.status === 'active'
        && toProjection?.knowledgeKind === 'memory' && toProjection.isActive && toProjection.status === 'active'
        && typeof fromSourceId === 'string' && typeof toSourceId === 'string'
        && fromSourceId !== toSourceId && fromProjection.projectId === toProjection.projectId;
      let allowed = false;
      if (validEndpoints && fromProjection && toProjection && sources && context
        && sources.includes(fromSourceId as string) && sources.includes(toSourceId as string)) {
        const supported = sources.every((sourceId) => {
          const source = readableById.get(sourceId);
          return !!source && source.projectId === fromProjection.projectId;
        });
        const fromSource = readableById.get(fromSourceId as string);
        const toSource = readableById.get(toSourceId as string);
        const projectionsMatchSources = !!fromSource && !!toSource
          && fromProjection.content === fromSource.content && toProjection.content === toSource.content
          && verifyMemoryProvenance({
            content: fromProjection.content, projectId: fromProjection.projectId,
            type: fromProjection.knowledgeType, ownerId: fromSource.userId, teamId: fromSource.teamId,
            sourceMemoryId: fromSource.id, metadata: fromMetadata,
          })
          && verifyMemoryProvenance({
            content: toProjection.content, projectId: toProjection.projectId,
            type: toProjection.knowledgeType, ownerId: toSource.userId, teamId: toSource.teamId,
            sourceMemoryId: toSource.id, metadata: toMetadata,
          });
        const normalizedContext = normalizeEvidence(context);
        allowed = supported && projectionsMatchSources && !!normalizedContext && sources.some((sourceId) => {
          const source = readableById.get(sourceId);
          return !!source && normalizeEvidence(source.content).includes(normalizedContext);
        });
      }
      cache.set(cacheKeyFor(edge), allowed);
      await writeTrustAudit({ actorId: callerId, resourceId: edge.id, assetType: 'knowledge_edge', decision: allowed ? 'allow' : 'deny', reason: allowed ? 'acl_rule' : 'private_default' });
    }
  }
  return active.filter((edge) => cache.get(cacheKeyFor(edge)) === true);
}

const ENTITY_RELATION_CONTEXT_CUES: Readonly<Record<string, RegExp>> = {
  works_on: /\bworks?\s+on\b|\bworking\s+on\b/,
  depends_on: /\bdepends?\s+on\b|\bdependent\s+on\b|\brequires?\b|\brelies?\s+on\b/,
  manages: /\bmanages?\b|\bmanaged\b|\boversees?\b|\bsupervises?\b|\bcontrols?\b/,
  oversees: /\boversees?\b|\bsupervises?\b/,
  uses: /\buses?\b|\bused\b|\busing\b|\butili[sz]es?\b|\breli(?:es|ed)\s+on\b/,
  caused: /\bcaused?\b|\bled\s+to\b|\bresulted\s+in\b/,
  located_in: /\blocated\s+in\b|\bbased\s+in\b|\bsituated\s+in\b/,
  belongs_to: /\bbelongs?\s+to\b|\bmember\s+of\b/,
  reports_to: /\breports?\s+to\b|\breported\s+to\b/,
  occurred_on: /\boccurred\s+on\b|\bhappened\s+on\b|\btook\s+place\s+on\b/,
  affects: /\baffects?\b|\bimpacts?\b|\binfluences?\b/,
  contains: /\bcontains?\b|\bincludes?\b|\bcomprises?\b/,
  implements: /\bimplements?\b|\bimplemented\b|\bdeploys?\b/,
  extends: /\bextends?\b|\bextended\b|\bbuilds?\s+on\b|\bexpands?\s+on\b/,
  related_to: /\brelated\s+to\b|\bassociated\s+with\b|\bconnected\s+to\b/,
  part_of: /\bpart\s+of\b|\bcomponent\s+of\b/,
  owns: /\bowns?\b|\bowned\s+by\b/,
  created: /\bcreates?\b|\bcreated\b|\bauthored\b|\bproduced\b/,
  resolved: /\bresolves?\b|\bresolved\b|\bfixed\b/,
  blocks: /\bblocks?\b|\bblocked\b|\bprevents?\b/,
  cites: /\bcites?\b|\bcited\b|\bcitation\s+to\b|\breferences?\b/,
  references: /\breferences?\b/,
  party_to: /\bparty\s+to\b|\bparty\s+in\b|\bsignator(?:y|ies)\s+to\b|\bsigned\s+by\b/,
  version_of: /\bversion\s+of\b|\brevision\s+of\b|\bdraft\s+of\b/,
  supersedes_version: /\bsupersedes?\b|\bsuperseded\b|\breplaces?\b|\breplaced\b|\breplacement\s+for\b/,
  has_status: /\bstatus\s+(?:is|was|:)|\b(?:is|was|remains?|became)\s+(?:draft|executed|filed|active|inactive)\b|\b(?:has|have|had)\s+been\s+(?:drafted|executed|filed|activated|deactivated)\b/,
  dated_on: /\bdated\s+on\b|\bdated\s+\w+\s+\d{1,2},?\s+20\d{2}\b|\bdated\s+20\d{2}-\d{2}-\d{2}\b/,
  operates_in: /\boperates?\s+in\b|\bruns?\s+in\b|\bfunctions?\s+in\b/,
};

const ENTITY_RELATION_REVERSED_CUES: Readonly<Record<string, RegExp>> = {
  manages: /\bmanaged\s+by\b/,
  owns: /\bowned\s+by\b/,
  created: /\b(?:created|authored|produced)\s+by\b/,
  resolved: /\b(?:resolved|fixed)\s+by\b/,
  blocks: /\b(?:blocked|prevented)\s+by\b/,
  cites: /\b(?:cited|referenced)\s+by\b/,
  party_to: /\bsigned\s+by\b/,
  supersedes_version: /\b(?:replaced|superseded)\s+by\b/,
};

function sourceSupportsRelationContext(
  edge: KnowledgeEdge,
  fromName: string,
  toName: string,
  sourceContents: string[],
): boolean {
  const context = typeof edge.metadata?.context === 'string' ? normalizeEvidence(edge.metadata.context) : '';
  const from = normalizeEvidence(fromName);
  const to = normalizeEvidence(toName);
  if (!from || !to) return false;
  if (edge.edgeType === 'co_occurs_with') {
    return sourceContents.some((content) => findWholeEntityName(content, from) >= 0 && findWholeEntityName(content, to) >= 0);
  }
  if (edge.edgeType === 'mentioned_together') {
    return sourceContents.some((content) => content.split(/[.!?]+/)
      .some((sentence) => findWholeEntityName(sentence, from) >= 0 && findWholeEntityName(sentence, to) >= 0));
  }
  if (edge.edgeType === 'mentioned_before') {
    return sourceContents.some((content) => {
      const fromIndex = findWholeEntityName(content, from);
      const toIndex = findWholeEntityName(content, to);
      return fromIndex >= 0 && toIndex > fromIndex;
    });
  }
  const relationCue = ENTITY_RELATION_CONTEXT_CUES[edge.edgeType];
  if (!context || findWholeEntityName(context, from) < 0 || findWholeEntityName(context, to) < 0 || !relationCue) return false;
  // A matching name and verb elsewhere in a multi-sentence excerpt do not
  // establish a relation between those entities. Require both endpoints and
  // the cue in the same clause before treating the signed excerpt as support.
  const relationClause = context.split(/[.!?;]+/)
    .map((clause) => clause.trim())
    .find((clause) => findWholeEntityName(clause, from) >= 0
      && findWholeEntityName(clause, to) >= 0 && relationCue.test(clause));
  const cueMatch = relationClause ? relationCue.exec(relationClause) : null;
  if (!relationClause || !cueMatch || context.includes('?')
    || /\b(?:might|may|could|possibly|perhaps|allegedly|uncertain)\b/.test(context)) return false;
  const fromIndex = findWholeEntityName(relationClause, from);
  const toIndex = findWholeEntityName(relationClause, to);
  const reversedCue = ENTITY_RELATION_REVERSED_CUES[edge.edgeType];
  const reversed = !!reversedCue?.test(relationClause);
  const relationDirectionMatches = reversed
    ? toIndex < cueMatch.index && cueMatch.index < fromIndex
    : fromIndex < cueMatch.index && cueMatch.index < toIndex;
  if (!relationDirectionMatches) return false;
  const clauseStart = Math.max(
    relationClause.lastIndexOf('.', cueMatch.index - 1),
    relationClause.lastIndexOf('!', cueMatch.index - 1),
    relationClause.lastIndexOf('?', cueMatch.index - 1),
  );
  const beforeCue = relationClause.slice(clauseStart + 1, cueMatch.index);
  if (/\b(?:not|never|does not|doesn't|did not|didn't|do not|don't|cannot|can't|no longer|without|fails? to)\b/.test(beforeCue)) {
    return false;
  }
  const afterCue = relationClause.slice(cueMatch.index + cueMatch[0].length);
  // A source clause can state a relation and immediately retract or deny it
  // (for example, "A manages B, but does not manage B"). Treat post-cue
  // negation as ambiguous and fail closed rather than signing the first verb.
  if (/\b(?:not|never|no longer|doesn't|didn't|isn't|aren't|wasn't|weren't|cannot|can't|without|reversed|withdrawn)\b/i.test(afterCue)) {
    return false;
  }
  return sourceContents.some((content) => content.includes(context));
}

/** Return only signed entity edges whose complete source set is visible to the bound caller. */
export async function filterStrictEntityEdges(
  edges: KnowledgeEdge[],
  cache: StrictGraphEdgeCache = new Map(),
  requestedCallerId?: string,
  allowDerivedProof = true,
  proofAsOf: KnowledgeEdgeAsOf = {},
): Promise<KnowledgeEdge[]> {
  const entityEdges = edges.filter((edge) => edge.fromKind === 'entity' && edge.toKind === 'entity');
  if (entityEdges.length === 0) return [];
  const callerId = resolveTrustedCallerId(requestedCallerId);
  if (!callerId) throw new Error('Strict graph access requires a bound caller identity');

  const validAtDate = proofAsOf.validAt ?? new Date();
  const recordedAtDate = proofAsOf.recordedAt ?? new Date();
  const validAt = validAtDate.getTime();
  const recordedAt = recordedAtDate.getTime();
  if (!Number.isFinite(validAt) || !Number.isFinite(recordedAt)) {
    throw new Error('Strict graph access requires valid temporal snapshot values');
  }
  const candidates: KnowledgeEdge[] = [];
  const inactiveEdges: KnowledgeEdge[] = [];
  for (const edge of entityEdges) {
    if (isEdgeValidAtSnapshot(edge, validAt, recordedAt)) {
      candidates.push(edge);
      continue;
    }
    inactiveEdges.push(edge);
  }
  for (const edge of inactiveEdges) {
    await writeTrustAudit({
      actorId: callerId,
      resourceId: edge.id,
      assetType: 'knowledge_edge',
      decision: 'deny',
      reason: 'private_default',
    });
  }
  if (candidates.length === 0) return [];

  const cacheKeyFor = (edge: KnowledgeEdge) => callerEdgeCacheKey(
    callerId, edge.id, validAt, recordedAt, allowDerivedProof, edgeAuthorizationFingerprint(edge),
  );
  const unresolved = candidates.filter((edge) => !cache.has(cacheKeyFor(edge)));
  if (unresolved.length > 0) {
    const db = await getDb();
    const schema = await getSchema();
    const signed = new Map<string, string[]>();
    const allSourceIds = new Set<string>();

    const derivedCandidates: KnowledgeEdge[] = [];
    for (const edge of unresolved) {
      const validSignature = verifyGraphRelationProvenance({
        fromId: edge.fromId,
        fromKind: edge.fromKind,
        toId: edge.toId,
        toKind: edge.toKind,
        edgeType: edge.edgeType,
        weight: edge.weight,
        metadata: edge.metadata,
      });
      const sources = supportedMemoryIds(edge);
      if (!validSignature || sources.length === 0) {
        await writeTrustAudit({
          actorId: callerId,
          resourceId: edge.id,
          assetType: 'knowledge_edge',
          decision: 'deny',
          reason: validSignature ? 'unsigned_legacy' : edge.metadata?.__squishGraphProvenance ? 'invalid_signature' : 'unsigned_legacy',
        });
        cache.set(cacheKeyFor(edge), false);
        continue;
      }
      signed.set(edge.id, sources);
      for (const id of sources) allSourceIds.add(id);
      if (edge.metadata?.derivationProof !== undefined) derivedCandidates.push(edge);
    }

    const sourceIds = [...allSourceIds];
    const sourceRows: SourceMemoryDatabaseRow[] = sourceIds.length === 0
      ? []
      : await db.select({
        id: schema.memories.id,
        projectId: schema.memories.projectId,
        content: schema.memories.content,
        type: schema.memories.type,
        userId: schema.memories.userId,
        teamId: schema.memories.teamId,
        status: schema.memories.status,
        isActive: schema.memories.isActive,
        expiresAt: schema.memories.expiresAt,
        metadata: schema.memories.metadata,
      }).from(schema.memories).where(inArray(schema.memories.id, sourceIds)) as SourceMemoryDatabaseRow[];
    const normalizedSourceRows: SourceMemoryRow[] = sourceRows.map((row) => ({ ...row, metadata: parseMetadata(row.metadata) }));
    const readableRows = await applyAclReadGate<SourceMemoryRow>(normalizedSourceRows, { userId: callerId }, () => 'memory');
    const readableById = new Map(readableRows.map((row) => [row.id, row]));
    const endpoints = [...new Set(unresolved.flatMap((edge) => [edge.fromId, edge.toId]))];
    const entityRows: EntityScopeRow[] = endpoints.length === 0
      ? []
      : await db.select({
        id: schema.entities.id,
        name: schema.entities.name,
        projectId: schema.entities.projectId,
      }).from(schema.entities).where(inArray(schema.entities.id, endpoints)) as EntityScopeRow[];
    const entityById = new Map(entityRows.map((entity) => [entity.id, entity]));

    const derivedPremises = new Map<string, { from: KnowledgeEdge; to: KnowledgeEdge }>();
    if (allowDerivedProof) {
      for (const edge of derivedCandidates) {
        const proof = edge.metadata?.derivationProof;
        if (!proof || typeof proof !== 'object' || Array.isArray(proof)) continue;
        const candidateProof = proof as Record<string, unknown>;
        if (candidateProof.version !== 1 || typeof candidateProof.fromPremiseEdgeId !== 'string'
          || typeof candidateProof.toPremiseEdgeId !== 'string' || typeof candidateProof.middleEntityId !== 'string'
          || typeof candidateProof.fromRelationType !== 'string' || typeof candidateProof.toRelationType !== 'string') continue;
        const endpointIds = [...new Set([edge.fromId, edge.toId])];
        const validAt = proofAsOf.validAt ?? new Date();
        const recordedAt = proofAsOf.recordedAt ?? new Date();
        const connectedRows = await db.select().from(schema.knowledgeEdges).where(and(
          eq(schema.knowledgeEdges.fromKind, 'entity'),
          eq(schema.knowledgeEdges.toKind, 'entity'),
          or(inArray(schema.knowledgeEdges.fromId, endpointIds), inArray(schema.knowledgeEdges.toId, endpointIds)),
          lte(schema.knowledgeEdges.validFrom, validAt),
          or(isNull(schema.knowledgeEdges.validTo), gt(schema.knowledgeEdges.validTo, validAt)),
          lte(schema.knowledgeEdges.recordedAt, recordedAt),
          or(isNull(schema.knowledgeEdges.recordedTo), gt(schema.knowledgeEdges.recordedTo, recordedAt)),
        )) as StrictPremiseEdgeRow[];
        const connected = connectedRows.map((row) => toKnowledgeEdge({
          id: row.id, from_id: row.fromId, from_kind: row.fromKind,
          to_id: row.toId, to_kind: row.toKind, edge_type: row.edgeType,
          weight: row.weight, metadata: row.metadata, created_at: row.createdAt,
          valid_from: row.validFrom, valid_to: row.validTo,
          recorded_at: row.recordedAt, recorded_to: row.recordedTo,
        }));
        const from = connected.find((candidate) => candidate.id === candidateProof.fromPremiseEdgeId);
        const to = connected.find((candidate) => candidate.id === candidateProof.toPremiseEdgeId);
        if (!from || !to || from.id === to.id || from.metadata?.derivationProof !== undefined
          || to.metadata?.derivationProof !== undefined
          || from.fromId !== edge.fromId || from.toId !== candidateProof.middleEntityId
          || to.fromId !== candidateProof.middleEntityId || to.toId !== edge.toId
          || from.edgeType !== candidateProof.fromRelationType || to.edgeType !== candidateProof.toRelationType) continue;
        const validRule = candidateProof.rule === 'works_on_uses_depends_on'
          && from.edgeType === 'works_on' && to.edgeType === 'uses' && edge.edgeType === 'depends_on'
          || candidateProof.rule === 'manages_works_oversees'
            && from.edgeType === 'manages' && to.edgeType === 'works_on' && edge.edgeType === 'oversees'
          || candidateProof.rule === 'caused_affects_may_affect'
            && from.edgeType === 'caused' && to.edgeType === 'affects' && edge.edgeType === 'may_affect'
          || candidateProof.rule === 'part_of_contains'
            && from.edgeType === 'part_of' && to.edgeType === 'contains' && edge.edgeType === 'related_to'
          || candidateProof.rule === 'uses_depends_on'
            && from.edgeType === 'uses' && to.edgeType === 'depends_on' && edge.edgeType === 'depends_on'
          || candidateProof.rule === 'created_resolved'
            && from.edgeType === 'created' && to.edgeType === 'resolved' && edge.edgeType === 'related_to'
          || candidateProof.rule === 'blocks_depends_on'
            && from.edgeType === 'blocks' && to.edgeType === 'depends_on' && edge.edgeType === 'blocks';
        if (validRule) derivedPremises.set(edge.id, { from, to });
      }
      const premises = [...derivedPremises.values()].flatMap(({ from, to }) => [from, to]);
      const readablePremiseIds = new Set((await filterStrictEntityEdges(premises, cache, callerId, false, proofAsOf)).map((edge) => edge.id));
      for (const edge of derivedCandidates) {
        const pair = derivedPremises.get(edge.id);
        if (!pair || !readablePremiseIds.has(pair.from.id) || !readablePremiseIds.has(pair.to.id)) continue;
        const premiseSources = [...new Set([
          ...supportedMemoryIds(pair.from),
          ...supportedMemoryIds(pair.to),
        ])].sort();
        const outputSources = (signed.get(edge.id) ?? []).slice().sort();
        if (premiseSources.length === outputSources.length
          && premiseSources.every((sourceId, index) => sourceId === outputSources[index])) {
          cache.set(cacheKeyFor(edge), true);
          await writeTrustAudit({
            actorId: callerId,
            resourceId: edge.id,
            assetType: 'knowledge_edge',
            decision: 'allow',
            reason: 'acl_rule',
          });
        }
      }
    }

    for (const edge of unresolved) {
      if (cache.has(cacheKeyFor(edge))) continue;
      const sources = signed.get(edge.id);
      if (!sources) continue;
      if (edge.metadata?.derivationProof !== undefined) {
        cache.set(cacheKeyFor(edge), false);
        await writeTrustAudit({
          actorId: callerId,
          resourceId: edge.id,
          assetType: 'knowledge_edge',
          decision: 'deny',
          reason: 'private_default',
        });
        continue;
      }
      const from = entityById.get(edge.fromId);
      const to = entityById.get(edge.toId);
      let allowed = false;
      if (from && to && from.projectId === to.projectId) {
        const sourceContents = sources.map((id) => readableById.get(id))
          .filter((memory): memory is SourceMemoryRow => Boolean(memory && memory.projectId === from.projectId))
          .map((memory) => normalizeEvidence(memory.content));
        const sourceNamesSupported = sources.every((id) => {
          const memory = readableById.get(id);
          if (!memory || memory.projectId !== from.projectId) return false;
          const content = normalizeEvidence(memory.content);
          const fromName = normalizeEvidence(from.name);
          const toName = normalizeEvidence(to.name);
          return !!fromName && !!toName && findWholeEntityName(content, fromName) >= 0
            && findWholeEntityName(content, toName) >= 0;
        });
        const contextSupported = sourceSupportsRelationContext(edge, from.name, to.name, sourceContents);
        allowed = sourceNamesSupported && contextSupported;
      }
      cache.set(cacheKeyFor(edge), allowed);
      await writeTrustAudit({
        actorId: callerId,
        resourceId: edge.id,
        assetType: 'knowledge_edge',
        decision: allowed ? 'allow' : 'deny',
        reason: allowed ? 'acl_rule' : 'private_default',
      });
    }
  }

  return candidates.filter((edge) => cache.get(cacheKeyFor(edge)) === true);
}
