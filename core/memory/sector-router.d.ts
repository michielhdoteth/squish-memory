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
export declare function routeSector(signals: SectorSignals, 
/** Explicit override - wins over every signal when present. */
explicit?: string | null): MemorySector;
//# sourceMappingURL=sector-router.d.ts.map