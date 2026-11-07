/**
 * Retrieval profile defaults. Explicit feature flags always take precedence;
 * profiles never select a remote provider or permit network egress.
 */

export type RetrievalProfileName = 'fast-local' | 'high-recall';

export interface RetrievalProfile {
  name: RetrievalProfileName;
  reranker: boolean;
  queryExpansion: boolean;
  contextualEnrichment: boolean;
  graphExpansion: boolean;
  source: 'environment' | 'default';
}

function parseProfile(raw: string | undefined): RetrievalProfileName {
  return raw?.trim().toLowerCase() === 'high-recall' ? 'high-recall' : 'fast-local';
}

export function getRetrievalProfile(env: NodeJS.ProcessEnv = process.env): RetrievalProfile {
  const name = parseProfile(env.SQUISH_PROFILE);
  const defaults = name === 'high-recall'
    ? { reranker: true, queryExpansion: true, contextualEnrichment: true, graphExpansion: true }
    : { reranker: false, queryExpansion: false, contextualEnrichment: false, graphExpansion: false };
  return {
    name,
    ...defaults,
    source: env.SQUISH_PROFILE ? 'environment' : 'default',
  };
}

export function resolveProfileFlag(
  explicit: string | undefined,
  profileDefault: boolean,
): { value: boolean; source: 'explicit' | 'profile' } {
  if (explicit !== undefined && explicit !== '') {
    const value = explicit.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(value)) return { value: true, source: 'explicit' };
    if (['false', '0', 'no', 'off'].includes(value)) return { value: false, source: 'explicit' };
  }
  return { value: profileDefault, source: 'profile' };
}

/** Effective offline retrieval settings with the source of each decision. */
export function getRetrievalDiagnostics(env: NodeJS.ProcessEnv = process.env) {
  const profile = getRetrievalProfile(env);
  return {
    profile: { name: profile.name, source: profile.source },
    features: {
      reranker: resolveProfileFlag(env.SQUISH_RERANKER_ENABLED, profile.reranker),
      queryExpansion: resolveProfileFlag(env.SQUISH_QUERY_EXPANSION, profile.queryExpansion),
      contextualEnrichment: resolveProfileFlag(env.SQUISH_CONTEXTUAL_RETRIEVAL, profile.contextualEnrichment),
      graphExpansion: resolveProfileFlag(env.SQUISH_GRAPH_EXPANSION, profile.graphExpansion),
    },
    egress: { controlledBy: 'provider configuration', enabledByProfile: false as const },
  };
}
