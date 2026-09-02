/**
 * Entity-Aware Retrieval Module
 *
 * Boosts memories that mention the same entities as the query.
 * Extracts entities from queries (PascalCase, camelCase, file paths, function names)
 * and applies boost scoring to matching results.
 */
import type { SearchResult } from '../memory/memories.js';
export interface EntityConfig {
    enabled: boolean;
}
/**
 * Extract entities from query string
 *
 * Extracts:
 * - PascalCase names (ButtonComponent, UserService)
 * - camelCase names (getUserData, fetchData)
 * - File paths (src/components/Button.tsx)
 * - Function calls (getUserData())
 * - Common tools/frameworks (React, Vue, etc.)
 * - Person names with context words (Michiel said, John worked)
 * - Company names with suffixes (Acme Inc, Google LLC)
 * - Quoted project names ("Project Atlas")
 *
 * @param query - The search query
 * @returns Array of extracted entity names
 */
export declare function extractQueryEntities(query: string): string[];
/**
 * Boost search results based on entity overlap with query
 *
 * @param results - Original search results
 * @param queryEntities - Entities extracted from the query
 * @returns Results with boosted similarity scores
 */
export declare function entityBoost(results: SearchResult[], queryEntities: string[]): SearchResult[];
//# sourceMappingURL=entity-aware-retrieval.d.ts.map