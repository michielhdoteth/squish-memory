import { createHash } from 'node:crypto';

export interface RetrievalAuditResult {
  id: string | null;
  preFusionSemanticScore: number | null;
  postFusionSemanticScore: number | null;
  servedScore: number | null;
  finalScore: number | null;
  lexicalRank: number | null;
  lexicalScore: number | null;
  recallConfidence: number | null;
}

export interface RetrievalAuditQuery {
  id: string;
  category: string;
  query: string;
  mustHit: string[];
  mayHit: string[];
  results: RetrievalAuditResult[];
}

export interface RetrievalAuditInput {
  gitSha: string | null;
  datasetSha256: string;
  sourceHashes: Record<string, string>;
  config: Record<string, string | number | boolean | null>;
  queries: RetrievalAuditQuery[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Build a stable artifact containing identifiers and numeric evidence only. */
export function buildRetrievalAuditArtifact(input: RetrievalAuditInput) {
  const queries = input.queries.map((query) => ({
    id: query.id,
    category: query.category,
    querySha256: sha256(query.query),
    mustHit: [...query.mustHit],
    mayHit: [...query.mayHit],
    results: query.results.map((result) => ({
      id: result.id,
      relevance: result.id && query.mustHit.includes(result.id)
        ? 'must-hit' as const
        : result.id && query.mayHit.includes(result.id) ? 'may-hit' as const : 'other' as const,
      preFusionSemanticScore: finiteOrNull(result.preFusionSemanticScore),
      postFusionSemanticScore: finiteOrNull(result.postFusionSemanticScore),
      servedScore: finiteOrNull(result.servedScore),
      finalScore: finiteOrNull(result.finalScore),
      lexicalRank: finiteOrNull(result.lexicalRank),
      lexicalScore: finiteOrNull(result.lexicalScore),
      recallConfidence: finiteOrNull(result.recallConfidence),
    })),
  }));

  const configJson = JSON.stringify(input.config, Object.keys(input.config).sort());
  return {
    schemaVersion: 1,
    meta: {
      gitSha: input.gitSha,
      datasetSha256: input.datasetSha256,
      sourceHashes: input.sourceHashes,
      configSha256: sha256(configJson),
      config: input.config,
      queryCount: queries.length,
      privacy: 'No query text, memory text, or user-provided metadata; query hashes and fixture identifiers only.',
    },
    queries,
  };
}
