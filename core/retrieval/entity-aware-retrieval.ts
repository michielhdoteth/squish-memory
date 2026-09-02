/**
 * Entity-Aware Retrieval Module
 * 
 * Boosts memories that mention the same entities as the query.
 * Extracts entities from queries (PascalCase, camelCase, file paths, function names)
 * and applies boost scoring to matching results.
 */

import type { SearchResult } from '../memory/memories.js';
import { addBoost } from '../scoring/three-field.js';

export interface EntityConfig {
  enabled: boolean;
}

/**
 * Regex patterns for entity extraction
 */
const ENTITY_PATTERNS = {
  // PascalCase: ButtonComponent, UserService, DatabaseConnection
  pascalCase: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,
  
  // camelCase: getUserData, fetchData, handleEvent
  camelCase: /\b[a-z]+(?:[A-Z][a-z]+)+\b/g,
  
  // File paths with extensions: src/components/Button.tsx, utils/helpers.js
  filePath: /(?:\.?\/)?[\w.-]+(?:\/[\w.-]+)*\.\w{1,5}/g,
  
  // Function calls: getUserData(), fetchData()
  functionCall: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(\)/g,
  
  // Common tools/frameworks: React, Vue, Angular, Node.js, etc.
  tools: /\b(?:React|Vue|Angular|Node\.?js?|Express|Django|Flask|FastAPI|PostgreSQL|MongoDB|Redis|Docker|Kubernetes|TypeScript|JavaScript|Python|Bun|npm|yarn|pnpm)\b/g,
  
  // Version numbers: v1.0, version 2.3.1
  versions: /\b[vV]?(?:ersion\s+)?\d+\.\d+(?:\.\d+)?\b/g,

  // Person names with context words (said, mentioned, told, worked, managed, led)
  // Matches: "Michiel said", "John mentioned", "Sarah told me", "Alex worked on", "Maria managed the", "Tom led the"
  personName: /\b(?:[A-Z][a-z]{1,20})\s+(?:said|mentioned|told|worked|managed|led|is|was|are|were|has|had|did|does|thinks|believes|wants|needs|asked|told|replied|responded|suggested|recommended|decided|agreed|disagreed|wrote|created|built|designed|implemented|developed|reviewed|tested|deployed|fixed|resolved|improved|updated|added|removed|deleted|modified|changed|migrated|refactored|optimized|debugged|analyzed|evaluated|planned|organized|coordinated|scheduled|arranged|prepared|submitted|delivered|shipped|released|published|launched|announced|presented|demonstrated|showed|explained|described|clarified|confirmed|verified|validated|approved|rejected|deferred|postponed|cancelled|completed|finished|started|began|continued|paused|resumed|stopped|halted|abandoned)\b/g,
  
  // Company names with suffixes (Inc, LLC, Corp, Ltd, Co, Group, Labs, Technologies, Systems, Solutions)
  companyName: /\b[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*\s+(?:Inc\.?|LLC|Corp\.?|Ltd\.?|Co\.?|Group|Labs|Technologies|Systems|Solutions|Enterprises|Partners|Associates|Consulting|Holdings)\b/g,
  
  // Project names in quotes (single or double): "Project Alpha", 'Thunderbolt', "Atlas"
  quotedProject: /["']([A-Z][A-Za-z0-9\s\-_.]{1,50})["']/g,
};

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
export function extractQueryEntities(query: string): string[] {
  const entities = new Set<string>();
  
  // Extract PascalCase entities
  const pascalMatches = query.matchAll(ENTITY_PATTERNS.pascalCase);
  for (const match of pascalMatches) {
    entities.add(match[0]);
  }
  
  // Extract camelCase entities
  const camelMatches = query.matchAll(ENTITY_PATTERNS.camelCase);
  for (const match of camelMatches) {
    entities.add(match[0]);
  }
  
  // Extract file paths
  const filePathMatches = query.matchAll(ENTITY_PATTERNS.filePath);
  for (const match of filePathMatches) {
    entities.add(match[0]);
    // Also extract just the filename without path
    const parts = match[0].split('/');
    const fileName = parts[parts.length - 1];
    if (fileName !== match[0]) {
      entities.add(fileName);
    }
  }
  
  // Extract function calls (without parentheses)
  const functionMatches = query.matchAll(ENTITY_PATTERNS.functionCall);
  for (const match of functionMatches) {
    entities.add(match[1]);
  }
  
  // Extract tools/frameworks
  const toolMatches = query.matchAll(ENTITY_PATTERNS.tools);
  for (const match of toolMatches) {
    entities.add(match[0]);
  }
  
  // Extract version numbers
  const versionMatches = query.matchAll(ENTITY_PATTERNS.versions);
  for (const match of versionMatches) {
    entities.add(match[0]);
  }
  
  // Extract person names with context words
  const personMatches = query.matchAll(ENTITY_PATTERNS.personName);
  for (const match of personMatches) {
    // match[0] is the full "Name verb" - extract just the name
    const name = match[0].split(/\s+/)[0];
    if (name.length >= 2) {
      entities.add(name);
    }
  }
  
  // Extract company names with suffixes
  const companyMatches = query.matchAll(ENTITY_PATTERNS.companyName);
  for (const match of companyMatches) {
    entities.add(match[0]);
  }
  
  // Extract quoted project names (captured group is the name inside quotes)
  const quotedMatches = query.matchAll(ENTITY_PATTERNS.quotedProject);
  for (const match of quotedMatches) {
    if (match[1]) {
      entities.add(match[1].trim());
    }
  }
  
  return Array.from(entities);
}

/**
 * Boost search results based on entity overlap with query
 * 
 * @param results - Original search results
 * @param queryEntities - Entities extracted from the query
 * @returns Results with boosted similarity scores
 */
export function entityBoost(
  results: SearchResult[],
  queryEntities: string[]
): SearchResult[] {
  if (!queryEntities || queryEntities.length === 0 || results.length === 0) {
    return results;
  }
  
  // Normalize query entities for case-insensitive matching
  const normalizedEntities = new Set(
    queryEntities.map(e => e.toLowerCase())
  );
  
  // Boost each result based on entity matches
  const boosted = results.map(result => {
    const content = (result.content ?? '').toLowerCase();
    const summary = (result.summary ?? '').toLowerCase();
    const combinedText = `${content} ${summary}`;
    
    // Count matching entities
    let matchCount = 0;
    for (const entity of normalizedEntities) {
      if (combinedText.includes(entity)) {
        matchCount++;
      }
    }
    
    // Apply boost: 0.05 per matching entity (capped at 0.30)
    const boost = Math.min(matchCount * 0.05, 0.30);

    return addBoost(result, 'entity', boost);
  });
  
  // Re-sort by boosted similarity
  boosted.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  
  return boosted;
}
