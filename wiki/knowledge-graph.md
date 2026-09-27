# Knowledge Graph

## Overview

The knowledge graph module extracts entities and relationships from memories, stores them in a graph structure, and supports traversal, deduplication, and multi-hop retrieval.

## Module Location

`core/graph/`

## Core Files

| File | Purpose |
|------|---------|
| `pipeline.ts` | Orchestrator: full-project and single-memory graph building |
| `incremental-sync.ts` | Auto-enriches graph on every memory write |
| `graph-builder.ts` | Low-level entity/relation extraction and storage |
| `entity-deduplicator.ts` | Merges duplicate entities by similarity |
| `relationship-extractor.ts` | Extracts and stores relations from memory content |
| `llm-entity-extractor.ts` | LLM-based entity/relation extraction |
| `graph-traversal.ts` | BFS/DFS traversal, path finding, neighborhood queries |
| `multi-hop-retrieval.ts` | Multi-hop graph search with vector fusion |
| `backend.ts` | In-memory graph backend abstraction |
| `export.ts` | Graph visualization export |
| `index.ts` | Barrel exports |

## Pipeline (`pipeline.ts`)

### Functions

```typescript
// Full project pipeline: extract all memories -> build graph -> dedup
buildProjectGraph(projectPath: string, options?: PipelineOptions): Promise<PipelineStats>

// Single memory pipeline: extract one memory -> add to graph
buildMemoryGraph(memoryId: string, options?: { preferLLM?: boolean }): Promise<PipelineResult>

// Stats aggregator: entity count, relation count, last pipeline time
getGraphPipelineStats(projectPath: string): Promise<ProjectPipelineStats>
```

### Types

```typescript
interface PipelineOptions {
  clearExisting?: boolean;      // Clear graph before rebuild
  batchSize?: number;           // Memories per batch (default: 10)
  preferLLM?: boolean;          // Use LLM extraction (default: config.llmEnabled)
  deduplicate?: boolean;        // Run dedup after extraction (default: true)
  onProgress?: (progress: PipelineProgress) => void;
}

interface PipelineProgress {
  phase: 'extract' | 'store' | 'dedup' | 'done';
  processed: number;
  total: number;
  entitiesCreated: number;
  relationsCreated: number;
}

interface PipelineStats {
  memoriesProcessed: number;
  entitiesCreated: number;
  relationsCreated: number;
  entitiesDeduplicated: number;
  errors: number;
  durationMs: number;
  extractionSource: 'llm' | 'regex' | 'mixed';
}

interface PipelineResult {
  memoryId: string;
  entitiesCreated: number;
  relationsCreated: number;
  source: 'llm' | 'regex' | 'none';
  durationMs: number;
}

interface ProjectPipelineStats {
  entityCount: number;
  relationCount: number;
  relationTypes: Record<string, number>;
  avgConnections: number;
  lastPipelineAt: Date | null;
}
```

### Pipeline Stages (buildProjectGraph)

1. Resolve project ID from path
2. Optionally clear existing graph (`clearExisting`)
3. Fetch all project memories
4. For each memory (batched): call `extractAndStoreRelations()`
5. If `deduplicate`: call `deduplicateProjectEntities()`
6. If `config.graphAutoExport`: trigger graph visualization export
7. Return `PipelineStats`

### Import Path

```typescript
import { buildProjectGraph, buildMemoryGraph, getGraphPipelineStats } from '../graph/pipeline.js';
```

## Incremental Sync (`incremental-sync.ts`)

### Purpose

Automatically enriches the knowledge graph when new memories are stored. Runs dedup periodically (not on every write) to keep the graph clean.

### Functions

```typescript
// Hook called after memory storage. Extracts entities, runs periodic dedup.
onMemoryStored(memoryId: string, options?: SyncOptions): Promise<SyncResult>

// Cumulative sync stats for a project
getSyncStats(projectPath: string): Promise<SyncStats>

// Reset dedup counter (useful after manual graph operations)
resetSyncCounter(projectPath: string): void
```

### Types

```typescript
interface SyncOptions {
  project?: string;             // Project path for context
  dedupThreshold?: number;      // Entities before dedup triggers (default: 10)
  forceDedup?: boolean;         // Force dedup regardless of threshold
}

interface SyncResult {
  memoryId: string;
  entitiesCreated: number;
  relationsCreated: number;
  dedupRan: boolean;
  entitiesDeduplicated?: number;
  source: 'llm' | 'regex' | 'fallback' | 'none';
  durationMs: number;
}

interface SyncStats {
  totalSynced: number;
  totalEntitiesCreated: number;
  totalRelationsCreated: number;
  totalDedupsRun: number;
  lastSyncAt: string | null;
  entitiesSinceLastDedup: number;
}
```

### How It Works

1. Calls `addMemoryToGraph(memoryId)` to extract and store entities/relations
2. Resolves project ID (from options or from the memory row in DB)
3. Increments per-project entity counter in module-level `Map<string, number>`
4. When counter exceeds `dedupThreshold` (default 10) or `forceDedup` is set:
   - Calls `deduplicateProjectEntities(projectId)`
   - Resets counter to 0
5. Updates global stats (totalSynced, totalEntitiesCreated, etc.)

### Wiring

Called from `memories.ts:rememberMemory()`:

```typescript
// core/memory/memories.ts, line ~321
if (config.graphAutoBuild && project?.id) {
  const syncResult = await onMemoryStored(id, { project: input.project });
}
```

### Import Path

```typescript
import { onMemoryStored, getSyncStats, resetSyncCounter } from '../graph/incremental-sync.js';
```

## Graph Builder (`graph-builder.ts`)

### Functions

```typescript
addMemoryToGraph(memoryId: string, options?: { preferLLM?: boolean }): Promise<GraphAddStats>
buildGraphForProject(projectPath: string, options?: PipelineOptions): Promise<GraphBuildStats>
getGraphStats(projectPath: string): Promise<ProjectPipelineStats>
```

### Import Path

```typescript
import { addMemoryToGraph, buildGraphForProject, getGraphStats } from '../graph/graph-builder.js';
```

## Entity Deduplicator (`entity-deduplicator.ts`)

### Function

```typescript
deduplicateProjectEntities(projectId: string): Promise<DeduplicationResult>
```

### Import Path

```typescript
import { deduplicateProjectEntities } from '../graph/entity-deduplicator.js';
```

## Multi-Hop Retrieval (`multi-hop-retrieval.ts`)

### Functions

```typescript
multiHopSearch(options: MultiHopSearchOptions): Promise<MultiHopResult>
needsMultiHop(query: string): boolean
explainRetrievalPath(result: MultiHopResult): string
```

### Import Path

```typescript
import { multiHopSearch, needsMultiHop, explainRetrievalPath } from '../graph/multi-hop-retrieval.js';
```

## Related Pages

- [Architecture MOC](architecture-moc.md)
- [Storage Facade](storage-facade.md)
- [Data Flow](data-flow.md)
