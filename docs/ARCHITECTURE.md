# Squish Architecture

## System Overview

Squish is a **hybrid memory runtime** for AI agents implemented as an MCP server with HTTP fallback. It combines automatic signal distillation, session working-set continuity, durable memory, and hybrid retrieval.

```
Any AI Agent
     ↓
MCP (stdio/Streamable HTTP) / CLI
     ↓
mcp/index.ts
   ├─ MCP Tools (19 registered by default; 20 with gated maintenance)
   ├─ Core Services
   │   ├─ Signal Engine
   │   ├─ Session Working Set
   │   └─ Raw Fallback Snapshotting
   ├─ Multimodal Pipeline
   │   ├─ MIME Detection (27+ types)
   │   ├─ Extractors (image, audio, video, document)
   │   └─ File Watcher
   ├─ LLM Consolidation Engine
   │   └─ Cross-connection finding
   ├─ Durable Storage
   │   ├─ QMD Search Tier (fast hybrid BM25+vector)
   │   └─ SQLite/Postgres Tier
   └─ Database Layer (Drizzle ORM)
```

## Package Structure

This repository is a single Bun package (no nested `packages/` workspace):

```
squish/
├── mcp/                    # MCP server (single entry point, no src/ layer)
│   ├── index.ts            # Main MCP entry point: 19 tools by default (20 with gated maintenance)
│   ├── tools/              # Tool registration modules (memory, team, skill, extras, dedup, edits)
│   ├── multimodal-utils.ts # File-ingestion helpers used by squish_remember
│   └── consolidation-utils.ts # LLM-consolidation helpers used by squish_stats
├── cli/                    # CLI implementation (index.ts, client.ts, program.ts)
├── bin/
│   ├── squish-mcp.mjs       # MCP server binary
│   └── squish.mjs           # CLI binary
├── core/                    # Core library (no services/ directory)
│   ├── memory/              # Memory management (memory-crud, memory-write, memory-search,
│   │                        # hybrid-search, vector-search, keyword-search, belief-search,
│   │                        # search-scoring, importance)
│   ├── retrieval/           # Query routing (decision-model-aware autoRoute), rerankers,
│   │                        # query expansion, entity-aware retrieval, temporal validity
│   ├── scoring/             # Three-field scoring, recall confidence, topical alignment
│   ├── decision-model/      # Pluggable decision backends (llm / systemone / off)
│   ├── graph/               # Knowledge graph
│   ├── search/              # Search algorithms (graph boost, QMD wrapper)
│   ├── multimodal/          # Multimodal ingestion pipeline
│   │   ├── types.ts         # Media type definitions
│   │   ├── mime-detector.ts # MIME type detection (27+ types)
│   │   ├── ingest-pipeline.ts # Ingestion orchestration
│   │   ├── watcher.ts       # File watcher for inbox monitoring
│   │   └── extractors/      # Per-type extractors
│   │       ├── base.ts
│   │       ├── image-extractor.ts
│   │       ├── audio-extractor.ts
│   │       ├── video-extractor.ts
│   │       └── document-extractor.ts
│   ├── consolidation/       # LLM consolidation engine
│   │   └── llm-consolidator.ts
│   └── ...
├── docs/                   # Documentation
├── config.ts              # Configuration with multimodal/consolidation options
├── package.json           # Single-package manifest
└── bun.lock                # Lock file
```

## Architecture Layers

### 1. MCP Server (19 tools by default, 20 with gated maintenance)

The main entry point (`mcp/index.ts`) registers 19 tools by default, plus a 20th (`squish_maintenance`) gated behind `SQUISH_ENABLE_MAINTENANCE_TOOLS=true` (returns 0 when unset). Tools cover memory management, recall, graph linking, context, inspection, stats, team/loadout/compile, skill/extract/feedback, places/sessions/tier/stale-report, dedup, and edits. Registration is split across `mcp/tools/` (memory, team, skill, extras, dedup, edits) and counted at the call sites there. `squish_sessions` also exposes `recover`, which retrieves only captured memories tagged to a session under an approximate output-token budget.

- **remember** - Store memories with auto-detection (supports multimodal file ingestion via `filePath`)
- **recall** - Query memories or get a specific memory by ID
- **forget** - Delete memory by ID or search
- **link** - Manage memory associations for graph-based reasoning
- **context** - Retrieve project context
- **stats** - Get memory statistics, system health, watcher control, and consolidation trigger (via `action` param)
- **inspect** - Explain why a memory was retained

### 2. Core Modules (no services/ directory)

Business logic lives in focused `core/` modules (this repo has no `services/` layer):

**Memory Management** (`core/memory/memory-crud.ts`, `core/memory/memory-write.ts`, `core/memory/memory-search.ts`)
- Store and retrieve memories
- Importance scoring on the write path (`core/memory/importance.ts`)

**Hybrid Search / Retrieval** (`core/memory/hybrid-search.ts` + `vector-search.ts` / `keyword-search.ts` / `belief-search.ts` / `search-scoring.ts`, `core/retrieval/*`, `core/scoring/*`)
- Full-text (FTS5) + vector (cosine) + beliefs legs, RRF fusion
- Query routing via the decision-model-aware `autoRoute` (`core/retrieval/query-router.ts`)
- Three-field scoring (semantic / boost / final) in `core/scoring/three-field.ts`

**Embeddings** (`core/embeddings.ts`, `core/embeddings/*`)
- OpenAI embeddings provider
- Ollama provider
- TF-IDF / transformers local fallback, QMD client

**Database** (`core/lib/db-client.ts`, `db/*`)
- Query builder utilities
- Connection management

**Privacy / Security** (`core/security/privacy.ts`, `core/security/secret-detector.ts`, `core/security/encrypt.ts`)
- Secret detection
- Private tag filtering
- PII filtering and at-rest encryption

### 3. Signal Engine

Squish does not write every captured event directly into durable memory. The ingestion path first classifies each event:

- `discard` for noise that should never survive
- `session-only` for active working context
- `durable-distilled` for long-lived signal
- `durable-raw+distilled` for signal that needs a distilled memory plus an internal raw fallback artifact

This keeps long-term memory denser while preserving reversibility for debugging-heavy events.

The same stage also emits:
- place-routing hints so durable memory lands in the right place
- graph-enrichment hints so only durable signal feeds relationship extraction
- wake-up priority so session context is compact but relevant

### 4. Multimodal Pipeline

Squish ingests images, audio, video, and documents through a modular pipeline:

```
File Drop (inbox/) ─or─ squish_remember (with filePath)
         ↓
    MIME Detection (27+ extensions)
         ↓
    Category Routing: image | audio | video | document
         ↓
    Extractor (per-type):
      ├─ Image: metadata extraction (dimensions, format)
      ├─ Audio: speech-to-text transcript
      ├─ Video: keyframe extraction + speech-to-text
      └─ Document: text extraction (PDF, DOCX, CSV, etc.)
         ↓
    LLM Description Generation
         ↓
    Embedding Generation
         ↓
    Memory Record + Search Index
```

**Supported file types (27+):**
- Images: JPEG, PNG, GIF, WebP, SVG, BMP, TIFF, ICO, HEIC, HEIF
- Audio: MP3, WAV, OGG, FLAC, M4A, AAC, WMA, Opus
- Video: MP4, WebM, AVI, MOV, MKV, WMV, FLV
- Documents: PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT, MD, CSV, TSV, JSON, JSONL, XML, YAML, YML, TOML, HTML, RTF

The file watcher monitors the inbox directory at a configurable poll interval and automatically processes new files.

### 5. LLM Consolidation Engine

LLM consolidation finds cross-connections between memory clusters that algorithmic consolidation would miss:

1. **Batch selection**: Memories older than `minAgeDays` with fewer than `minConnections` existing edges
2. **LLM analysis**: Sends memory clusters to the configured LLM provider (OpenAI, Anthropic, or Gemini)
3. **Connection creation**: Creates knowledge edges for identified cross-connections
4. **Status tracking**: Reports connections found, created, and errors

Enabled via `SQUISH_LLM_CONSOLIDATION_ENABLED=true` and requires an LLM API key.

### 6. Durable Storage Layer

Squish implements multi-layer storage for optimal performance:

**Optional QMD Fast Search**
- QMD subprocess access is disabled by default; set `SQUISH_QMD_ENABLED=true` to opt in.
- First use may download local GGUF models, so enabling QMD can use the network.
- Quick Markdown Search provides hybrid BM25 + vector search
- Automatic indexing of memory files as markdown
- Sub-second search response times
- Configurable collections per memory type

**SQLite/PostgreSQL Persistent Storage**
- **Local Mode**: SQLite database with full durability
- **Team Mode**: Squish Cloud-managed PostgreSQL with pgvector for semantic search
- Drizzle ORM for type-safe database access
- Full-text search with FTS5 (SQLite) or pg_trgm (Postgres)

**SQLite Schema** (`db/drizzle/schema-sqlite.ts`)
- For local mode
- JSON embeddings for vector search fallback

**PostgreSQL Schema** (`db/drizzle/schema.ts`)
- For Squish Cloud team mode
- pgvector for semantic search

### 7. Storage Modes

**Local Mode (Default)**
- Single SQLite database
- No configuration needed
- Full-text search with FTS5
- Embeddings stored as JSON

**Team Mode**
- Squish Cloud PostgreSQL for persistent storage
- Redis for caching
- pgvector for semantic search
- Supports concurrent access

## Plugin System

Squish integrates with agent runtimes via plugin hooks (per-runtime folders under `plugin/`):

**Hooks** (`plugin/claude-code/hooks/hooks.json` + `plugin/claude-code/scripts/session-*.sh`, `plugin/codex/hooks.json`, `plugin/opencode/index.ts`, `plugin/openclaw/index.ts`)
- `onInstall` - Initialize on first run
- `onSessionStart` - Start auto-capture
- `onUserPromptSubmit` - Capture user input
- `onPostToolUse` - Capture tool results
- `onSessionStop` - Save state on exit

**Auto-Capture** (`core/ingestion/signal-engine.ts`, driven by the runtime plugins above)
- Debounced capture (2 seconds)
- Distillation and suppression before durable writes
- Session working-set updates
- Place routing for durable memory and place cues for session-only context
- Incremental graph enrichment for durable writes
- Raw fallback snapshotting for nuance-sensitive events

**Context Injection** (`plugin/opencode/index.ts` and `plugin/openclaw/index.ts`, reading `core/context/context-window.ts`)
- Generate CLAUDE.md files
- Project context extraction

## Data Flow

### Memory Storage

```
User Input / Tool Output / Media File
         ↓
Signal Distillation / MIME Detection
         ├─ discard
         ├─ session-only → context_sessions working set + active place / graph cues
         └─ durable → write gate → memory record
                                   ├─ place assignment
                                   ├─ graph enrichment
                                   ├─ optional raw fallback snapshot
                                   └─ database + search index
```

### Multimodal Ingestion

```
File in inbox/ ─or─ squish_remember (with filePath)
         ↓
MIME Detection → Category (image/audio/video/document)
         ↓
Per-type Extractor (text, transcript, metadata)
         ↓
LLM Description + Embedding
         ↓
Memory Record → database + search index
```

### Search

```
Query → Normalize → Split into:
  ├─ Full-text search (FTS5/PostgreSQL FTS)
  └─ Semantic search (Embeddings + pgvector)
                      ↓
                  Combine & Rank
                      ↓
                  Return Results
```

## Technology Stack

**Runtime**
- Node.js >=18
- Bun (for development)

**Database**
- SQLite (local) with FTS5
- PostgreSQL (team) with pgvector
- Drizzle ORM

**Search**
- FTS5 (full-text search)
- pgvector (semantic search)
- TF-IDF (local embeddings)

**APIs**
- OpenAI (embeddings)
- Ollama (local embeddings)

**Caching**
- Redis (Squish Cloud team mode)
- In-memory (local mode)

**Web**
- Express.js
- WebSocket for real-time updates

## Performance Characteristics

Performance depends on corpus size, database backend, hardware, and enabled retrieval paths. The project does not publish a general-purpose latency or throughput guarantee. See [`BENCHMARK.md`](BENCHMARK.md) for the scope and limitations of the reproducible retrieval diagnostics.

## Environment Variables

```bash
# Embeddings
SQUISH_EMBEDDINGS_PROVIDER=openai|ollama|none
SQUISH_OPENAI_API_KEY=sk-...
SQUISH_OLLAMA_URL=http://localhost:11434

# Database (Squish Cloud team mode)
DATABASE_URL=postgres://user:pass@localhost/squish
REDIS_URL=redis://localhost:6379

# Web UI
SQUISH_WEB_PORT=37777

# Memory
# Local memory count has no product-imposed cap; storage is bounded by available device space.
SQUISH_CACHE_TTL=300

# Multimodal Ingestion
SQUISH_MULTIMODAL_ENABLED=true
SQUISH_MULTIMODAL_INBOX_DIR=./inbox
SQUISH_MULTIMODAL_POLL_INTERVAL_MS=5000
SQUISH_MULTIMODAL_MAX_FILE_SIZE_BYTES=104857600

# LLM Consolidation
SQUISH_LLM_CONSOLIDATION_ENABLED=false
SQUISH_LLM_CONSOLIDATION_BATCH_SIZE=50
SQUISH_LLM_CONSOLIDATION_MIN_AGE_DAYS=7
SQUISH_LLM_CONSOLIDATION_MIN_CONNECTIONS=2
```

## Debugging

Enable debug logs (no build step; the server runs from source):
```bash
DEBUG=squish:* bun mcp/index.ts   # or: npm run mcp
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.
