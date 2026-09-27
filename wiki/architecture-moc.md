# Architecture Map of Content

## Overview

Squish Memory is a triple-layer memory system combining relational SQL, vector embeddings, and a knowledge graph. The architecture is organized into core modules under `squish/core/`.

## Module Index

| Module | Path | Purpose |
|--------|------|---------|
| Graph Pipeline | `core/graph/pipeline.ts` | Orchestrates full/incremental graph construction |
| Incremental Sync | `core/graph/incremental-sync.ts` | Auto-enriches graph on every memory write |
| Session Bridge | `core/bridge/session-bridge.ts` | Bridges session-captured memories to permanent graph |
| Query Router | `core/retrieval/query-router.ts` | Classifies query intent, selects retrieval strategy |
| Storage Facade | `core/storage/storage-facade.ts` | Unified API over relational + vector + graph |
| Hybrid Search | `core/memory/hybrid-search.ts` | Vector + keyword search with RRF fusion |
| Graph Builder | `core/graph/graph-builder.ts` | Entity/relation extraction and storage |
| Entity Deduplicator | `core/graph/entity-deduplicator.ts` | Merges duplicate entities |
| Multi-Hop Retrieval | `core/graph/multi-hop-retrieval.ts` | Graph-based multi-hop traversal |
| Entity-Aware Retrieval | `core/retrieval/entity-aware-retrieval.ts` | Entity extraction + boost scoring |
| Contextual Enrichment | `core/retrieval/contextual-enrichment.ts` | Prefix enrichment for embeddings |
| Memories CRUD | `core/memory/memories.ts` | Core memory write/read/search logic |
| Session Hooks | `core/session/session-hooks.ts` | Session lifecycle (start/end) |
| Associations | `core/associations.ts` | Inter-memory linking via entity overlap |

## Architecture Diagram

```
+-------------------+     +-------------------+     +-------------------+
|   Relational DB   |     |  Vector Embeddings|     |  Knowledge Graph  |
|  (SQLite / PG)    |     |  (cosine search)  |     |  (entities+edges) |
+--------+----------+     +--------+----------+     +--------+----------+
         |                         |                         |
         +------------+------------+------------+------------+
                      |                         |
              +-------v--------+       +--------v--------+
              | Storage Facade |       |  Query Router   |
              | (unified API)  |       | (intent classif) |
              +-------+--------+       +--------+--------+
                      |                         |
              +-------v-------------------------v--------+
              |          Hybrid Search / Recall          |
              |  (vector + keyword + RRF + entity boost) |
              +-------------------+---------------------+
                                  |
                    +-------------v--------------+
                    |     memories.ts:search()   |
                    |  (main search entry point)  |
                    +----------------------------+
```

## Data Flow: Memory Write

```
User writes memory
  -> memories.ts:rememberMemory()
    -> storeMemory() (relational DB insert)
    -> onMemoryStored() (incremental-sync.ts)
      -> addMemoryToGraph() (entity extraction + storage)
      -> periodic dedup every N entities (threshold-based)
    -> autoLinkByEntities() (association creation)
    -> resolveContradictions() (supersession)
```

## Data Flow: Memory Search

```
User searches
  -> memories.ts:search()
    -> autoRoute() (query-router.ts)
      -> classifyQuery() - regex-based intent detection
      -> maps intent -> retrieval strategy
    -> hybridSearch() with strategy hint
      -> vector search + keyword search
      -> RRF fusion
      -> entity boost, graph boost, place scoring
```

## Data Flow: Session End

```
Session ends
  -> session-hooks.ts:onSessionEnd()
    -> marks conversation ended
    -> bridgeSessionToGraph() (fire-and-forget)
      -> queries durable session memories
      -> addMemoryToGraph() for each
      -> autoLinkByEntities() for associations
```

## Barrel Exports

| Barrel | Exports |
|--------|---------|
| `core/graph/index.ts` | All graph modules: pipeline, builder, traversal, dedup, multi-hop, backend |
| `core/bridge/index.ts` | `bridgeSessionToGraph`, `getBridgeStats` |
| `core/storage/index.ts` | `storeMemory`, `getMemoryById`, `queryMemories`, `recall`, entity/graph/strategy ops |
| `core/retrieval/index.ts` | Query router, entity-aware, contextual enrichment, cross-encoder reranker |

## Related Pages

- [Knowledge Graph](knowledge-graph.md) -- pipeline + incremental sync details
- [Session Management](session-management.md) -- session bridge details
- [Query Router](query-router.md) -- intent classification and strategy selection
- [Storage Facade](storage-facade.md) -- triple-layer unified API
- [Data Flow](data-flow.md) -- detailed flow diagrams
- [Deleted Modules](deleted-modules.md) -- removed code and rationale
