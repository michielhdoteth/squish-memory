/**
 * Contradiction Resolver
 * Detects and auto-resolves contradictions when writing new memories
 * Implements supersession logic for outdated information
 *
 * Single contradiction engine: 7 heuristic scenarios propose supersessions,
 * then an optional proposition-aware LLM validator vetoes confident false
 * positives (graceful degradation to heuristics when LLM is unavailable).
 */

import { toEpochMillisFromMixed } from '../lib/timestamps.js';
import { withSqliteTransaction } from '../storage/sqlite-transaction.js';
import { eq, and, not, inArray } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { evictMemoryRuntimeState } from './runtime-cache-lifecycle.js';
import { invalidateSourceDerivedProjections } from './edit-workflow.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';
import { createAssociation, getMemoryAssociationRows, wouldCreateSupersessionCycle } from '../associations.js';
import { callLLM } from '../llm/client.js';
import { getDecisionRunner } from '../decision-model/backend-factory.js';
import { throwIfDecisionAborted } from '../decision-model/types.js';
import { config } from '../../config.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';

async function withSqliteSupersessionTransaction<T>(sqlite: { exec: (sql: string) => void; inTransaction?: boolean }, operation: () => Promise<T>): Promise<T> {
  return withSqliteTransaction(sqlite, operation);
}

export interface ContradictionResult {
  hasContradiction: boolean;
  supersededMemories: string[];
  confidence: number;
  reason: string;
  /** Which association type to use: 'updates' for explicit replacements, 'supersedes' for temporal contradictions */
  associationType: 'updates' | 'supersedes';
}

export { wouldCreateSupersessionCycle } from '../associations.js';

async function assertContradictionWorkflowAvailable(operation: string, resourceId: string): Promise<void> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(resourceId, 'memory_lifecycle', `Contradiction ${operation} is disabled under strict trust until caller-scoped source authorization is implemented`);
  }
}

export interface ContradictionCheck {
  newContent: string;
  newType: string;
  projectId?: string;
  entities?: string[];
  excludeId?: string; // Exclude this memory from contradiction checks (the newly inserted one)
  newMemoryCreatedAt?: string; // ISO timestamp of the new memory for temporal comparison
  /** Cancels optional decision-model relation validation; heuristic stays authoritative. */
  signal?: AbortSignal;
}

/**
 * Batch 6b: normalize a stored temporal value to ms. Drizzle timestamp-mode
 * columns arrive as Date, raw SQL paths may deliver epoch SECONDS or ISO
 * strings; values below 1e11 are treated as seconds. Shared with
 * `normalizeTimestampValue` in core/retrieval/temporal-validity.ts - both are
 * the same function, defined once in `toEpochMillisFromMixed`. (The micro/milli
 * ladder in `normalizeTimestamp` is a different, wider rule set.)
 */
function toMs(value: string | number | Date | null | undefined): number | null {
  return toEpochMillisFromMixed(value);
}

/**
 * Calculate temporal relationship between two time periods
 * Returns: 'existing_is_newer', 'existing_is_older', 'overlapping', or 'unknown'
 */
function calculateTemporalRelationship(
  existingValidFrom: string | number | Date | null,
  existingValidTo: string | number | Date | null,
  newTime: Date
): 'existing_is_newer' | 'existing_is_older' | 'overlapping' | 'unknown' {
  const fromMs = toMs(existingValidFrom);
  const toMsVal = toMs(existingValidTo);
  if (fromMs === null && toMsVal === null) {
    return 'unknown';
  }

  // If existing fact is completely in the future compared to new time
  if (fromMs !== null && fromMs > newTime.getTime()) {
    return 'existing_is_newer';
  }

  // If existing fact is completely in the past compared to new time
  if (toMsVal !== null && toMsVal <= newTime.getTime()) {
    return 'existing_is_older';
  }

  // If time periods overlap or we can't determine
  return 'overlapping';
}

/**
 * Check if two temporal periods conflict (don't overlap reasonably)
 */
function checkTemporalPeriodConflict(
  existingStart: string | null,
  existingEnd: string | null,
  newStart: Date,
  newEnd: Date | null
): boolean {
  // If we don't have enough info, assume no conflict
  if (!existingStart || !existingEnd) {
    return false;
  }
  
  const existingStartDate = new Date(existingStart);
  const existingEndDate = new Date(existingEnd);
  
  // Normalize newEnd (use distant future if null)
  const normalizedNewEnd = newEnd || new Date(8640000000000000); // Far future
  
  // Check if periods overlap
  const overlaps = !(existingStartDate >= normalizedNewEnd ||
                    existingEndDate <= newStart);
  
  // Conflict if they don't overlap
  return !overlaps;
}

// Patterns that indicate updated/corrected information
// NOTE: no /g flag - these regexes are module-level and reused with .test(),
// where a persistent lastIndex causes every other call to miss the match.
const UPDATE_PATTERNS = [
  /\b(now|currently|actually|in fact|correct(ed)?|update(d)?)\b/i,
  /\b(changed to|switched to|moved to)\b/i,
  /\b(formerly|previously|used to be)\b/i,
  /\binstead of\b/i,
  /\b(no longer|not anymore)\b/i,
  /\b(as of|starting|beginning|from now|effective)\s+(\d{4}|\w+\s+\d{1,2})/i, // Temporal updates
  // Batch WS2b: the state-change verb class, generalized (not per case).
  // Replacement/migration/transition vocabulary all assert that an old
  // state was superseded ("migrated from FAISS to Qdrant", "replaces
  // flake8", "switched providers", "adopted OpenTelemetry") - the same
  // signal the existing "changed to / switched to / moved to" phrases
  // carry, previously missed unless the exact preposition matched.
  /\b(migrated|migrating|migrates|switched|shifted|transitioned|replaced|replaces|swapped|adopted|upgraded)\b/i,
  /\bmoved\s+from\b/i,
];

// Negation patterns (no /g - same stateful-lastIndex reason as above)
const NEGATION_PATTERNS = [
  /\b(not|no|never|don't|doesn't|didn't|won't|wouldn't|shouldn't|can't|cannot)\b/i,
];

// Temporal sensitivity patterns - content that is likely time-sensitive
const TEMPORAL_SENSITIVITY_PATTERNS = [
  /\b(date|time|version|release|deadline|schedule|timeline)\b/i,
  /\b(\d{4}|january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  /\b(today|tomorrow|yesterday|next\s+week|last\s+week|this\s+week)\b/i,
];

// Key entity extraction for contradiction detection
function extractKeyEntities(content: string): string[] {
  // Simple extraction of capitalized phrases and key terms
  const entities: string[] = [];
  
  // Match capitalized multi-word phrases (likely proper nouns)
  const properNouns = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  entities.push(...properNouns);
  
  // Match quoted strings (often important values)
  const quoted = content.match(/"([^"]+)"|'([^']+)'/g) || [];
  entities.push(...quoted.map(q => q.replace(/['"]/g, '')));
  
  // Match key-value patterns
  const keyValues = content.match(/(\w+)\s*[=:]\s*(\S+)/g) || [];
  entities.push(...keyValues);
  
  return [...new Set(entities)];
}

// Calculate content similarity (Jaccard on words)
function calculateSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 2));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 2));
  
  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);
  
  return union.size > 0 ? intersection.size / union.size : 0;
}

// Check if content has negation
function hasNegation(content: string): boolean {
  return NEGATION_PATTERNS.some(pattern => pattern.test(content));
}

// Check if content indicates an update (exported for unit tests of the
// state-change verb lexicon - scenario 2 of detectContradictions gates on it).
export function hasUpdateIndicator(content: string): boolean {
  return UPDATE_PATTERNS.some(pattern => pattern.test(content));
}

// Extract the "subject" of a memory (what it's about)
function extractSubject(content: string): string {
  // Take first significant clause
  const sentences = content.split(/[.!?\n]/);
  const firstSentence = sentences[0]?.trim() || content;
  
  // Limit to first 100 chars for subject matching
  return firstSentence.substring(0, 100).toLowerCase();
}

// Opposite keyword pairs for fast heuristic contradiction detection
// (Scenario 7): two contents asserting opposing values of the same pair
// (e.g. "working" vs "broken") are flagged as candidate contradictions.
const OPPOSITE_KEYWORD_PAIRS: Array<readonly [string, string]> = [
  ['yes', 'no'],
  ['true', 'false'],
  ['always', 'never'],
  ['increase', 'decrease'],
  ['up', 'down'],
  ['good', 'bad'],
  ['success', 'failure'],
  ['working', 'broken'],
];

/**
 * Find the first opposite keyword pair shared between two contents.
 * Uses whole-word matching (case-insensitive) to avoid substring false
 * positives like "no" inside "notice". Returns null when no pair matches.
 */
function matchOppositeKeywordPair(a: string, b: string): readonly [string, string] | null {
  const contentA = a.toLowerCase();
  const contentB = b.toLowerCase();

  for (const [x, y] of OPPOSITE_KEYWORD_PAIRS) {
    const xInA = new RegExp(`\\b${x}\\b`).test(contentA);
    const yInA = new RegExp(`\\b${y}\\b`).test(contentA);
    const xInB = new RegExp(`\\b${x}\\b`).test(contentB);
    const yInB = new RegExp(`\\b${y}\\b`).test(contentB);

    if ((xInA && yInB) || (yInA && xInB)) {
      return [x, y];
    }
  }

  return null;
}

/**
 * Check if two contents share an opposite keyword pair (exported for tests).
 */
export function hasOppositeKeywords(a: string, b: string): boolean {
  return matchOppositeKeywordPair(a, b) !== null;
}

/**
 * LLM-as-validator verdict for a proposed supersession.
 * Null means "validator unavailable or unusable response" - caller keeps heuristic verdict.
 */
interface SupersessionValidation {
  contradicts: boolean;
  confidence: number;
}

/**
 * Swappable validator slot: given the proposed supersession, return a verdict
 * or null ("cannot judge" - heuristics stand). Implementations:
 * - decision-model validator (relation judge) when SQUISH_DECISION_LAYER_ENABLED
 *   AND SQUISH_DECISION_MODEL_ENABLED are both set
 * - legacy ad-hoc callLLM validator when only SQUISH_LLM_ENABLED is set
 */
type SupersessionValidator = (
  newContent: string,
  existingContent: string,
  signal?: AbortSignal,
) => Promise<SupersessionValidation | null>;

// Upper bound on validator calls per detectContradictions call to bound latency
const MAX_VALIDATIONS = 5;

// Minimum legacy LLM confidence required to overturn a heuristic proposal
const MIN_LLM_VETO_CONFIDENCE = 0.7;

// Minimum decision-model confidence to veto. The client already refuses
// decisions below the relation threshold (0.75, ADR-004); this mirrors it
// explicitly for the resolver's own gate.
const DECISION_MODEL_VETO_CONFIDENCE = 0.75;

/**
 * Validate a proposed supersession with the legacy ad-hoc callLLM prompt.
 * Proposition-aware: only same-subject, same-attribute, incompatible-value
 * pairs count as contradictions. Returns null whenever the LLM is disabled,
 * unavailable, or returns garbage - the caller then keeps the heuristic
 * verdict (graceful degradation).
 */
async function llmValidateSupersession(
  newContent: string,
  existingContent: string
): Promise<SupersessionValidation | null> {
  if (!config.llmEnabled) return null;

  const prompt = `You are a contradiction validator for a memory system. Compare two memories about possibly the same subject.

EXISTING MEMORY: ${existingContent}
NEW MEMORY: ${newContent}

Rules:
- A contradiction requires the SAME subject AND the SAME attribute/relation stated with incompatible values.
- Different attributes about the same subject are NOT contradictions ("Kenji was born in Tokyo" vs "Kenji uses an iPhone" -> NOT a contradiction).
- Temporal progression is NOT a contradiction ("I moved to Austin" after "I live in Houston" -> NOT a contradiction; it is an update).
- Same attribute, incompatible values IS a contradiction ("I live in Austin" vs "I live in Houston" -> contradiction).

Respond with ONLY minified JSON: {"contradicts": true|false, "confidence": 0.0-1.0}`;

  try {
    const response = await callLLM(prompt);
    if (!response) return null;

    // Strip markdown fences if present, then extract the outermost JSON object
    const stripped = response.replace(/```(?:json)?/gi, '').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Partial<SupersessionValidation>;
    if (typeof parsed.contradicts !== 'boolean' || typeof parsed.confidence !== 'number') {
      return null;
    }

    return { contradicts: parsed.contradicts, confidence: parsed.confidence };
  } catch {
    return null;
  }
}

/**
 * Validate a proposed supersession with the decision model's relation judge.
 * Mapping (relation ontology -> veto verdict):
 * - 'semantic'  -> contradicts=true  (same subject/attribute, incompatible values)
 * - 'temporal'  -> contradicts=false (the new content is a later update)
 * - 'causal'    -> contradicts=false (cause/effect, not a contradiction)
 * - 'entity'    -> contradicts=false (shared entities, different attributes)
 * The selected decision backend (llm or systemone, off = rules) enforces the
 * relation confidence band (0.75 default); null on any failure so heuristics
 * stand.
 */
async function decisionModelValidateSupersession(
  newContent: string,
  existingContent: string,
  signal?: AbortSignal,
): Promise<SupersessionValidation | null> {
  const decision = await getDecisionRunner().judgeRelationModelOnly(newContent, existingContent, { signal });
  if (!decision) return null;
  return {
    contradicts: decision.relationType === 'semantic',
    confidence: decision.confidence,
  };
}

/**
 * Detect contradictions between new memory and existing memories
 */
export async function detectContradictions(check: ContradictionCheck): Promise<ContradictionResult> {
  throwIfDecisionAborted(check.signal);
  await assertContradictionWorkflowAvailable('detection', check.projectId ?? 'unscoped');
  const result: ContradictionResult = {
    hasContradiction: false,
    supersededMemories: [],
    confidence: 0,
    reason: '',
    associationType: 'supersedes',
  };

  try {
    const db = await getDb();
    const schema = await getSchema();
    
    // Get memories from same project with similar content
    const conditions: any[] = [];
    // Only check active memories (skip superseded/merged)
    conditions.push(eq(schema.memories.status, 'active'));
    if (check.projectId) {
      conditions.push(eq(schema.memories.projectId, check.projectId));
    }
    if (check.excludeId) {
      conditions.push(not(eq(schema.memories.id, check.excludeId)));
    }
    
    const whereClause = and(...conditions);
    
    const existingMemories = await (db as any)
      .select()
      .from(schema.memories)
      .where(whereClause)
      .limit(100);
    
    if (existingMemories.length === 0) {
      return result;
    }
    
    const newSubject = extractSubject(check.newContent);
    const newEntities = extractKeyEntities(check.newContent);
    const newHasNegation = hasNegation(check.newContent);
    const newHasUpdate = hasUpdateIndicator(check.newContent);
    
    const toSupersede: string[] = [];
    let maxConfidence = 0;
    let reasons: string[] = [];
    // Default to 'supersedes' for temporal contradictions; 'updates' for explicit replacements
    let pendingAssociationType: 'updates' | 'supersedes' = 'supersedes';
    
    for (const existing of existingMemories) {
      // Skip already superseded memories
      if (existing.status === 'superseded' || existing.status === 'merged') {
        continue;
      }
      
      // Skip protected memories
      if (existing.isProtected) {
        continue;
      }
      
      const existingSubject = extractSubject(existing.content);
      const similarity = calculateSimilarity(check.newContent, existing.content);
      const subjectSimilarity = calculateSimilarity(newSubject, existingSubject);
      
      // Check for entity overlap
      const existingEntities = extractKeyEntities(existing.content);
      const entityOverlap = newEntities.filter(e => 
        existingEntities.some(ee => ee.toLowerCase().includes(e.toLowerCase()) || 
                                    e.toLowerCase().includes(ee.toLowerCase()))
      );
      
       // Calculate temporal relationship between memories
       const temporalRelationship = calculateTemporalRelationship(
         existing.validFrom, 
         existing.validTo, 
         check.newMemoryCreatedAt ? new Date(check.newMemoryCreatedAt) : new Date()
       );
       
       // Detect contradiction scenarios with temporal awareness
       
       // Scenario 1: High similarity with negation in new content
       if (similarity > 0.5 && newHasNegation && subjectSimilarity > 0.4) {
         // Adjust confidence based on temporal relevance
         let temporalFactor = 1.0;
         if (temporalRelationship === 'existing_is_newer') {
           temporalFactor = 0.7; // Lower confidence if existing is newer
         } else if (temporalRelationship === 'existing_is_older') {
           temporalFactor = 1.2; // Higher confidence if existing is older
         }
         
         toSupersede.push(existing.id);
         maxConfidence = Math.max(maxConfidence, similarity * 0.9 * temporalFactor);
         reasons.push(`negation of similar content (${(similarity * 100).toFixed(0)}% similar)`);
         continue;
       }
       
       // Scenario 2: Update indicator with overlapping subject (explicit replacement)
       if (newHasUpdate && subjectSimilarity > 0.5) {
         // Boost confidence for updates when existing is older
         let temporalFactor = 1.0;
         if (temporalRelationship === 'existing_is_older') {
           temporalFactor = 1.3; // Higher confidence for updating older info
         }
         
         toSupersede.push(existing.id);
         maxConfidence = Math.max(maxConfidence, subjectSimilarity * 0.85 * temporalFactor);
         reasons.push(`update to existing information`);
         // Use 'updates' for explicit replacements (newer, better version of same info)
         pendingAssociationType = 'updates';
         continue;
       }
       
       // Scenario 3: Same type, high subject similarity, different conclusion
       if (existing.type === check.newType && subjectSimilarity > 0.6) {
         // Check if conclusions differ
         const existingHasNegation = hasNegation(existing.content);
         
         // XOR: one has negation, other doesn't
         if (newHasNegation !== existingHasNegation) {
           // Adjust confidence based on temporal relationship
           let temporalFactor = 1.0;
           if (temporalRelationship === 'existing_is_newer') {
             temporalFactor = 0.8; // Lower confidence if contradicting newer info
           } else if (temporalRelationship === 'existing_is_older') {
             temporalFactor = 1.1; // Higher confidence if contradicting older info
           }
           
           toSupersede.push(existing.id);
           maxConfidence = Math.max(maxConfidence, subjectSimilarity * 0.8 * temporalFactor);
           reasons.push(`contradicting statement about same topic`);
           continue;
         }
       }
       
       // Scenario 4: Entity overlap with correction signals (explicit replacement)
       if (entityOverlap.length >= 2 && similarity > 0.3) {
         const correctionSignals = /\b(fixed|changed|updated|replaced|removed|added)\b/i.test(check.newContent);
         if (correctionSignals) {
           // Consider temporal relevance for corrections
           let temporalFactor = 1.0;
           if (temporalRelationship === 'existing_is_older') {
             temporalFactor = 1.2; // Higher confidence for correcting older info
           }
           
           toSupersede.push(existing.id);
           maxConfidence = Math.max(maxConfidence, 0.75 * temporalFactor);
           reasons.push(`correction involving ${entityOverlap.slice(0, 2).join(', ')}`);
           // Use 'updates' for explicit corrections (replacing specific data)
           pendingAssociationType = 'updates';
           continue;
         }
       }
       
       // Scenario 5: Very high similarity (near-duplicate) - supersede older
       if (similarity > 0.85) {
         // Prefer to supersede older memories with newer ones
         let temporalFactor = 1.0;
         if (temporalRelationship === 'existing_is_older') {
           temporalFactor = 1.1; // Slight boost for superseding older
         } else if (temporalRelationship === 'existing_is_newer') {
           temporalFactor = 0.9; // Slight reduction for superseding newer
         }
         
         toSupersede.push(existing.id);
         maxConfidence = Math.max(maxConfidence, similarity * temporalFactor);
         reasons.push(`near-duplicate replacement`);
         continue;
       }
       
        // Scenario 6: Temporal inconsistency - same subject but different time periods
        if (subjectSimilarity > 0.7 && similarity > 0.4 && 
            existing.validFrom && existing.validTo) {
          // Check if temporal periods don't overlap reasonably
          const newValidFrom = new Date(); // When we learned this
          const newValidTo = null; // Open-ended by default
          
          const hasTemporalConflict = checkTemporalPeriodConflict(
            existing.validFrom, existing.validTo,
            newValidFrom, newValidTo
          );
          
          if (hasTemporalConflict) {
            toSupersede.push(existing.id);
            maxConfidence = Math.max(maxConfidence, 0.8);
            reasons.push(`temporal inconsistency with existing fact`);
            continue;
          }
        }
        
        // Scenario 7: Opposite keywords with moderate similarity
        // (moved from the retired contradiction-v2 keyword detector)
        if (similarity > 0.35) {
          const oppositePair = matchOppositeKeywordPair(check.newContent, existing.content);
          
          if (oppositePair) {
            let temporalFactor = 1.0;
            if (temporalRelationship === 'existing_is_newer') {
              temporalFactor = 0.7; // Lower confidence if existing is newer
            } else if (temporalRelationship === 'existing_is_older') {
              temporalFactor = 1.2; // Higher confidence if existing is older
            }
            
            toSupersede.push(existing.id);
            maxConfidence = Math.max(maxConfidence, 0.7 * temporalFactor);
            reasons.push(`opposite keywords (${oppositePair[0]}/${oppositePair[1]})`);
            continue;
          }
        }
    }
    
    // Validator slot precedence: decision validator ONLY when the layer AND
    // the model are enabled and the decision backend is not switched off
    // (backend=off = rules only); otherwise the legacy ad-hoc callLLM
    // validator when the master LLM is enabled; otherwise null and heuristic
    // verdicts stand unchanged.
    const usingDecisionModel =
      config.decisionLayerEnabled && config.decisionModelEnabled && config.decisionModelBackend !== 'off';
    const validator: SupersessionValidator | null = usingDecisionModel
      ? decisionModelValidateSupersession
      : config.llmEnabled
        ? llmValidateSupersession
        : null;
    const vetoConfidence = usingDecisionModel
      ? DECISION_MODEL_VETO_CONFIDENCE
      : MIN_LLM_VETO_CONFIDENCE;

    const proposedIds = [...new Set(toSupersede)];
    let validatedIds = proposedIds;

    if (proposedIds.length > 0 && validator) {
      const contentById = new Map<string, string>();
      for (const m of existingMemories as Array<{ id: string; content: string }>) {
        contentById.set(m.id, m.content);
      }

      const cappedIds = proposedIds.slice(0, MAX_VALIDATIONS);
      const dropped: string[] = [];

      for (const id of cappedIds) {
        const existingContent = contentById.get(id);
        if (!existingContent) continue;

        const verdict = await validator(check.newContent, existingContent, check.signal);
        if (verdict && !verdict.contradicts && verdict.confidence >= vetoConfidence) {
          dropped.push(id);
        }
      }

      if (dropped.length > 0) {
        validatedIds = proposedIds.filter(id => !dropped.includes(id));
        logger.debug('Validator dropped supersession proposals', {
          droppedCount: dropped.length,
          remaining: validatedIds.length,
        });
      }
    }
    
    if (validatedIds.length > 0) {
      result.hasContradiction = true;
      result.supersededMemories = validatedIds;
      result.confidence = maxConfidence;
      result.reason = reasons[0] || 'contradiction detected';
      result.associationType = pendingAssociationType;
    }
    
  } catch (error) {
    throwIfDecisionAborted(check.signal);
    logger.error('Error detecting contradictions', error);
  }
  
  return result;
}

/**
 * Apply supersession to memories - archive old ones and create associations
 */
export async function applySupersession(
  newMemoryId: string,
  supersededIds: string[],
  confidence: number,
  associationType: 'updates' | 'supersedes' = 'supersedes'
): Promise<void> {
  await assertContradictionWorkflowAvailable('supersession', `${newMemoryId}:${[...new Set(supersededIds)].sort().join(',')}`);
  // An in-place update can appear in the contradiction candidate set. Never
  // mark the replacement itself as superseded or write a self-referential
  // successor pointer.
  const validSupersededIds = [...new Set(supersededIds.filter((id) => id !== newMemoryId))];
  if (validSupersededIds.length === 0) return;
  
  try {
    const db = await getDb();
    const schema = await getSchema();
    const sqlite = (db as any).$client;
    const apply = async (): Promise<string[]> => {
    const now = new Date();
    const currentRelations = await getMemoryAssociationRows();
    const safeSupersededIds = validSupersededIds.filter((oldId) => {
      const createsCycle = wouldCreateSupersessionCycle(newMemoryId, oldId, currentRelations);
      if (createsCycle) logger.warn('Rejected supersession that would create a cycle', { newMemoryId, oldId });
      return !createsCycle;
    });
    if (safeSupersededIds.length === 0) return [];
    const replacementRows = await (db as any)
      .select({ validFrom: schema.memories.validFrom })
      .from(schema.memories)
      .where(eq(schema.memories.id, newMemoryId))
      .limit(1);
    let replacementValidFrom = replacementRows[0]?.validFrom instanceof Date
      ? replacementRows[0].validFrom as Date
      : now;
    const oldRows = await (db as any)
      .select({ id: schema.memories.id, validFrom: schema.memories.validFrom, validTo: schema.memories.validTo })
      .from(schema.memories)
      .where(and(inArray(schema.memories.id, safeSupersededIds), eq(schema.memories.status, 'active')));

    // Multiple captures can land in the same millisecond. Give the replacement
    // a deterministic later valid-time boundary so the old interval remains
    // non-empty, while still rejecting genuinely earlier corrections below.
    const equalBoundary = (oldRows as Array<{ validFrom: Date | null }>).some(
      (row) => row.validFrom?.getTime() === replacementValidFrom.getTime()
    );
    if (equalBoundary) {
      replacementValidFrom = new Date(replacementValidFrom.getTime() + 1);
      await (db as any)
        .update(schema.memories)
        .set({ validFrom: replacementValidFrom, recordedAt: now, updatedAt: now })
        .where(eq(schema.memories.id, newMemoryId));
      if (sqlite && typeof sqlite.prepare === 'function') {
        sqlite.prepare(`
          UPDATE knowledge SET valid_from = ?, recorded_at = ?, updated_at = ?
          WHERE knowledge_kind = 'memory'
            AND (id = ? OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?)
        `).run(Math.floor(replacementValidFrom.getTime() / 1000), Math.floor(now.getTime() / 1000), Math.floor(now.getTime() / 1000), newMemoryId, newMemoryId);
      }
    }

    const appliedIds: string[] = [];
    for (const oldMemory of oldRows as Array<{ id: string; validFrom: Date | null; validTo: Date | null }>) {
      const priorValidFrom = oldMemory.validFrom;
      if (priorValidFrom && replacementValidFrom <= priorValidFrom) {
        logger.warn('Rejected supersession that would create an empty valid-time interval', {
          newMemoryId,
          oldMemoryId: oldMemory.id,
        });
        continue;
      }
      const validTo = oldMemory.validTo && oldMemory.validTo < replacementValidFrom
        ? oldMemory.validTo
        : replacementValidFrom;
      const updated = await (db as any)
        .update(schema.memories)
        .set({
          status: 'superseded',
          isActive: false,
          supersededBy: newMemoryId,
          supersededAt: now,
          validTo,
          recordedAt: now,
          updatedAt: now,
        })
        .where(and(eq(schema.memories.id, oldMemory.id), eq(schema.memories.status, 'active')))
        .returning({ id: schema.memories.id });
      if (updated.length > 0) {
        appliedIds.push(oldMemory.id);
        // `knowledge` is the canonical recall projection for each memory.
        // Keep its lifecycle and valid-time boundary aligned with the source
        // row so graph and direct knowledge reads cannot revive superseded facts.
        if (sqlite && typeof sqlite.prepare === 'function') {
          sqlite.prepare(`
            UPDATE knowledge
            SET status = 'superseded', is_active = 0, superseded_by = ?,
                valid_to = ?, recorded_at = ?, updated_at = ?
            WHERE knowledge_kind = 'memory'
              AND (id = ? OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?)
          `).run(newMemoryId, Math.floor(validTo.getTime() / 1000), Math.floor(now.getTime() / 1000), Math.floor(now.getTime() / 1000), oldMemory.id, oldMemory.id);
        } else {
          const projections = await (db as any)
            .select({ id: schema.knowledge.id, metadata: schema.knowledge.metadata })
            .from(schema.knowledge)
            .where(eq(schema.knowledge.knowledgeKind, 'memory'));
          for (const projection of projections as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
            if (projection.id !== oldMemory.id && projection.metadata?.sourceMemoryId !== oldMemory.id) continue;
            await (db as any)
              .update(schema.knowledge)
              .set({ status: 'superseded', isActive: false, supersededBy: newMemoryId, validTo, recordedAt: now, updatedAt: now })
              .where(eq(schema.knowledge.id, projection.id));
          }
        }
        await invalidateSourceDerivedProjections(db, schema, oldMemory.id, now, 'source_superseded');
      }
    }

    // Create canonical directed relationships only for records actually closed.
    for (const oldId of appliedIds) {
      await createAssociation(newMemoryId, oldId, associationType, confidence, undefined, {
        validFrom: replacementValidFrom,
        recordedAt: now,
      });
    }

    return appliedIds;
    };

    const appliedIds = sqlite && typeof sqlite.exec === 'function' && typeof sqlite.prepare === 'function'
      ? await withSqliteSupersessionTransaction(sqlite, apply)
      : await apply();
    for (const oldId of appliedIds) await evictMemoryRuntimeState([oldId]);

    logger.debug('Applied supersession', {
      newMemoryId,
      supersededCount: appliedIds.length,
      confidence,
    });
    
  } catch (error) {
    logger.error('Error applying supersession', error);
  }
}

/**
 * Check for temporal contradictions (facts that are no longer valid)
 */
export async function checkTemporalContradictions(
  content: string,
  projectId?: string
): Promise<string[]> {
  await assertContradictionWorkflowAvailable('temporal lookup', projectId ?? 'unscoped');
  const supersededIds: string[] = [];
  
  try {
    // Look for temporal update patterns
    const temporalUpdates = content.match(
      /\b(as of|starting|beginning|from now|effective)\s+(\d{4}|\w+\s+\d{1,2})/gi
    );
    
    if (!temporalUpdates || temporalUpdates.length === 0) {
      return supersededIds;
    }
    
    const db = await getDb();
    const schema = await getSchema();
    
    // Find memories with overlapping subject but older validTo dates
    const subject = extractSubject(content);
    
    const whereClause = projectId
      ? and(
          eq(schema.memories.projectId, projectId),
          eq(schema.memories.status, 'active')
        )
      : eq(schema.memories.status, 'active');
    
    const candidates = await (db as any)
      .select()
      .from(schema.memories)
      .where(whereClause)
      .limit(50);
    
    for (const candidate of candidates) {
      const candidateSubject = extractSubject(candidate.content);
      const similarity = calculateSimilarity(subject, candidateSubject);
      
      if (similarity > 0.5 && candidate.validTo) {
        const validToDate = new Date(candidate.validTo);
        const now = new Date(Date.now());
        
        // If the candidate's validity period has passed
        if (validToDate <= now) {
          supersededIds.push(candidate.id);
        }
      }
    }
    
  } catch (error) {
    logger.error('Error checking temporal contradictions', error);
  }
  
  return supersededIds;
}

/**
 * Integrated contradiction resolution for the write path
 * Call this before storing a new memory
 */
export async function resolveContradictions(
  content: string,
  type: string,
  projectId?: string,
  newMemoryId?: string,
  newMemoryCreatedAt?: string
): Promise<{
  shouldProceed: boolean;
  supersededIds: string[];
  confidence: number;
  reason: string;
  associationType: 'updates' | 'supersedes';
}> {
  // Detect standard contradictions
  const contradictionResult = await detectContradictions({
    newContent: content,
    newType: type,
    projectId,
    excludeId: newMemoryId,
    newMemoryCreatedAt,
  });
  
  // Also check temporal contradictions
  const temporalSuperseded = await checkTemporalContradictions(content, projectId);
  
  // Combine results
  const allSuperseded = [
    ...new Set([
      ...contradictionResult.supersededMemories,
      ...temporalSuperseded,
    ]),
  ];
  
  const maxConfidence = Math.max(
    contradictionResult.confidence,
    temporalSuperseded.length > 0 ? 0.7 : 0
  );
  
  // Determine the association type based on the reason
  // Temporal contradictions use 'supersedes'; explicit replacements use 'updates'
  let associationType: 'updates' | 'supersedes' = 'supersedes';
  if (contradictionResult.associationType === 'updates') {
    associationType = 'updates';
  }
  
  return {
    shouldProceed: true, // Always proceed, but track supersessions
    supersededIds: allSuperseded,
    confidence: maxConfidence,
    reason: contradictionResult.reason || 
            (temporalSuperseded.length > 0 ? 'temporal supersession' : ''),
    associationType,
  };
}
