/**
 * Query Processor - Phase 4
 * Expands queries for better retrieval coverage.
 *
 * Delegates expansion to the canonical implementation in
 * `core/retrieval/query-expansion.ts` to avoid duplicate synonym maps.
 */

import { expandQuery as expandQueryRetrieval } from '../retrieval/query-expansion.js';

export interface ProcessedQuery {
  original: string;
  expanded: string[];
  entities: string[];
  synonyms: Map<string, string[]>;
}

// Common tech stack terms used for entity extraction
const TECH_TERMS = new Set([
  'TypeScript', 'JavaScript', 'Python', 'Java', 'Go', 'Rust', 'Ruby', 'PHP',
  'React', 'Vue', 'Angular', 'Svelte', 'Next', 'Nuxt', 'Astro',
  'Node', 'Express', 'Fastify', 'Deno', 'Bun',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'SQLite', 'DynamoDB',
  'AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'Terraform',
  'OpenAI', 'Anthropic', 'Google', 'Meta', 'Microsoft', 'Apple',
  'HTML', 'CSS', 'Tailwind', 'GraphQL', 'REST', 'gRPC', 'WebSocket',
  'CI', 'CD', 'Git', 'GitHub', 'GitLab', 'Bitbucket',
]);

// Stop words for entity extraction (capitalized forms)
const ENTITY_STOP_WORDS = new Set([
  'The', 'A', 'An', 'This', 'That', 'These', 'Those',
  'I', 'You', 'We', 'They', 'He', 'She', 'It',
  'What', 'When', 'Where', 'Why', 'How',
  'My', 'Your', 'Our', 'Their', 'Its',
  'If', 'But', 'Or', 'And', 'So', 'Then',
  'Just', 'Only', 'Also', 'Very', 'Too',
  'Has', 'Have', 'Had', 'Does', 'Did', 'Will', 'Would', 'Could', 'Should',
  'Can', 'May', 'Might', 'Must', 'Shall',
  'With', 'Without', 'From', 'Into', 'About', 'After', 'Before', 'Between',
  'During', 'Through', 'Under', 'Over', 'Above', 'Below',
  'All', 'Some', 'Any', 'No', 'Not', 'Each', 'Every', 'Most', 'Many', 'Much',
  'Few', 'Both', 'Either', 'Neither', 'Another', 'Other',
  'Such', 'Same', 'Different', 'New', 'Old', 'First', 'Last', 'Next',
  'See', 'Get', 'Make', 'Do', 'Say', 'Tell', 'Know', 'Think', 'Want', 'Use',
  'Find', 'Give', 'Take', 'Show', 'Send', 'Put', 'Keep', 'Let', 'Begin', 'Seem',
]);

/**
 * Expand query for better retrieval coverage.
 * Delegates synonym expansion to `retrieval/query-expansion.ts` and adds
 * entity extraction and a synonym map for backward compatibility.
 */
export function expandQueryWithEntities(query: string): ProcessedQuery {
  const synonyms = new Map<string, string[]>();

  // Use the canonical retrieval expansion for the expanded query list
  const expanded = expandQueryRetrieval(query, { enabled: true, maxExpansions: 10 });

  // Extract entities (capitalized words), filtering common stopwords
  const entityMatches = query.match(/\b[A-Z][a-z]{2,}\b/g) || [];
  const entities = [...new Set(entityMatches)].filter(e => {
    if (TECH_TERMS.has(e)) return true;
    return !ENTITY_STOP_WORDS.has(e);
  });

  return {
    original: query,
    expanded,
    entities,
    synonyms,
  };
}

/**
 * Multi-query search combiner
 * Searches with multiple query variants and merges results
 */
export async function multiQuerySearch<T>(
  queries: string[],
  searchFn: (query: string) => Promise<T[]>,
  dedupeKey: (item: T) => string
): Promise<T[]> {
  const allResults: T[] = [];
  
  // Search with each query variant
  for (const query of queries) {
    const results = await searchFn(query);
    allResults.push(...results);
  }
  
  // Deduplicate by key
  const seen = new Set<string>();
  const unique: T[] = [];
  
  for (const item of allResults) {
    const key = dedupeKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  
  return unique;
}
