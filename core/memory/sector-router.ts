/**
 * Sector Router (Batch 6b).
 *
 * Signals-based classifier that assigns every new memory (and its knowledge
 * mirror) to one of four sectors:
 *
 *   'episodic'    - session chunks, observations of events, "what happened"
 *   'semantic'    - facts, decisions, preferences, promoted knowledge
 *   'procedural'  - procedures, SOPs, how-to patterns, strategies
 *   'reflective'  - insights and beliefs produced by consolidation
 *
 * Rules v1 (documented, evaluated in order):
 *   1. An explicit input override wins over every signal.
 *   2. Strategy knowledgeKind routes to 'procedural'.
 *   3. Reflective signals route to 'reflective': insight-ish types,
 *      consolidation-insight provenance, or insight/belief/reflection tags.
 *   4. Type decision/preference/fact routes to 'semantic' (this is also where
 *      consolidation PROMOTION lands - promoted patterns are semantic facts,
 *      not reflections).
 *   5. Procedural signals (how-to/SOP/step-by-step markers in content, tags,
 *      or type) route to 'procedural'. Checked after semantic so a stored
 *      decision about a procedure stays semantic.
 *   6. Default is 'episodic': observations of events and session chunks.
 *
 * Pure function: no DB, no I/O, deterministic. The same function powers the
 * live write path and the idempotent backfill migration so historical rows
 * converge to the same classification as fresh writes.
 */

export type MemorySector = 'episodic' | 'semantic' | 'procedural' | 'reflective';

export interface SectorSignals {
  /** Memory type vocabulary: observation|fact|decision|context|preference|note|task|insight|... */
  type?: string | null;
  /** Normalized (lowercase) tags. */
  tags?: string[] | null;
  /** Raw content, scanned for procedural markers only. */
  content?: string | null;
  /** Unified-knowledge kind when routing a knowledge mirror row: memory|belief|strategy. */
  knowledgeKind?: string | null;
  /** Metadata.source provenance stamp (e.g. 'consolidation-engine', 'llm-consolidator'). */
  source?: string | null;
}

/** Types that unambiguously describe durable world-knowledge. */
const SEMANTIC_TYPES = new Set(['fact', 'decision', 'preference', 'note']);

/** Insight-flavored types and tags marking consolidation-produced reflections. */
const REFLECTIVE_TYPES = new Set(['insight', 'reflection', 'learning']);
const REFLECTIVE_TAGS = new Set(['insight', 'insights', 'belief', 'beliefs', 'reflection', 'reflective', 'auto-consolidated']);
/** Provenance stamps that mark consolidation-created insights (NOT promotions). */
const REFLECTIVE_SOURCES = new Set(['llm-consolidator', 'consolidation-insight']);

/** Content/tag markers for procedure-shaped knowledge. */
const PROCEDURAL_KEYWORD_RE =
  /\b(how to|step[- ]by[- ]step|sop|procedure|runbook|workflow|release process|onboarding guide|checklist)\b/i;
/** A single enumerated item line, e.g. "1. bump version" or "2) run tests". */
const NUMBERED_ITEM_LINE_RE = /^\s*\d+[.)]\s+\w+/;

/**
 * Batch 6b fix: a lone "N. word" line is NOT enough to call content
 * procedural (false positives: version notes, quotes, references like
 * "see 2. Overview"). Require list context: at least TWO enumerated item
 * lines, OR one enumerated item plus a procedural keyword co-present.
 */
function hasEnumeratedListContext(content: string): boolean {
  const lines = content.split(/\r?\n/);
  let itemCount = 0;
  for (const line of lines) {
    if (NUMBERED_ITEM_LINE_RE.test(line)) {
      itemCount += 1;
      if (itemCount >= 2) return true; // >=2 items = real list context
    }
  }
  if (itemCount === 1 && PROCEDURAL_KEYWORD_RE.test(content)) return true;
  return false;
}

/** Content/tag markers for procedure-shaped knowledge (non-enumerated). */
const PROCEDURAL_MARKERS: RegExp[] = [
  /\bhow to\b/i,
  /\bstep[- ]by[- ]step\b/i,
  /\bsop\b/i,
  /\bprocedure\b/i,
  /\brunbook\b/i,
  /\bworkflow\b/i,
  /\brelease process\b/i,
  /\bonboarding guide\b/i,
];

export function routeSector(
  signals: SectorSignals,
  /** Explicit override - wins over every signal when present. */
  explicit?: string | null
): MemorySector {
  if (isSector(explicit)) return explicit;

  // Rule 2: strategies are procedural by definition.
  if (signals.knowledgeKind === 'strategy') return 'procedural';

  const type = (signals.type ?? '').toLowerCase();
  const tagSet = new Set((signals.tags ?? []).map(t => t.toLowerCase()));

  // Rule 3: reflective - insights/beliefs from consolidation.
  if (
    REFLECTIVE_TYPES.has(type) ||
    REFLECTIVE_SOURCES.has(signals.source ?? '') ||
    [...tagSet].some(t => REFLECTIVE_TAGS.has(t))
  ) {
    return 'reflective';
  }

  // Rule 4: semantic - durable facts/decisions/preferences. Consolidation
  // promotions land here via their fact type + auto-promoted provenance.
  if (SEMANTIC_TYPES.has(type)) return 'semantic';

  // Rule 5: procedural - how-to/SOP patterns in type, tags or content.
  if (type === 'procedure' || type === 'procedural') return 'procedural';
  if ([...tagSet].some(t => t === 'procedure' || t === 'sop' || t === 'how-to')) return 'procedural';
  const content = signals.content ?? '';
  if (!content) return 'episodic';
  if (PROCEDURAL_MARKERS.some(re => re.test(content))) return 'procedural';
  if (hasEnumeratedListContext(content)) return 'procedural';

  // Rule 6: default episodic.
  return 'episodic';
}

function isSector(value: unknown): value is MemorySector {
  return value === 'episodic' || value === 'semantic' || value === 'procedural' || value === 'reflective';
}
