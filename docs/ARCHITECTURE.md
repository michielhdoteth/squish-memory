# Squish Architecture

## System Overview

Squish is a **hybrid memory runtime** for AI agents implemented as an MCP server with HTTP fallback. It combines automatic signal distillation, session working-set continuity, durable memory, and hybrid retrieval.

```
Any AI Agent
     ↓
MCP (stdio/Streamable HTTP) / CLI
     ↓
packages/mcp/src/index.ts
   ├─ MCP Tools (16 tools incl. gated maintenance)
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

The repository is organized as a Bun workspace:

```
squish/
├── packages/
│   ├── mcp/                 # MCP server package
│   │   ├── src/
│   │   │   ├── index.ts      # Main MCP entry point (16 tools incl. gated maintenance)
│   │   │   ├── multimodal-tools.ts   # Multimodal ingestion tools
│   │   │   └── consolidation-tools.ts # LLM consolidation tools
│   │   └── package.json
│   └── cli/                  # CLI package
│       ├── src/
│       │   └── index.ts     # CLI entry point
│       └── package.json
├── bin/
│   ├── squish-mcp.mjs       # MCP server binary
│   └── squish.mjs           # CLI binary
├── core/                    # Core library
│   ├── memory/              # Memory management
│   ├── graph/               # Knowledge graph
│   ├── search/             # Search algorithms
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
├── package.json           # Root workspace
└── bun.lock                # Lock file
```

## Architecture Layers

### 1. MCP Server (15 Tools + 1 gated)

The main entry point (`packages/mcp/src/index.ts`) defines 15 MCP tools by default, with a 16th (squish_maintenance) gated behind `SQUISH_ENABLE_MAINTENANCE_TOOLS=true`. Tools cover memory management, recall, graph linking, context, inspection, multimodal ingestion, and LLM consolidation.

- **remember** - Store memories with auto-detection (supports multimodal file ingestion via `filePath`)
- **recall** - Query memories or get a specific memory by ID
- **forget** - Delete memory by ID or search
- **link** - Manage memory associations for graph-based reasoning
- **context** - Retrieve project context
- **stats** - Get memory statistics, system health, watcher control, and consolidation trigger (via `action` param)
- **inspect** - Explain why a memory was retained

### 2. Services Layer

Business logic is separated into focused services:

**Memory Management** (`services/memories.ts`)
- Store and retrieve memories
- Handle embeddings
- Privacy filtering

**Search** (`services/conversations.ts`)
- Search conversations
- Full-text search
- Semantic search

**Observations** (`services/observations.ts`)
- Track tool usage
- Record observations

**Embeddings** (`services/embeddings.ts`)
- OpenAI embeddings provider
- Ollama provider
- TF-IDF fallback

**Database** (`services/database.ts`)
- Query builder utilities
- Connection management

**Cache** (`services/cache.ts`)
- Redis cache layer
- Memory cache fallback

**Privacy** (`services/privacy.ts`)
- Secret detection
- Private tag filtering
- PII filtering

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

**QMD Fast Search**
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

Squish integrates with Claude Code via plugin hooks:

**Hooks** (`plugin/plugin-wrapper.ts`)
- `onInstall` - Initialize on first run
- `onSessionStart` - Start auto-capture
- `onUserPromptSubmit` - Capture user input
- `onPostToolUse` - Capture tool results
- `onSessionStop` - Save state on exit

**Auto-Capture** (`plugin/capture.ts`)
- Debounced capture (2 seconds)
- Distillation and suppression before durable writes
- Session working-set updates
- Place routing for durable memory and place cues for session-only context
- Incremental graph enrichment for durable writes
- Raw fallback snapshotting for nuance-sensitive events

**Context Injection** (`plugin/injection.ts`)
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

- **Memory operations**: ~2.6M ops/sec
- **FTS5 queries**: ~10,000 ops/sec
- **pgvector search**: 5k-50k ops/sec
- **Web UI**: Real-time updates

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
SQUISH_MAX_MEMORIES=10000
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

Enable debug logs:
```bash
DEBUG=squish:* node dist/src/index.js
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.
