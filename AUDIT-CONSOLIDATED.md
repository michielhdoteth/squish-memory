# Squish Memory System - Consolidated Audit Report

Generated: 2026-09-17
Scope: N+1 queries, race conditions, overengineering, dead code, embedding gaps

---

## PART 1: N+1 QUERY PATTERNS (27 issues)

### CRITICAL

| # | File | Function | Lines | Pattern | Typical N |
|---|------|----------|-------|---------|-----------|
| 19 | `core/places/memory-places.ts` | `processInbox` | 441-464 | LLM + 5x DB per memory | 10-100+ |
| 20 | `core/places/memory-places.ts` | `processInboxForAllProjects` | 485-495 | processInbox per project (meta-N+1) | 1-10+ |

### HIGH

| # | File | Function | Lines | Pattern | Typical N |
|---|------|----------|-------|---------|-----------|
| 1 | `core/memory/stale-cleaner.ts` | `runAutoClean` | 139-144 | SELECT + 3x DELETE per item in loop | 10-100+ |
| 2 | `core/memory/importance-recalc.ts` | `recalculateImportanceScores` | 66-104 | UPDATE per row in loop | 100-1000+ |
| 3 | `core/decay/decay-engine.ts` | `updateAllDecayScores` | 178-215 | UPDATE per row in loop | 100-1000+ |
| 4 | `core/memory/tiers.ts` | `recalculateTiers` | 134-150 | UPDATE per row in loop | 100-1000+ |
| 6 | `core/memory/contradiction-resolver.ts` | LLM validation | 515-523 | Sequential LLM calls | up to 5 |
| 12 | `core/memory/consolidation.ts` | `clusterMemoriesBySimilarity` | 200-238 | O(N^2) pairwise comparison | up to 10,000 |
| 16 | `core/memory/feedback-tracker.ts` | `analyzeAndRecordFeedback` | 85-111 | 3-4 DB calls per memory | 5-15 |
| 18 | `core/places/memory-places.ts` | `initializeProjectPlaces` | 367-375 | Full assign flow per memory | 10-100+ |

### MEDIUM

| # | File | Function | Lines | Pattern | Typical N |
|---|------|----------|-------|---------|-----------|
| 5 | `core/memory/contradiction-resolver.ts` | `applySupersession` | 580-582 | 3x DB calls per association | 1-5 |
| 7 | `core/memory/memory-write.ts` | entity edges | 324-334 | INSERT+SELECT per entity | 1-10 |
| 8 | `core/memory/memory-write.ts` | strategy creation | 246-264 | createKnowledge per strategy | 1-5 |
| 9 | `core/clustering/cluster-splitter.ts` | `preservePinned` | 258-267 | SELECT per memory in cluster | 3-50+ |
| 13 | `core/consolidation/llm-consolidator.ts` | `markAsProcessed` | 421-457 | SELECT+UPDATE per memory | 4-20 |
| 17 | `core/memory/feedback-tracker.ts` | `applyFizzlePenalty` | 125-127 | 2x DB calls per memory | 5-15 |
| 21 | `core/consolidation.ts` | superseded cleanup | 197-199 | DELETE per memory | 10-50+ |
| 22 | `core/consolidation.ts` | dedup per project | 150-161 | handleDetectDuplicates per project | 1-10+ |
| 23 | `core/associations.ts` | `autoLinkByEntities` | 136-143 | 3x DB calls per match | up to 10 |
| 24 | `core/associations.ts` | `trackCoactivation` updates | 258-271 | UPDATE per pair | up to 100 |

### LOW

| # | File | Function | Lines | Pattern | Typical N |
|---|------|----------|-------|---------|-----------|
| 10 | `core/clustering/cluster-splitter.ts` | split reassignment | 106-107 | findOrCreate per member | 3-50+ |
| 11 | `core/memory/consolidation.ts` | `clusterMemoriesWithEngine` | 151-155 | findOrCreate per memory | up to 100 |
| 14 | `core/consolidation/llm-consolidator.ts` | edge creation | 166-186 | createKnowledgeEdge per pair | up to 6 |
| 15 | `core/memory/feedback-tracker.ts` | `recordInjection` | 37-47 | INSERT per memory | 5-15 |
| 25 | `core/places/walking.ts` | `walkAllPlaces` | 119-124 | walkPlace per place (sequential) | 7 |
| 26 | `core/memory/memory-crud.ts` | `getMemoriesByIds` inner loop | 219-235 | `ensureMemoryScores` await per row | 5-100+ |
| 27 | `core/knowledge/knowledge-edges.ts` | `createKnowledgeEdge` | 26-57 | INSERT+SELECT per edge | 1-10 |

---

## PART 2: RACE CONDITIONS & CONCURRENCY (18 issues)

### HIGH SEVERITY

| # | File | Lines | Shared State | Issue |
|---|------|-------|-------------|-------|
| 1 | `core/consolidation.ts` | 63-69, 374-377 | `config.llmEnabled` (global) | Config mutation during concurrent maintenance runs |
| 2 | `core/clustering/cluster-engine.ts` | 31-34, 56-124 | `clusters`, `memoryToCluster` Maps (module-level) | Concurrent cluster building/mutation without synchronization |

### MEDIUM SEVERITY

| # | File | Lines | Shared State | Issue |
|---|------|-------|-------------|-------|
| 3 | `core/search/graph-boost.ts` | 63, 68-74 | `graphBackendInstance` singleton | TOCTOU race on lazy singleton init |
| 5 | `core/consolidation/llm-consolidator.ts` | 421-457 | DB metadata row (read-modify-write) | Lost-update race on JSON metadata |
| 6 | `core/graph/backend.ts` | 79-229 | `this.nodes`, `this.edges` Maps | Concurrent BFS + mutation of graph data |
| 12 | `core/memory/retrieval-feedback.ts` | 34-66, 185-248 | `feedbackBuffer` Map | Flush clears buffer while writes in progress |

### LOW SEVERITY

| # | File | Lines | Shared State | Issue |
|---|------|-------|-------------|-------|
| 4 | `core/consolidation.ts` | 357 | `useLlm` variable | Dead code; config mutated for no purpose |
| 7 | `core/embeddings/embeddings.ts` | 228-256 | `embeddingCache` Map | LRU eviction race under concurrent writes |
| 8 | `core/embeddings/embeddings.ts` | 30-32, 86-117 | `bundledModelState`, `cachedTransformersModule` | State machine TOCTOU on async model load |
| 9 | `core/retrieval/cross-encoder-reranker.ts` | 76-78, 144-184 | `rerankerPipeline`, `isLoading`, `loadPromise` | Double-load race on lazy pipeline init |
| 10 | `core/retrieval/cross-encoder-reranker.ts` | 90, 307 | `lastRerankMeta` | Concurrent searches clobber trace metadata |
| 11 | `core/scoring/three-field.ts` | 257, 307 | `thresholdRing`, `shadowRing` | Ring buffer write/drop race |
| 13 | `core/graph/backend.ts` | 214-222 | `this.nodes`, `this.edges`, `this.initialized` | `close()` during active BFS |
| 14 | `core/lib/db-client.ts` | 69, 129-130 | `cachedSchema` | Stale schema after DB reset |
| 15 | `core/worker.ts` | 118-125 | `globalWorker` singleton | Config silently ignored after first creation |
| 16 | `core/adapters/index.ts` | 15, 46 | `configDir` | Overwritten during concurrent load |
| 17 | `core/embeddings/google-multimodal.ts` | 111-112, 119-152 | `cachedAccessToken`, `tokenExpiry` | Double token refresh |
| 18 | `core/graph/incremental-sync.ts` | 51-58 | `syncCounters`, global counters | Diagnostic counter increment race |

---

## PART 3: OVERENGINEERING & DEAD CODE (18 issues)

### DEAD CODE (delete immediately)

| # | File | Lines | What | Action |
|---|------|-------|------|--------|
| 1 | `core/memory/consolidation.ts` | 186-242 | `clusterMemoriesBySimilarity` - 57-line function, zero callers | DELETE |
| 2 | `core/memory/consolidation.ts` | 305-327 | `findNearestToCentroid` - duplicates imported `findMedoid` | DELETE, use `findMedoid` |
| 3 | `core/memory/consolidation.ts` | 29-44 | Dead imports: `computeMeanCosineDistance`, `compressionSafetyTest`, `findMedoid` | REMOVE |
| 4 | `core/clustering/gac-strategy.ts` | 104-115 | `getTaskAdaptiveTheta` - exported, zero import sites | DELETE |
| 5 | `core/clustering/consolidation-check.ts` | 121 | `runSafetyTest` re-export - zero import sites | DELETE |
| 6 | `core/clustering/consolidation-check.ts` | 108-119 | `recommendRepresentatives` - exported, zero import sites | DELETE |
| 7 | `core/clustering/consolidation-check.ts` | 88-100 | `shouldSplit` - exported, zero import sites | DELETE |
| 8 | `core/clustering/cluster-splitter.ts` | entire file | All 3 exported functions have zero import sites | DELETE FILE |
| 9 | `core/clustering/cluster-splitter.ts` | 20 | Dead imports: `evaluateCluster`, `shouldConsolidate` | N/A (file deleted) |
| 10 | `core/clustering/geometry.ts` | 331-332 | `clusterSpread` alias - zero import sites | DELETE |
| 11 | `core/consolidation.ts` | 357 | `void useLlm;` - no-op statement | DELETE |

### DUPLICATE LOGIC

| # | File | Lines | What | Action |
|---|------|-------|------|--------|
| 12 | `core/clustering/geometry.ts` | 58, 79, 331 | Three names for same function | Consolidate to `computePairwiseMeanCosineDistance` |
| 13 | `core/search/graph-boost.ts` | 85-141 vs 147-182 | Duplicate boost calc in primary/fallback | Extract `sumNodeBoost()` helper |
| 14 | `core/memory/consolidation.ts` | 397-548 | Duplicate metadata construction in 3 switch cases | Extract common metadata builder |

### DEEP NESTING / COMPLEXITY

| # | File | Lines | What | Action |
|---|------|-------|------|--------|
| 15 | `core/memory/consolidation.ts` | 367-608 | `consolidateCluster` has 4 levels of nesting, 241 lines | Extract strategy functions |
| 16 | `core/search/graph-boost.ts` | 195-351 | `bfsTraverseFallback` 157 lines, interleaved knowledge edges | Extract `processKnowledgeEdges()` |

### UNNECESSARY ABSTRACTION

| # | File | Lines | What | Action |
|---|------|-------|------|--------|
| 17 | `core/clustering/consolidation-check.ts` | entire file | Unused layer in consolidation path | Evaluate removal |
| 18 | `core/consolidation.ts` | 67-69, 374-377 | `config as any` mutation | Pass as parameter |

---

## PART 4: TOP PRIORITY FIXES

### Immediate Wins (do first)

1. **Config mutation race** (Issue #1 Part 2): Stop mutating global `config`. Pass `llmEnabled` as parameter.
2. **Dead cluster-splitter.ts** (Issue #8 Part 3): Delete entire file (~275 lines).
3. **Dead `clusterMemoriesBySimilarity`** (Issue #1 Part 3): Delete 57-line dead function.
4. **Maintenance batch updates** (Issues #2-4 Part 1): Convert per-row UPDATEs to batch CASE/WHEN.
5. **processInbox LLM-per-memory** (Issue #19 Part 1): Batch memories into single LLM prompt.
6. **preservePinned N+1** (Issue #9 Part 1): Single WHERE IN query.
7. **consolidateCluster dedup** (Issue #14 Part 3): Extract common metadata builder.
8. **Geometry alias cleanup** (Issue #12 Part 3): Consolidate to single function name.
9. **Feedback buffer race** (Issue #12 Part 2): Swap-and-flush pattern.
10. **graph-boost knowledge edges** (Issue #16 Part 3): Extract into separate function.

---

## PART 5: EMBEDDING GAPS & TECHNICAL DEBT (20 issues)

### TEXT-ONLY FALLBACKS THAT SHOULD USE EMBEDDINGS

| # | File | Line | What |
|---|------|------|------|
| 1 | `core/memory/consolidation.ts` | 273 | `textSimilarity()` Jaccard fallback — embeddings exist but aren't used |
| 2 | `core/knowledge/deduplicator.ts` | 52 | `computeSimilarity()` — entire knowledge dedup uses only Jaccard |
| 3 | `core/memory/contradiction-resolver.ts` | 156 | `calculateSimilarity()` — contradiction detection uses only Jaccard |
| 4 | `core/retrieval/mmr-diversity.ts` | 162 | `applyMMRByContent()` — diversity penalty uses Jaccard |
| 5 | `core/graph/entity-deduplicator.ts` | 125 | Entity dedup tries Jaccard/substring, embeddings always null |

### INCONSISTENT EMBEDDING COLUMN USAGE

| # | File | What |
|---|------|------|
| 6 | `core/memory/consolidation.ts` (5 locations) | Reads `embedding`/`embedding_json` but NOT `embedding_blob` |
| 7 | `core/clustering/gac-strategy.ts` | Reads `embedding`/`embedding_json` but NOT `embedding_blob` |
| 8 | `core/clustering/cluster-splitter.ts` | Reads ONLY `embedding` (legacy), ignores `embedding_json` and `embedding_blob` |
| 9 | `core/graph/entity-deduplicator.ts` | `entity1.embedding` is always undefined (no such column in schema) |

### MISSING EMBEDDING GENERATION

| # | File | What |
|---|------|------|
| 10 | `core/graph/relationship-extractor.ts` | Creates entities but never generates embeddings |
| 11 | `core/ingestion/learnings.ts` | Only stores `embeddingJson`, no `embedding_blob` |
| 12 | `core/memory/consolidation.ts` | `[Consolidated]` prefixes may produce low-quality embeddings |

### EMBEDDING MODEL INCONSISTENCY

| # | File | What |
|---|------|------|
| 13 | `core/embeddings/embeddings.ts` | Dual-model (TF-IDF 768d → transformer 384d) with no cross-model guards |
| 14 | 4 subsystems | Read embeddings without checking `embedding_model` stamp |

### SCHEMA MISMATCHES

| # | File | What |
|---|------|------|
| 15 | `core/graph/entity-deduplicator.ts` | References `entity1.embedding` but entities table has no `embedding` column |
| 16 | `core/knowledge/` | Knowledge table uses legacy `embedding` blob, never upgraded to `embedding_blob` |
| 17 | `core/ingestion/learnings.ts` | Learnings table has no `embedding_blob` column |

### DEAD CODE / UNUSED PATHS

| # | File | What |
|---|------|------|
| 18 | `core/graph/entity-deduplicator.ts:237` | Module-level `similarityThreshold` never referenced |
| 19 | `core/memory/consolidation.ts:186-242` | `clusterMemoriesBySimilarity` dead function (confirmed) |
| 20 | `core/lib/embedding-codec.ts` | Double normalization in `prepareEmbedding()` — harmless but wastes CPU |

### HARDCODED THRESHOLDS (not model-aware)

| File | Line | Threshold |
|---|------|-----------|
| `entity-deduplicator.ts` | 51 | 0.85 |
| `consolidation.ts` | 94 | 0.70 |
| `consolidation.ts` | 195 | 0.55 |
| `knowledge/deduplicator.ts` | 131/161 | 0.30/0.50 |
| `two-stage-detector.ts` | 41/244 | 0.85 |
| `semantic-ranker.ts` | 24/35/114 | 0.90/0.80/0.85 |
| `graph/entity-deduplicator.ts` | 166 | 0.85 |

### SILENT ERROR SWALLOWING (7 locations)

| File | Line | Pattern |
|---|------|---------|
| `core/llm/client.ts` | 10 | All errors silently swallowed |
| `core/memory/consolidation.ts` | 703 | LLM failure catch block empty |
| `core/memory/memory-write.ts` | 333,454,661 | Multiple `catch { /* ignore */ }` |
| `core/knowledge/deduplicator.ts` | 75,81 | JSON parse failures silently dropped |
| `core/graph/graph-builder.ts` | 174 | Empty catch block |
