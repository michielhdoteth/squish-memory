/**
 * Decision Model
 *
 * Lightweight controller that makes structured memory decisions
 * WITHOUT calling LLM APIs. Uses pattern-based classification
 * and simple heuristics.
 *
 * These rule results are always computed first and are the fallback:
 * the model-escalating client in provider.ts only overrides them when
 * the decision layer is enabled AND the model returns a confident,
 * well-formed decision.
 */

import { classifyMemoryType } from './decisions.js';
import type {
  ClassificationDecision,
  MemoryObservation,
  QueryView,
  RelationDecision,
  RetrievalDecision,
} from './types.js';

/** Resolve a stable identifier for an observation, falling back to its text. */
function observationId(observation: MemoryObservation | null | undefined): string {
  if (!observation) return '';
  return observation.id ?? (typeof observation.text === 'string' ? observation.text : '');
}

// ─── Relation heuristics ───────────────────────────────────────────────────

/** Markers indicating the new content updates/corrects existing content. */
const UPDATE_MARKERS = /\b(now|currently|no longer|not anymore|as of|updated|changed|moved|switched to)\b/i;

/** Markers indicating a causal relationship between the two contents. */
const CAUSAL_MARKERS = /\b(because|due to|caused|causes|led to|reason for|explains why|as a result)\b/i;

/** Extract heuristic entities: capitalized multi-word phrases and CamelCase words. */
function extractEntities(text: string): string[] {
  const phrases = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) ?? [];
  const camelWords = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+\b/g) ?? [];
  return [...new Set([...phrases, ...camelWords])];
}

function extractQuoted(text: string): string[] {
  const matches = text.match(/"([^"]+)"|'([^']+)'/g);
  return (matches ?? []).map((q) => q.replace(/['"]/g, ''));
}

/** Jaccard similarity over significant words (len > 2), like the resolver. */
function wordOverlap(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}

// ─── Routing heuristics ────────────────────────────────────────────────────

const TEMPORAL_CUES = /\b(when\s+(?:did|was|is|are)|yesterday|today|tomorrow|last\s+(?:week|month|year)|this\s+(?:week|month|year)|ago|earlier|recently|previously|since|until|during|\d{4}-\d{2}-\d{2})\b/i;

const CAUSAL_CUES = /\b(depends?\s+on|because|why|cause|effect|reason|led\s+to|due\s+to|impact|consequence)\b/i;

const QUESTION_CUES = /\b(what|who|where|how|which|explain|describe|tell\s+me|show\s+me|find|list|summarize)\b/i;

// ─── Controller ────────────────────────────────────────────────────────────

export class DecisionModel {
  /**
   * Classify a memory observation into a memory type.
   * Delegates to the decisions module.
   */
  classifyMemoryType(observation: MemoryObservation): ClassificationDecision {
    if (!observation || typeof observation.text !== 'string') {
      return {
        memoryType: 'discard',
        confidence: 1,
        reasoning: 'Invalid observation: missing text',
      };
    }
    return classifyMemoryType(observation);
  }

  /**
   * Judge the relation between two memories using lexical heuristics:
   * update markers with shared vocabulary → temporal; causal markers →
   * causal; shared entities with modest overlap → entity; otherwise semantic
   * with confidence proportional to word overlap.
   */
  judgeRelation(source: MemoryObservation, target: MemoryObservation): RelationDecision {
    if (!source || typeof source.text !== 'string' || !target || typeof target.text !== 'string') {
      return {
        sourceId: observationId(source),
        targetId: observationId(target),
        relationType: 'semantic',
        confidence: 0,
      };
    }

    const sourceId = observationId(source);
    const targetId = observationId(target);

    const overlap = wordOverlap(source.text, target.text);

    // Temporal: the new content updates the existing one about a shared subject.
    if (UPDATE_MARKERS.test(source.text) && overlap >= 0.3) {
      return { sourceId, targetId, relationType: 'temporal', confidence: 0.75 };
    }

    // Causal: explicit cause/effect language connecting the two.
    if (CAUSAL_MARKERS.test(source.text) || CAUSAL_MARKERS.test(target.text)) {
      return { sourceId, targetId, relationType: 'causal', confidence: 0.6 };
    }

    // Entity: shared named entities but only modest textual overlap.
    const sourceEntities = new Set([...extractEntities(source.text), ...extractQuoted(source.text)]);
    const targetEntities = new Set([...extractEntities(target.text), ...extractQuoted(target.text)]);
    const sharedEntities = [...sourceEntities].filter((e) => targetEntities.has(e));
    if (sharedEntities.length > 0 && overlap < 0.5) {
      return { sourceId, targetId, relationType: 'entity', confidence: 0.7 };
    }

    // Semantic: default relation; confidence rises with word overlap.
    return {
      sourceId,
      targetId,
      relationType: 'semantic',
      confidence: overlap >= 0.5 ? Math.min(0.9, 0.5 + overlap) : 0.4,
    };
  }

  /**
   * Route a query to retrieval views using lexical heuristics:
   * temporal/causal cues select their views, two or more capitalized
   * phrases select the entity view, clear question phrasing is a confident
   * semantic route, and anything else is a low-confidence semantic default
   * (the escalation candidate for model routing).
   */
  routeQuery(query: string): RetrievalDecision {
    const emptyDecision: RetrievalDecision = {
      queryViews: ['semantic'],
      anchorCount: 3,
      confidence: 0,
    };
    if (typeof query !== 'string' || query.trim() === '') {
      return emptyDecision;
    }

    const views: QueryView[] = [];
    if (TEMPORAL_CUES.test(query)) views.push('temporal');
    if (CAUSAL_CUES.test(query)) views.push('causal');
    if (extractEntities(query).length >= 2) views.push('entity');

    if (views.length > 0) {
      return {
        queryViews: views,
        anchorCount: 3,
        confidence: 0.8,
      };
    }

    // No specific view matched. Clear question phrasing is a confident
    // semantic route; anything else stays low-confidence so the model
    // router gets a chance when escalation is enabled.
    const confidence: number = QUESTION_CUES.test(query) ? 0.85 : 0.3;
    return {
      queryViews: ['semantic'],
      anchorCount: 3,
      confidence,
    };
  }
}
