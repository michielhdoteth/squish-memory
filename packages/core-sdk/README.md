# @squish/sdk

[![npm version](https://img.shields.io/npm/v/@squish/sdk)](https://www.npmjs.com/package/@squish/sdk)

Local-first memory SDK for AI agents. TypeScript SDK for building memory-powered applications with pluggable storage, embeddings, LLM, and event providers.

## Installation

```bash
npm install @squish/sdk
```

```bash
bun add @squish/sdk
```

## Quick Start

```typescript
import { SquishClient } from '@squish/sdk';

const client = new SquishClient({
  dataDir: './memory',
  project: '/path/to/project',
});

// Store a memory
await client.remember('PostgreSQL is our primary database', {
  type: 'decision',
  tags: ['database', 'infrastructure'],
  importance: 85,
});

// Recall memories by semantic similarity
const results = await client.recall('database decisions');
console.log(results.memories[0].content);

await client.close();
```

## API Reference

### SquishClient

The main client class. All async methods return Promises.

```typescript
import { SquishClient } from '@squish/sdk';

const client = new SquishClient(options?: ClientOptions);
```

#### remember(content, options?)

Store a memory in the system.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `content` | `string` | Yes | Memory content (non-empty string) |
| `options` | `RememberOptions` | No | Configuration for the memory |

**Returns:** `Promise<MemoryRecord>`

```typescript
const memory = await client.remember(
  'Use event-driven architecture for the payment service',
  {
    type: 'decision',
    tags: ['architecture', 'payments'],
    importance: 85,
    project: '/path/to/project',
    user: 'alice',
    sessionId: 'session-abc',
    metadata: { prUrl: 'https://github.com/org/repo/pull/123' },
  }
);

console.log(memory.id);       // UUID
console.log(memory.content);  // 'Use event-driven architecture...'
console.log(memory.type);     // 'decision'
console.log(memory.createdAt); // Date object
```

#### recall(query, options?)

Recall memories using intelligent routing. Automatically classifies the query and selects the optimal retrieval strategy (hybrid search, entity-aware, multi-hop, etc.).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | `string` | Yes | The recall query (non-empty) |
| `options` | `RecallClientOptions` | No | Filters and limits |

**Returns:** `Promise<RecallResult>`

```typescript
const result = await client.recall('architecture decisions', {
  limit: 5,
  type: 'decision',
  tags: ['architecture'],
  strategy: 'hybrid_search',
});

console.log(result.memories.length);      // Number of results
console.log(result.routing.strategy);     // 'hybrid_search'
console.log(result.routing.confidence);   // 0.85
console.log(result.metadata.durationMs);  // 42
console.log(result.graphEntities);        // Related entities
```

#### search(query, options?)

Search memories using hybrid vector + keyword search.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | `string` | Yes | The search query (non-empty) |
| `options` | `SearchOptions` | No | Search configuration |

**Returns:** `Promise<SearchResult[]>`

```typescript
const results = await client.search('event driven', {
  limit: 5,
  minScore: 0.3,
});

for (const result of results) {
  console.log(`${result.score.toFixed(2)}: ${result.memory.content}`);
  console.log(`  source: ${result.source}`);
}
```

#### getById(id)

Retrieve a specific memory by its UUID.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | Yes | Memory UUID |

**Returns:** `Promise<MemoryRecord | null>`

```typescript
const memory = await client.getById('550e8400-e29b-41d4-a716-446655440000');
if (memory) {
  console.log(memory.content);
  console.log(memory.type);
  console.log(memory.tags);
}
```

#### forget(id)

Permanently delete a memory by ID.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | Yes | Memory UUID to delete |

**Returns:** `Promise<boolean>` -- true if deleted

```typescript
const deleted = await client.forget('550e8400-e29b-41d4-a716-446655440000');
console.log(deleted); // true
```

#### getEntity(name, project?)

Get an entity from the knowledge graph by name, including its relations and mention count.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | Yes | Entity name to look up |
| `project` | `string` | No | Project path (uses active project if omitted) |

**Returns:** `Promise<{ entity, relations, mentionCount } | null>`

```typescript
const result = await client.getEntity('PaymentService');
if (result) {
  console.log(result.entity.name);           // 'PaymentService'
  console.log(result.entity.type);           // 'service'
  console.log(result.relations.length);      // 3
  console.log(result.mentionCount);          // 12
}
```

#### traverseGraph(name, project?, options?)

Traverse the knowledge graph from a starting entity.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | Yes | Starting entity name |
| `project` | `string` | No | Project path (uses active project if omitted) |
| `options` | `GraphOptions` | No | Traversal options |

**Returns:** `Promise<GraphTraversalResult>`

```typescript
const graph = await client.traverseGraph('PaymentService', undefined, {
  maxDepth: 2,
  limit: 20,
});

console.log(graph.nodes.length); // Connected entities
console.log(graph.edges.length); // Relationships
console.log(graph.paths.length); // Traversal paths

for (const node of graph.nodes) {
  console.log(`${node.name} (${node.type})`);
}

for (const edge of graph.edges) {
  console.log(`${edge.from} --[${edge.type}]--> ${edge.to}`);
}
```

#### getContext(options?)

Get contextual memories for the current session. Returns recent and important memories relevant to the active project.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `options` | `ContextOptions` | No | Configuration |

**Returns:** `Promise<MemoryRecord[]>`

```typescript
const context = await client.getContext({ limit: 10 });
for (const memory of context) {
  console.log(`[${memory.type}] ${memory.content}`);
}
```

#### listProjects()

List all registered projects.

**Returns:** `Promise<ProjectRecord[]>`

```typescript
const projects = await client.listProjects();
for (const project of projects) {
  console.log(`${project.name} (${project.path})`);
}
```

#### setProject(project)

Set the active project scope. All subsequent operations will use this project unless overridden.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | `string` | Yes | Project path |

```typescript
client.setProject('/path/to/my/project');
await client.remember('Project-specific memory'); // scoped to this project
```

#### stats(project?)

Get memory statistics for a project.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | `string` | No | Project path (uses active project if omitted) |

**Returns:** `Promise<MemoryStats>`

```typescript
const stats = await client.stats();
console.log(stats.totalMemories);     // 142
console.log(stats.byType);           // { decision: 23, fact: 67, ... }
console.log(stats.totalLearnings);   // 18
console.log(stats.oldestMemory);     // '2025-01-15T...'
console.log(stats.newestMemory);     // '2025-07-20T...'
console.log(stats.projectPath);      // '/path/to/project'
```

#### health()

Check the health of the memory system and its components.

**Returns:** `Promise<HealthResult>`

```typescript
const health = await client.health();
console.log(health.status); // 'ok' | 'degraded' | 'error'
console.log(health.components);
// { database: 'ok', embeddings: 'ok' }
```

#### getConfig()

Get the current configuration (frozen, read-only).

**Returns:** `Readonly<SquishConfig>`

```typescript
const config = client.getConfig();
console.log(config.dataDir);
console.log(config.project);
```

#### close()

Close the client and release resources.

```typescript
await client.close();
```

## Configuration

### ClientOptions

Options passed to the `SquishClient` constructor.

```typescript
interface ClientOptions {
  /** Data directory path (default: ~/.local/share/squish) */
  dataDir?: string;

  /** Project path for scoping memories */
  project?: string;

  /** Custom storage provider (default: SQLiteStorageProvider) */
  storage?: StorageProvider;

  /** Custom embedding provider (default: null - no embeddings) */
  embeddings?: EmbeddingProvider;

  /** Custom LLM provider (default: null - no LLM) */
  llm?: LLMProvider;

  /** Custom event bus (default: DefaultEventBus) */
  events?: EventBus;

  /** Enable lifecycle decay scoring */
  lifecycleEnabled?: boolean;

  /** Enable auto-build knowledge graph */
  graphAutoBuild?: boolean;

  /** Enable memory consolidation */
  consolidationEnabled?: boolean;
}
```

### SquishConfig

Full configuration interface with additional options.

```typescript
interface SquishConfig {
  dataDir?: string;
  project?: string;
  storage?: StorageProvider;
  embeddings?: EmbeddingProvider;
  llm?: LLMProvider;
  events?: EventBus;

  // Feature flags
  lifecycleEnabled?: boolean;
  graphAutoBuild?: boolean;
  consolidationEnabled?: boolean;
  sessionAutoLoadEnabled?: boolean;

  // Scoring weights for hybrid search
  scoringWeights?: {
    recency?: number;
    relevance?: number;
    importance?: number;
    vectorSim?: number;
    graphBoost?: number;
  };

  // Embedding configuration (used when no custom provider is given)
  embeddingConfig?: {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  };

  // LLM configuration (used when no custom provider is given)
  llmConfig?: {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    maxTokens?: number;
    temperature?: number;
  };
}
```

## Types

### MemoryType

Valid memory classification values:

```typescript
type MemoryType =
  | 'observation'
  | 'fact'
  | 'decision'
  | 'context'
  | 'preference'
  | 'note'
  | 'task';
```

### ConfidenceLevel

Confidence classification for memory records:

```typescript
type ConfidenceLevel = 'certain' | 'speculative' | 'outdated';
```

### MemoryRecord

The core memory data structure returned by all storage operations:

```typescript
interface MemoryRecord {
  id: string;
  content: string;
  type: string;
  tags: string[];
  importance: number;
  project?: string;
  sessionId?: string;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt?: Date;
  accessCount: number;
  decayScore: number;
  embedding?: Float32Array;
}
```

### RememberOptions

Options for `client.remember()`:

```typescript
interface RememberOptions {
  type?: MemoryType;
  tags?: string[];
  importance?: number;  // 0-100
  project?: string;
  user?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}
```

### SearchOptions

Options for `client.search()`:

```typescript
interface SearchOptions {
  limit?: number;
  project?: string;
  minScore?: number;  // 0-1
}
```

### RecallClientOptions

Options for `client.recall()`:

```typescript
interface RecallClientOptions {
  limit?: number;
  project?: string;
  type?: MemoryType;
  tags?: string[];
  strategy?: string;  // 'hybrid_search', 'entity_aware', etc.
}
```

### GraphOptions

Options for `client.traverseGraph()`:

```typescript
interface GraphOptions {
  maxDepth?: number;
  limit?: number;
}
```

### ContextOptions

Options for `client.getContext()`:

```typescript
interface ContextOptions {
  project?: string;
  limit?: number;
}
```

### SearchResult

Result from `client.search()`:

```typescript
interface SearchResult {
  memory: {
    id: string;
    content: string;
    type: string;
    tags: string[];
    importance: number;
    project?: string;
    createdAt: string;
    updatedAt: string;
  };
  score: number;       // 0-1 relevance score
  source: 'vector' | 'fts' | 'graph' | 'hybrid';
  explanation?: string;
}
```

### RecallResult

Result from `client.recall()`:

```typescript
interface RecallResult {
  memories: MemoryRecord[];
  graphEntities?: EntityRecord[];
  routing: {
    intent: string;
    strategy: string;
    confidence: number;
  };
  metadata: {
    totalResults: number;
    durationMs: number;
    sources: string[];
  };
}
```

### MemoryStats

Statistics from `client.stats()`:

```typescript
interface MemoryStats {
  totalMemories: number;
  byType: Record<string, number>;
  totalNotes: number;
  notesByCategory: Record<string, number>;
  totalLearnings: number;
  learningsByType: Record<string, number>;
  totalLinks: number;
  oldestMemory?: string;
  newestMemory?: string;
  projectPath: string;
  mode: string;
}
```

### Graph Types

```typescript
interface EntityRecord {
  id: string;
  name: string;
  type: string;
  description: string | null;
  properties: Record<string, unknown> | null;
}

interface EntityRelation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  fromEntityName: string;
  toEntityName: string;
  relationType: string;
  weight: number;
  properties: Record<string, unknown> | null;
}

interface GraphTraversalResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: TraversalPath[];
}

interface GraphNode {
  id: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  weight: number;
  properties?: Record<string, unknown>;
}

interface TraversalPath {
  nodes: string[];
  edges: string[];
  distance: number;
}
```

## Events

The SDK emits typed events via the `EventBus` interface. Subscribe to events for reactive patterns and monitoring.

### Subscribing to Events

```typescript
import { SquishClient } from '@squish/sdk';

const client = new SquishClient({ dataDir: './memory' });

// Subscribe via the event bus
client.events.on('memory:stored', (event) => {
  console.log('Memory stored:', event.payload.memoryId);
});

client.events.on('memory:searched', (event) => {
  console.log('Search performed:', event.payload.query, '->', event.payload.resultCount, 'results');
});

client.events.on('consolidation:completed', (event) => {
  console.log('Consolidation done:', event.payload.merged, 'merged,', event.payload.split, 'split');
});

// One-time subscription
client.events.once('graph:rebuilt', (event) => {
  console.log('Graph rebuilt for project:', event.payload.project);
});
```

### Available Events

| Event | Payload | Description |
|-------|---------|-------------|
| `memory:stored` | `{ memoryId, content, type, project? }` | A memory was stored |
| `memory:updated` | `{ memoryId, changes }` | A memory was updated |
| `memory:deleted` | `{ memoryId }` | A memory was deleted |
| `memory:searched` | `{ query, resultCount, project? }` | A search was performed |
| `learning:stored` | `{ learningId, type, content }` | A learning was stored |
| `graph:entity:created` | `{ entityId, name, type }` | A graph entity was created |
| `graph:relation:created` | `{ fromId, toId, type }` | A graph relation was created |
| `graph:rebuilt` | `{ project, stats }` | The knowledge graph was rebuilt |
| `decay:applied` | `{ affectedCount, project? }` | Decay scoring was applied |
| `consolidation:started` | `{ project? }` | Memory consolidation started |
| `consolidation:completed` | `{ project?, merged, split }` | Memory consolidation completed |
| `session:created` | `{ sessionId }` | A new session was created |
| `session:ended` | `{ sessionId, duration }` | A session ended |
| `schema:migration:started` | `{ fromVersion, toVersion }` | Schema migration started |
| `schema:migration:completed` | `{ fromVersion, toVersion, success }` | Schema migration completed |
| `health:check` | `{ status, detail }` | Health check performed |

### Custom Event Bus

Provide a custom `EventBus` implementation to the client:

```typescript
import type { EventBus, SquishEvent } from '@squish/sdk';

class LogEventBus implements EventBus {
  emit(event: SquishEvent): void {
    console.log(`[EVENT] ${event.type}`, event.payload);
  }

  on(eventType, handler) {
    // subscribe to event
    return () => {}; // unsubscribe function
  }

  off(eventType, handler) {
    // unsubscribe from event
  }

  once(eventType, handler) {
    // subscribe once
    return () => {};
  }
}

const client = new SquishClient({
  events: new LogEventBus(),
});
```

## Plugin Hooks

The SDK defines hook points for extending behavior. Hooks are typed and receive a context object.

### Available Hooks

```typescript
type PluginHook =
  | 'before:store'
  | 'after:store'
  | 'before:search'
  | 'after:search'
  | 'before:delete'
  | 'after:delete'
  | 'before:consolidate'
  | 'after:consolidate'
  | 'before:graph:build'
  | 'after:graph:build';
```

### Hook Context

Each hook receives a `PluginHookContext`:

```typescript
interface PluginHookContext {
  hook: PluginHook;
  config: SquishConfig;
  abort: () => void;        // Call to prevent default behavior
  aborted: boolean;          // Whether the operation was aborted
  metadata: Record<string, unknown>;
}
```

## Error Handling

All SDK errors extend `SquishError` and include a `code` property for programmatic handling.

### Error Classes

```typescript
import {
  SquishError,
  ConfigError,
  StorageError,
  EmbeddingError,
  LLMError,
  NotFoundError,
} from '@squish/sdk';
```

| Class | Code | When Thrown |
|-------|------|-------------|
| `SquishError` | (varies) | Base class for all SDK errors |
| `ConfigError` | `CONFIG_ERROR` | SDK is not properly configured |
| `StorageError` | `STORAGE_ERROR` | Storage operation fails |
| `EmbeddingError` | `EMBEDDING_ERROR` | Embedding operation fails |
| `LLMError` | `LLM_ERROR` | LLM operation fails |
| `NotFoundError` | `NOT_FOUND` | Resource not found (memory, entity, etc.) |

### Error Handling Example

```typescript
import {
  SquishClient,
  SquishError,
  StorageError,
  NotFoundError,
} from '@squish/sdk';

const client = new SquishClient({ dataDir: './memory' });

try {
  await client.remember('Important fact');
} catch (error) {
  if (error instanceof StorageError) {
    console.error('Storage failure:', error.message);
    console.error('Code:', error.code);
    if (error.cause) {
      console.error('Root cause:', error.cause);
    }
  } else if (error instanceof SquishError) {
    console.error('SDK error:', error.message, error.code);
  } else {
    throw error; // Re-throw unexpected errors
  }
}

try {
  const memory = await client.getById('nonexistent-id');
  if (memory === null) {
    console.log('Memory not found');
  }
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log('Not found:', error.message);
  }
}

await client.close();
```

## Custom Providers

### Custom Storage Provider

Implement the `StorageProvider` interface to use a different storage backend.

```typescript
import type { StorageProvider, StorageConfig, MemoryRecord } from '@squish/sdk';

class PostgresStorageProvider implements StorageProvider {
  readonly name = 'postgres';

  async initialize(config: StorageConfig): Promise<void> {
    // Connect to PostgreSQL
  }

  async close(): Promise<void> {
    // Disconnect
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async storeMemory(input: StoreMemoryInput): Promise<MemoryRecord> {
    // Insert into PostgreSQL
  }

  async getMemory(id: string, includeEmbedding?: boolean): Promise<MemoryRecord | null> {
    // Query by ID
  }

  async updateMemory(id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord> {
    // Update in PostgreSQL
  }

  async deleteMemory(id: string): Promise<boolean> {
    // Delete from PostgreSQL
  }

  async queryMemories(filter: MemoryFilter): Promise<MemoryRecord[]> {
    // Query with filters
  }

  async storeEmbedding(memoryId: string, vector: Float32Array): Promise<void> {
    // Store vector embedding
  }

  async getEmbedding(memoryId: string): Promise<Float32Array | null> {
    // Retrieve vector embedding
  }

  async vectorSearch(query: Float32Array, topK: number, filter?: VectorSearchFilter): Promise<VectorSearchResult[]> {
    // pgvector similarity search
  }

  async ftsSearch(query: string, topK: number, filter?: MemoryFilter): Promise<FTSResult[]> {
    // Full-text search
  }

  async storeEntity(entity: EntityInput): Promise<EntityRecord> {
    // Insert entity
  }

  async storeRelation(relation: RelationInput): Promise<EntityRelation> {
    // Insert relation
  }

  async getEntityNeighborhood(entityId: string, depth?: number): Promise<GraphTraversalResult> {
    // Graph traversal query
  }

  async findEntityPaths(fromId: string, toId: string, maxDepth?: number): Promise<TraversalPath[]> {
    // Path-finding query
  }

  async getOrCreateProject(path: string, name?: string): Promise<ProjectRecord> {
    // Upsert project
  }

  async getAllProjects(): Promise<ProjectRecord[]> {
    // List projects
  }

  async storeLearning(input: LearningInput): Promise<LearningRecord> {
    // Insert learning
  }

  async getLearnings(filter: LearningFilter): Promise<LearningRecord[]> {
    // Query learnings
  }

  async ensureSchema(): Promise<void> {
    // Run migrations
  }

  async getSchemaHealth(): Promise<SchemaHealth> {
    // Check schema version
  }
}

const client = new SquishClient({
  storage: new PostgresStorageProvider(),
});
```

### Custom Embedding Provider

Implement the `EmbeddingProvider` interface for a custom embedding backend.

```typescript
import type { EmbeddingProvider, MultimodalInput } from '@squish/sdk';

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';

  constructor(private apiKey: string) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async getDimension(): Promise<number> {
    return 1536; // text-embedding-3-small
  }

  async embed(text: string): Promise<Float32Array | null> {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: text,
        }),
      });

      const data = await response.json();
      return new Float32Array(data.data[0].embedding);
    } catch {
      return null; // Never throw, return null on failure
    }
  }

  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    const results: (Float32Array | null)[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

const client = new SquishClient({
  embeddings: new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY!),
});
```

### Custom LLM Provider

Implement the `LLMProvider` interface for a custom LLM backend.

```typescript
import type { LLMProvider, LLMCallOptions } from '@squish/sdk';

class OllamaLLMProvider implements LLMProvider {
  readonly name = 'ollama';

  constructor(
    private baseUrl = 'http://localhost:11434',
    private model = 'llama3',
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async call(options: LLMCallOptions): Promise<string | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: options.prompt,
          system: options.systemPrompt,
          options: {
            num_predict: options.maxTokens,
            temperature: options.temperature,
          },
        }),
      });

      const data = await response.json();
      return data.response;
    } catch {
      return null; // Never throw, return null on failure
    }
  }
}

const client = new SquishClient({
  llm: new OllamaLLMProvider('http://localhost:11434', 'llama3'),
});
```

## Examples

### Coding Agent Memory

An AI coding agent that remembers project decisions, bug fixes, and architectural choices.

```typescript
import { SquishClient } from '@squish/sdk';

const client = new SquishClient({
  dataDir: './agent-memory',
  project: '/home/user/my-app',
});

// After fixing a bug
await client.remember(
  'Fixed authentication timeout by increasing JWT expiry from 15min to 1hr. The short timeout was causing 401 errors on slow mobile connections.',
  {
    type: 'decision',
    tags: ['bugfix', 'authentication', 'jwt'],
    importance: 75,
    metadata: { prNumber: 234, file: 'src/auth/jwt.ts' },
  }
);

// Before implementing a new feature, recall related context
const context = await client.recall('authentication flow', { limit: 5 });
for (const mem of context.memories) {
  console.log(`[${mem.type}] ${mem.content}`);
}

// Check project stats
const stats = await client.stats();
console.log(`Project has ${stats.totalMemories} memories`);

await client.close();
```

### Team Knowledge Base

A shared memory system for a team, scoped by project.

```typescript
import { SquishClient } from '@squish/sdk';

const client = new SquishClient({
  dataDir: '/shared/squish-data',
});

// Store memories across projects
client.setProject('/projects/frontend');
await client.remember('Using TailwindCSS v4 with the new CSS-first config', {
  type: 'fact',
  tags: ['frontend', 'styling'],
  importance: 60,
});

client.setProject('/projects/backend');
await client.remember('Migrating from REST to tRPC for internal APIs', {
  type: 'decision',
  tags: ['backend', 'api'],
  importance: 90,
});

// List all projects
const projects = await client.listProjects();
for (const p of projects) {
  const s = await client.stats(p.path);
  console.log(`${p.name}: ${s.totalMemories} memories`);
}

// Cross-project search
const allDecisions = await client.search('architecture decisions', { limit: 10 });
console.log(`Found ${allDecisions.length} architecture decisions across all projects`);

await client.close();
```

### Knowledge Graph Exploration

Explore entity relationships extracted from memories.

```typescript
import { SquishClient } from '@squish/sdk';

const client = new SquishClient({
  dataDir: './memory',
  project: '/path/to/project',
});

// Store memories that mention entities
await client.remember('PaymentService depends on UserService for auth checks');
await client.remember('PaymentService calls NotificationService on successful payment');
await client.remember('UserService uses Redis for session caching');

// Look up an entity
const entity = await client.getEntity('PaymentService');
if (entity) {
  console.log(`Entity: ${entity.entity.name}`);
  console.log(`Relations: ${entity.relations.length}`);
  for (const rel of entity.relations) {
    console.log(`  ${rel.fromEntityName} --[${rel.relationType}]--> ${rel.toEntityName}`);
  }
}

// Traverse the graph
const graph = await client.traverseGraph('PaymentService', undefined, {
  maxDepth: 2,
});

console.log(`Found ${graph.nodes.length} connected entities`);
for (const path of graph.paths) {
  console.log(`Path (distance ${path.distance}): ${path.nodes.join(' -> ')}`);
}

await client.close();
```

## License

MIT
