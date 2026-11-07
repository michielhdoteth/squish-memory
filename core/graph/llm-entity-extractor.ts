/**
 * LLM Entity Extractor
 * 
 * Extracts named entities and relationships from memory content using
 * LLM-powered analysis. Falls back to regex extraction when LLM is unavailable.
 */

import { logger } from '../logger.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyUnscopedGraphOperation } from './strict-gates.js';
import { callLLM } from '../llm/client.js';
import {
  extractEntities as regexExtractEntities,
  type EntityType,
  type ExtractedEntity,
} from '../memory/entity-extractor.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export const ENTITY_RELATION_TYPES = [
  'works_on', 'depends_on', 'manages', 'oversees', 'uses', 'caused', 'located_in',
  'belongs_to', 'reports_to', 'occurred_on', 'affects', 'contains',
  'implements', 'extends', 'related_to', 'part_of', 'owns', 'created',
  'resolved', 'blocks', 'cites', 'party_to', 'version_of',
  'supersedes_version', 'has_status', 'dated_on',
] as const;

export type RelationType = (typeof ENTITY_RELATION_TYPES)[number];

export interface ExtractedRelation {
  fromEntity: string;
  toEntity: string;
  relationType: RelationType;
  confidence: number;
  context: string;
}

export interface LLMExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  source: 'llm' | 'regex' | 'none';
}

// ─── LLM Prompt ─────────────────────────────────────────────────────────────

const ENTITY_EXTRACTION_PROMPT = `You are an entity and relationship extractor for an AI memory system. Given text, extract:

1. ENTITIES: Named things mentioned (people, projects, systems, tools, concepts, events)
2. RELATIONSHIPS: How entities connect to each other

Return ONLY valid JSON in this exact format:
{
  "entities": [
    {"name": "Alice", "type": "person", "confidence": 0.95},
    {"name": "Project Atlas", "type": "concept", "confidence": 0.9}
  ],
  "relations": [
    {"from": "Alice", "to": "Project Atlas", "type": "works_on", "confidence": 0.85, "context": "Alice is the tech lead on Project Atlas"},
    {"from": "Project Atlas", "to": "PostgreSQL", "type": "uses", "confidence": 0.9, "context": "Project Atlas uses PostgreSQL for its primary datastore"}
  ]
}

Entity types: person, organization, matter, document, document_version, status, file, function, class, concept, tool, date, location, pattern, technique, other
Relation types: ${ENTITY_RELATION_TYPES.join(', ')}

For document-centered matters, classify named agreements, briefs, filings, and correspondence as document; classify a specific revision or draft as document_version; classify legal or business organizations as organization; and classify a case, transaction, or client matter as matter. Use cites for an explicit document citation, party_to for an explicit person or organization role in a matter or agreement, version_of for a revision's base document, supersedes_version when one revision explicitly replaces another, has_status for explicit draft/executed/filed status, and dated_on for an explicit document date. Keep edges directed from subject to target. Do not infer execution, legal effect, parties, citations, or version order from proximity alone.

Rules:
- Extract only explicitly mentioned entities and relationships
- When emitting relationship context, copy the exact supporting phrase or sentence from the source text
- Use the most specific relation type available
- Include confidence scores (0-1)
- Keep entity names as they appear in text (preserve capitalization)
- For ambiguous relationships, use "related_to"
- Do NOT invent entities or relationships not present in the text`;

// ─── JSON Parsing ────────────────────────────────────────────────────────────

/**
 * Parse LLM response into structured extraction result.
 * Handles various response formats (raw JSON, markdown code blocks, etc.)
 */
function parseLLMResponse(response: string): { entities: ExtractedEntity[]; relations: ExtractedRelation[] } | null {
  // Try to extract JSON from the response
  let jsonStr = response.trim();

  // Handle markdown code blocks
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // Try to find JSON object in the response
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.debug('No JSON found in LLM response');
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Validate structure
    if (!parsed.entities || !Array.isArray(parsed.entities)) {
      logger.debug('LLM response missing entities array');
      return null;
    }

    const entities: ExtractedEntity[] = (parsed.entities as any[])
      .filter((e: any) => e.name && e.type)
      .map((e: any) => ({
        name: String(e.name),
        type: validateEntityType(String(e.type)),
        confidence: typeof e.confidence === 'number' ? Math.min(1, Math.max(0, e.confidence)) : 0.8,
        startIndex: 0,
        endIndex: 0,
        context: String(e.context || ''),
        normalized: e.normalized ? String(e.normalized) : undefined,
      }));

    const relations: ExtractedRelation[] = (parsed.relations || [])
      .filter((r: any) => r.from && r.to && r.type)
      .map((r: any) => ({
        fromEntity: String(r.from),
        toEntity: String(r.to),
        relationType: validateRelationType(String(r.type)),
        confidence: typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : 0.7,
        context: String(r.context || ''),
      }));

    return { entities, relations };
  } catch (error) {
    logger.debug('Failed to parse LLM response as JSON', { error: error as Error });
    return null;
  }
}

function validateEntityType(type: string): EntityType {
  const validTypes: EntityType[] = ['person', 'organization', 'matter', 'document', 'document_version', 'status', 'file', 'function', 'class', 'concept', 'tool', 'date', 'location', 'pattern', 'technique', 'other'];
  const lower = type.toLowerCase() as EntityType;
  if (validTypes.includes(lower)) return lower;
  return 'other';
}

function validateRelationType(type: string): RelationType {
  const lower = type.toLowerCase();
  if ((ENTITY_RELATION_TYPES as readonly string[]).includes(lower)) return lower as RelationType;
  return 'related_to';
}

function mentionsEntity(content: string, name: string): boolean {
  const nameParts = name.trim().split(/\s+/).filter(Boolean);
  if (nameParts.length === 0) return false;
  const escapedName = nameParts
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapedName}(?![\\p{L}\\p{N}])`, 'iu').test(content);
}

function entityOccurrenceIndexes(content: string, name: string): number[] {
  const nameParts = name.trim().split(/\s+/).filter(Boolean);
  if (nameParts.length === 0) return [];
  const escapedName = nameParts
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return [...content.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapedName}(?![\\p{L}\\p{N}])`, 'giu'))]
    .flatMap((match) => typeof match.index === 'number' ? [match.index] : []);
}

const RELATION_CONTEXT_CUES: Readonly<Partial<Record<RelationType, RegExp>>> = {
  works_on: /\bworks?\s+on\b|\bworking\s+on\b/i,
  depends_on: /\bdepends?\s+on\b|\brequires?\b|\brelies?\s+on\b/i,
  manages: /\bmanages?\b|\bmanaged\s+by\b|\boversees?\b|\bsupervises?\b/i,
  oversees: /\boversees?\b|\bsupervises?\b/i,
  uses: /\buses?\b|\bused\b|\busing\b|\butili[sz]es?\b/i,
  caused: /\bcaused?\b|\bled\s+to\b|\bresulted\s+in\b/i,
  located_in: /\blocated\s+in\b|\bbased\s+in\b|\bsituated\s+in\b/i,
  belongs_to: /\bbelongs?\s+to\b|\bmember\s+of\b/i,
  reports_to: /\breports?\s+to\b|\breported\s+to\b/i,
  occurred_on: /\boccurred\s+on\b|\bhappened\s+on\b|\btook\s+place\s+on\b/i,
  affects: /\baffects?\b|\bimpacts?\b|\binfluences?\b/i,
  contains: /\bcontains?\b|\bincludes?\b|\bcomprises?\b/i,
  implements: /\bimplements?\b|\bimplemented\b|\bdeploys?\b/i,
  extends: /\bextends?\b|\bbuilds?\s+on\b|\bexpands?\s+on\b/i,
  part_of: /\bpart\s+of\b|\bcomponent\s+of\b/i,
  owns: /\bowns?\b|\bowned\s+by\b/i,
  created: /\bcreates?\b|\bcreated\b|\bauthored\b|\bproduced\b/i,
  resolved: /\bresolves?\b|\bresolved\b|\bfixed\b/i,
  blocks: /\bblocks?\b|\bblocked\b|\bprevents?\b/i,
  cites: /\bcites?\b|\bcited\b|\bcitation\s+to\b|\breferences?\b/i,
  party_to: /\bparty\s+to\b|\bparty\s+in\b|\bsignator(?:y|ies)\s+to\b|\bsigned\s+by\b/i,
  version_of: /\bversion\s+of\b|\brevision\s+of\b|\bdraft\s+of\b/i,
  supersedes_version: /\bsupersedes?\b|\bsuperseded\b|\breplaces?\b|\breplaced\b/i,
  has_status: /\bstatus\s+(?:is|was|:)|\b(?:is|was|remains?|became)\s+(?:draft|executed|filed|active|inactive)\b/i,
  dated_on: /\bdated\s+on\b|\bdated\s+\w+\s+\d{1,2},?\s+20\d{2}\b|\bdated\s+20\d{2}-\d{2}-\d{2}\b/i,
};

function relationTypeMatchesContext(relation: ExtractedRelation, context: string): boolean {
  if (/[?;]/.test(context)
    || /\b(?:not|never|no longer|without|might|may|could|possibly|perhaps|allegedly|uncertain)\b/i.test(context)) return false;
  const expectedCue = RELATION_CONTEXT_CUES[relation.relationType];
  if (expectedCue) {
    // Match a cue to a directed pair of mentions; a prior mention in another sentence
    // must not hide a later, correctly ordered relation.
    return [...context.matchAll(new RegExp(expectedCue.source, expectedCue.flags.replace('g', '') + 'g'))]
      .some((cue) => {
        if (typeof cue.index !== 'number') return false;
        const previousBoundary = Math.max(
          context.lastIndexOf('.', cue.index),
          context.lastIndexOf('!', cue.index),
          context.lastIndexOf('?', cue.index),
          context.lastIndexOf(';', cue.index),
        );
        const cueEnd = cue.index + cue[0].length;
        const followingBoundaries = ['.', '!', '?', ';']
          .map((boundary) => context.indexOf(boundary, cueEnd))
          .filter((index) => index >= 0);
        const nextBoundary = followingBoundaries.length > 0 ? Math.min(...followingBoundaries) : context.length;
        const segment = context.slice(previousBoundary + 1, nextBoundary);
        const segmentOffset = previousBoundary + 1;
        const fromIndexes = entityOccurrenceIndexes(segment, relation.fromEntity)
          .map((index) => index + segmentOffset);
        const toIndexes = entityOccurrenceIndexes(segment, relation.toEntity)
          .map((index) => index + segmentOffset);
        if (fromIndexes.length === 0 || toIndexes.length === 0) return false;

        const cueWithFollowingWord = cue[0] + context.slice(cueEnd, cueEnd + 32);
        const passiveCue = /\b(?:managed|supervised|used|caused|owned|created|implemented|cited|signed|superseded|replaced)\s+by\b/i.test(cueWithFollowingWord);
        return fromIndexes.some((fromIndex) => toIndexes.some((toIndex) => passiveCue
          ? toIndex < cue.index! && cue.index! < fromIndex
          : fromIndex < cue.index! && cue.index! < toIndex));
      });
  }
  // Generic relations remain the fallback when no specific cue is present.
  if (relation.relationType === 'related_to') return true;
  return false;
}

function validateLLMExtraction(
  content: string,
  parsed: { entities: ExtractedEntity[]; relations: ExtractedRelation[] },
): { entities: ExtractedEntity[]; relations: ExtractedRelation[] } {
  const validatedEntities = parsed.entities.filter((entity) => mentionsEntity(content, entity.name));
  const entityNames = new Set(validatedEntities.map((entity) => entity.name.toLowerCase()));
  const validatedRelations = parsed.relations.filter((relation) => {
    const bothEntitiesValidated = entityNames.has(relation.fromEntity.toLowerCase())
      && entityNames.has(relation.toEntity.toLowerCase());
    const context = relation.context.trim();
    const sourceBackedContext = context.length > 0
      && content.includes(context)
      && mentionsEntity(context, relation.fromEntity)
      && mentionsEntity(context, relation.toEntity)
      && relationTypeMatchesContext(relation, context);
    return bothEntitiesValidated && sourceBackedContext;
  });

  return { entities: validatedEntities, relations: validatedRelations };
}

// ─── Main Extraction Functions ───────────────────────────────────────────────

/**
 * Extract entities and relationships from text using LLM.
 * Falls back to regex extraction when LLM is unavailable.
 */
export async function extractEntitiesAndRelations(
  content: string,
  options?: {
    preferLLM?: boolean;
    maxContentLength?: number;
  }
): Promise<LLMExtractionResult> {
  const { preferLLM = true, maxContentLength = 4000 } = options || {};
  if (preferLLM && isStrictTrustPolicy()) {
    await denyUnscopedGraphOperation('llm_entity_extraction', 'unscoped_content');
  }

  // Truncate very long content
  const truncatedContent = content.length > maxContentLength
    ? content.substring(0, maxContentLength) + '...'
    : content;

  // Try LLM extraction first if preferred
  if (preferLLM) {
    const llmResult = await extractWithLLM(truncatedContent);
    if (llmResult) {
      logger.debug('LLM entity extraction succeeded', {
        entityCount: llmResult.entities.length,
        relationCount: llmResult.relations.length,
      });
      return { ...llmResult, source: 'llm' };
    }
  }

  // Fall back to regex extraction
  const regexEntities = await regexExtractEntities(content);
  if (regexEntities.length > 0) {
    logger.debug('Regex entity extraction fallback', {
      entityCount: regexEntities.length,
    });
    return {
      entities: regexEntities,
      relations: [], // Regex extraction doesn't produce relations
      source: 'regex',
    };
  }

  return { entities: [], relations: [], source: 'none' };
}

/**
 * Extract entities and relations using LLM.
 */
async function extractWithLLM(content: string): Promise<Omit<LLMExtractionResult, 'source'> | null> {
  // Build combined prompt: system instructions + user content
  const fullPrompt = `${ENTITY_EXTRACTION_PROMPT}\n\n---\n\nText to analyze:\n${content}`;
  const response = await callLLM(fullPrompt);
  if (!response) return null;

  const parsed = parseLLMResponse(response);
  if (!parsed) return null;

  return validateLLMExtraction(content, parsed);
}

/**
 * Extract entities and relations from multiple memories in batch.
 * More efficient than calling extractEntitiesAndRelations for each memory.
 */
export async function batchExtractEntitiesAndRelations(
  contents: string[],
  options?: {
    preferLLM?: boolean;
    maxContentLength?: number;
    batchSize?: number;
  }
): Promise<LLMExtractionResult[]> {
  const { batchSize = 5 } = options || {};
  const preferLLM = options?.preferLLM ?? true;
  if (preferLLM && isStrictTrustPolicy()) {
    await denyUnscopedGraphOperation('llm_entity_batch_extraction', 'unscoped_content');
  }
  const results: LLMExtractionResult[] = [];

  // Process in batches to avoid overwhelming the LLM
  for (let i = 0; i < contents.length; i += batchSize) {
    const batch = contents.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(content => extractEntitiesAndRelations(content, options))
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Get the extraction prompt for testing/debugging purposes.
 */
export function getExtractionPrompt(): string {
  return ENTITY_EXTRACTION_PROMPT;
}

/**
 * Parse an LLM response for testing/debugging purposes.
 */
export function testParseLLMResponse(response: string): { entities: ExtractedEntity[]; relations: ExtractedRelation[] } | null {
  return parseLLMResponse(response);
}

/** Validate parsed names and relation endpoints against source text. */
export function testValidateLLMResponse(
  content: string,
  response: string,
): { entities: ExtractedEntity[]; relations: ExtractedRelation[] } | null {
  const parsed = parseLLMResponse(response);
  return parsed ? validateLLMExtraction(content, parsed) : null;
}
