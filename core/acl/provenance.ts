import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export interface ProvenanceEnvelope {
  version: 1 | 2 | 3;
  keyId: string;
  signature: string;
}

export interface ProvenanceRecord {
  content: string;
  projectId?: string | null;
  type: string;
  ownerId?: string | null;
  teamId?: string | null;
  sourceMemoryId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface SignedBeliefProjection extends ProvenanceRecord {
  confidence: number;
  status: string;
  reason?: string | null;
  evidenceSummary?: string | null;
}

export interface GraphRelationRecord {
  fromId: string;
  fromKind: string;
  toId: string;
  toKind: string;
  edgeType: string;
  weight: number;
  metadata: Record<string, unknown> | null;
}

export interface GraphRelationProvenanceEnvelope {
  version: 1;
  keyId: string;
  signature: string;
}

const EVIDENCE_CONTEXT_KEYS = [
  'sourceId', 'observedAt', 'reasoning', 'memoryContext', 'examples', 'exceptions', 'procedureOutcome', 'promotionSourceId', 'derivation', 'hostTranscript',
] as const;

/** Return only metadata fields authenticated by the memory provenance envelope. */
export function signedEvidenceContext(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const evidenceContext: Record<string, unknown> = {};
  for (const key of EVIDENCE_CONTEXT_KEYS) {
    if (metadata && Object.hasOwn(metadata, key)) evidenceContext[key] = metadata[key];
  }
  return evidenceContext;
}

function canonical(record: ProvenanceRecord, version: 1 | 2 | 3): Buffer {
  const fields: Record<string, unknown> = {
    version: 1,
    content: record.content,
    projectId: record.projectId ?? null,
    type: record.type,
  };
  if (version >= 2) {
    fields.evidenceContext = signedEvidenceContext(record.metadata);
  }
  if (version === 3) {
    fields.ownerId = record.ownerId ?? null;
    fields.teamId = record.teamId ?? null;
    fields.sourceMemoryId = record.sourceMemoryId ?? null;
  }
  return Buffer.from(JSON.stringify(fields), 'utf8');
}

function pem(value: string | undefined): string | undefined {
  return value?.replace(/\\n/g, '\n');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== '__squishGraphProvenance')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function graphRelationCanonical(record: GraphRelationRecord): Buffer {
  return Buffer.from(JSON.stringify({
    fromId: record.fromId,
    fromKind: record.fromKind,
    toId: record.toId,
    toKind: record.toKind,
    edgeType: record.edgeType,
    weight: record.weight,
    metadata: stableValue(record.metadata),
  }), 'utf8');
}

/** Sign graph relations only when they have explicit source-memory support. */
export function signGraphRelationProvenance(
  record: GraphRelationRecord,
  env: NodeJS.ProcessEnv = process.env,
): GraphRelationProvenanceEnvelope | null {
  const supports = record.metadata?.sourceMemoryIds;
  if (!Array.isArray(supports) || supports.length === 0
    || supports.some((id) => typeof id !== 'string' || !id.trim())) return null;
  const privatePem = pem(env.SQUISH_PROVENANCE_PRIVATE_KEY);
  if (!privatePem) return null;
  const keyId = env.SQUISH_PROVENANCE_KEY_ID?.trim();
  if (!keyId) throw new Error('SQUISH_PROVENANCE_KEY_ID is required with the provenance private key');
  return { version: 1, keyId, signature: sign(null, graphRelationCanonical(record), createPrivateKey(privatePem)).toString('base64') };
}

/** Verify the complete signed relation payload, including support IDs and derived context. */
export function verifyGraphRelationProvenance(
  record: GraphRelationRecord,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const envelope = record.metadata?.__squishGraphProvenance as Partial<GraphRelationProvenanceEnvelope> | undefined;
  if (envelope?.version !== 1 || !envelope.keyId || !envelope.signature) return false;
  let publicPem: string | undefined;
  if (env.SQUISH_PROVENANCE_PUBLIC_KEYS) {
    try {
      publicPem = (JSON.parse(env.SQUISH_PROVENANCE_PUBLIC_KEYS) as Record<string, string>)[envelope.keyId];
    } catch {
      return false;
    }
    if (!publicPem) return false;
  } else if (env.SQUISH_PROVENANCE_KEY_ID === envelope.keyId) {
    publicPem = pem(env.SQUISH_PROVENANCE_PUBLIC_KEY);
    if (!publicPem && env.SQUISH_PROVENANCE_PRIVATE_KEY) {
      try { publicPem = createPublicKey(createPrivateKey(pem(env.SQUISH_PROVENANCE_PRIVATE_KEY)!)).export({ type: 'spki', format: 'pem' }).toString(); }
      catch { return false; }
    }
  }
  if (!publicPem) return false;
  try {
    return verify(null, graphRelationCanonical(record), createPublicKey(pem(publicPem)!), Buffer.from(envelope.signature, 'base64'));
  } catch {
    return false;
  }
}

export function signMemoryProvenance(
  record: ProvenanceRecord,
  env: NodeJS.ProcessEnv = process.env,
): ProvenanceEnvelope | null {
  const privatePem = pem(env.SQUISH_PROVENANCE_PRIVATE_KEY);
  if (!privatePem) return null;
  const keyId = env.SQUISH_PROVENANCE_KEY_ID?.trim();
  if (!keyId) throw new Error('SQUISH_PROVENANCE_KEY_ID is required with the provenance private key');
  const hasScope = Object.hasOwn(record, 'ownerId') || Object.hasOwn(record, 'teamId');
  const version: 1 | 2 | 3 = hasScope ? 3 : record.metadata ? 2 : 1;
  const signature = sign(null, canonical(record, version), createPrivateKey(privatePem)).toString('base64');
  return { version, keyId, signature };
}

export function verifyMemoryProvenance(
  record: ProvenanceRecord,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const envelope = record.metadata?.__squishProvenance as Partial<ProvenanceEnvelope> | undefined;
  if ((envelope?.version !== 1 && envelope?.version !== 2 && envelope?.version !== 3) || !envelope.keyId || !envelope.signature) return false;

  let publicPem: string | undefined;
  const keySetRaw = env.SQUISH_PROVENANCE_PUBLIC_KEYS;
  if (keySetRaw) {
    try {
      const keySet = JSON.parse(keySetRaw) as Record<string, string>;
      publicPem = keySet[envelope.keyId];
    } catch {
      return false;
    }
    if (!publicPem) return false;
  } else if (env.SQUISH_PROVENANCE_KEY_ID === envelope.keyId) {
    publicPem = pem(env.SQUISH_PROVENANCE_PUBLIC_KEY);
    if (!publicPem && env.SQUISH_PROVENANCE_PRIVATE_KEY) {
      try { publicPem = createPublicKey(createPrivateKey(pem(env.SQUISH_PROVENANCE_PRIVATE_KEY)!)).export({ type: 'spki', format: 'pem' }).toString(); }
      catch { return false; }
    }
  }
  if (!publicPem) return false;
  try {
    return verify(null, canonical(record, envelope.version), createPublicKey(pem(publicPem)!), Buffer.from(envelope.signature, 'base64'));
  } catch {
    return false;
  }
}

/** Ensure mutable retrieval fields still equal the source-signed derivation payload. */
export function verifySignedBeliefProjection(record: SignedBeliefProjection): boolean {
  const derivation = record.metadata?.derivation;
  if (!derivation || typeof derivation !== 'object' || Array.isArray(derivation)) return false;
  const fields = derivation as Record<string, unknown>;
  return fields.kind === 'extracted_belief'
    && fields.beliefType === record.type
    && fields.confidence === record.confidence
    && fields.status === record.status
    && (fields.reason ?? null) === (record.reason ?? null)
    && (fields.evidenceSummary ?? null) === (record.evidenceSummary ?? null)
    && verifyMemoryProvenance(record);
}
