# Squish Release Notes

## v2.0.0 -- 2026-07-15

### Summary

Multimodal ingestion, LLM cross-connection consolidation, and enhanced 15-tool (+1 gated) MCP surface.

### Highlights

#### Multimodal Ingestion Pipeline
- Ingest images, audio, video, and documents into searchable memories
- 27+ supported file types across four categories
- Automatic text extraction via OCR, speech-to-text, and document parsing
- LLM-generated descriptions for each ingested file
- File watcher for automatic inbox directory monitoring

#### LLM Consolidation Engine
- Cross-connection finding between memory clusters using LLM analysis
- Supports OpenAI, Anthropic, and Gemini providers
- Batch processing with configurable age and connection thresholds
- Dry-run mode for analysis without creating knowledge edges

#### Enhanced MCP Tools
- `squish_remember` -- Now supports multimodal file ingestion via `filePath` parameter (27+ file types); `content` is now optional
- `squish_stats` -- Now supports `action` parameter for watcher control (`start_watcher`, `stop_watcher`) and LLM consolidation (`consolidate`)

### Configuration

New settings.json sections:
- `multimodal.*` -- Inbox dir, poll interval, max file size, enabled state
- `consolidation.*` -- LLM enabled, batch size, min age, min connections

New environment variables:
- `SQUISH_MULTIMODAL_ENABLED`, `SQUISH_MULTIMODAL_INBOX_DIR`, `SQUISH_MULTIMODAL_POLL_INTERVAL_MS`, `SQUISH_MULTIMODAL_MAX_FILE_SIZE_BYTES`
- `SQUISH_LLM_CONSOLIDATION_ENABLED`, `SQUISH_LLM_CONSOLIDATION_BATCH_SIZE`, `SQUISH_LLM_CONSOLIDATION_MIN_AGE_DAYS`, `SQUISH_LLM_CONSOLIDATION_MIN_CONNECTIONS`

---

## Landing Site -- 2026-07-13

### Summary

SEO and AI search optimization improvements for squishplugin.dev. Pricing documentation corrected across all manifest and LLM-friendly files.

### Highlights

#### Structured Data
- Added `aggregateRating` + `review` schema to SoftwareApplication JSON-LD in `index.html`
- Added `BreadcrumbList` JSON-LD schema (Home > Documentation > Privacy > Terms) for richer search results

#### Per-Route SEO
- New `hooks/useSEO.ts` provides unique `<title>`, `<meta description>`, and canonical URLs per page:
  - `/docs` -- "Documentation | Squish - Memory Runtime for AI Agents"
  - `/privacy` -- "Privacy Policy | Squish - Memory Runtime for AI Agents"
  - `/terms` -- "Terms of Service | Squish - Memory Runtime for AI Agents"

#### AI Search Optimization (AEO/GEO/GSO)
- Added `twitter:site` handle (`@4mlabs_io`) and fixed `twitter:*` tags to use `name` attribute (per Twitter card spec)
- Switched `og:image` from SVG to PNG for broader platform compatibility
- Updated `sitemap.xml` with `/privacy` and `/terms` URLs and refreshed `lastmod` dates
- Added `Cache-Control` header to `vercel.json` for root page

#### Pricing Accuracy
- Fixed pricing across 4 files to match actual site tiers:
  - `llms.txt`, `llms-full.txt`, `.well-known/ucp`, `.well-known/acp.json`
  - Corrected tiers: Free/$0, Solo/$9/mo, Pro/$29/mo, Team/$99/mo

#### Marketing
- Added `CompetitorComparison` component to the marketing page (between Differentiator and Pricing sections)

---

## v1.9.0

### Summary

Advanced retrieval pipeline, sleep-time consolidation, and repo security hardening. MCP tool surface expanded from 7 to 15 tools (+1 gated).

### Highlights

#### Advanced Retrieval Pipeline
- Query expansion, entity-aware reranking, contextual enrichment, MMR diversity
- Cross-encoder reranking with tuned defaults (topK 100 -> 30 for interactive use)
- Unified `hybridSearch` with per-stage latency tracking

#### Sleep-Time Consolidation
- Background dedup, summarize, invalidate stale memories, decay (runs automatically)
- Strategies table auto-creates on first use

#### Performance
- Batch graph boost BFS, parallelized association loading, cached DB results
- Query embedding cache avoids redundant API calls

#### Security Cleanup
- Removed internal PLAN.md (297-line implementation plan), test data salt, and launch readiness doc from git
- Gitignore hardened: `.test-data*/`, `PLAN.md`, `plans/`, `wiki/`, `~/`

### User-Facing Impact

#### CLI
- 15-tool (+1 gated) MCP surface

#### MCP
- Expanded from 7 to 15 tools (+1 gated): remember, recall, forget, link, context, stats, inspect, skill, loadout, extract, feedback, places, sessions, tier, dedup
- Session hooks auto-wire on server init (no agent-callable tools needed)
- Strategy system integrated into recall, remember, and auto-load

---

## v1.6.0

### Summary

Session search across Claude Code and Codex. Agents can now search previous session history as evidence, not just recall durable memory.

### Highlights

#### Claude Code Session Search
- Reads `~/.claude/history.jsonl` and per-session JSONL files
- Full text search across session messages
- Related session discovery by project path overlap

#### Codex Session Search
- Reads `~/.codex/state_5.sqlite` threads table
- Deep search via rollout JSON files
- Related session discovery by cwd and git remote

#### Three-Tool Mental Model
The product surface is now three clean layers:
- **recall** — durable memory (decisions, preferences, constraints)
- **sessions** — evidence from past agent runs (searchable history)
- **remember** — write to long-term memory

### User-Facing Impact

#### CLI
- New: `squish sessions list` — list past agent sessions
- New: `squish sessions search <query>` — full-text search across session history
- New: `squish sessions show <id>` — display session detail
- New: `squish sessions related` — find sessions relevant to current repo/files
- New: `squish sessions capture` — record a session summary
- New: `squish sessions status` — show which agent stores are available

#### MCP
- Improved: `squish_session_search` now searches Claude Code and Codex stores
- Improved: `squish_sessions_status` shows all available agent stores

---

## v1.5.0

### Summary

Schema fixes, plugin system improvements, tier removal, multi-place routing, and enhanced retrieval quality.

### Highlights

#### Schema & Storage Fixes
- Fixed schema inconsistencies across SQLite and PostgreSQL
- Removed tier system in favor of unified memory storage
- Improved migration safety for schema changes

#### Plugin System
- Refactored plugin architecture for better extensibility
- Improved client detection and installation flow

#### Multi-Place Routing
- Memories can now be routed to multiple places based on content signals
- Tag-aware retrieval for more precise memory recall
- Supersession filtering to reduce noise in search results

#### Trace Metadata
- Added trace metadata for debugging memory operations
- Improved inspect tool with detailed routing information

### User-Facing Impact

#### CLI
- Improved: `squish inspect` with trace metadata
- Fixed: `squish stats` accuracy

#### MCP
- Improved: `squish_inspect` with routing details
- Improved: `squish_recall` with tag filtering

---

## v1.3.0

### Summary

Stats fix, cloud-api rename, graph export, cold-only cloud sync, MEMORY.md hot tier, hook scripts, and security fixes.

### Highlights

#### Stats Fix
- Fixed memory statistics calculation for accurate counts

#### Cloud API Rename
- Renamed cloud API endpoints for consistency

#### Graph Export
- Added ability to export knowledge graph data

#### Cold-Only Cloud Sync
- Cloud sync now only handles cold storage, reducing bandwidth usage

#### MEMORY.md Hot Tier
- MEMORY.md files now participate in the hot memory tier
- Faster access to frequently referenced documentation

#### Hook Scripts
- Added hook scripts for session lifecycle events
- Improved plugin integration with coding assistants

#### Security Fixes
- Patched secret detection bypass vulnerabilities
- Improved PII filtering accuracy

### User-Facing Impact

#### CLI
- New: `squish export` for graph data
- Fixed: `squish stats` accurate counting

#### MCP
- Improved: `squish_health` with cloud sync status

---

## v1.2.0

Planned release date: 2026-04-19

## Summary

This release turns Squish from a command-heavy memory store into a more automatic memory runtime. The main theme is better signal quality: capture broadly, suppress noise, keep session-only state local, store cleaner durable memory, and wake agents up with useful context instead of raw history.

## Highlights

### Signal-Aware Memory Runtime
- Captured events are classified before durable write: `discard`, `session-only`, `durable-distilled`, or `durable-raw+distilled`
- Session working-set state now tracks active files, recent commands, failures, hypotheses, active places, and lightweight graph cues
- Nuance-sensitive durable events can retain linked raw fallback artifacts for inspection and rewind

### Places And Graph In The Same Loop
- Durable writes now participate in place routing and incremental graph enrichment
- Session wake-up prioritizes compact working-set state over generic recent-memory dumps
- Retrieval prefers cleaner distilled memory while preserving reversibility where raw fallback exists

### Trust-Focused CLI And MCP Surfaces
- Added `squish health`
- Added `squish inspect` and MCP `squish_inspect`
- `squish context`, `squish stats`, `squish health`, and `squish doctor` now explain current project, runtime state, degradation, and next step
- Legacy placeholder `.` projects are hidden from normal runtime views
- Legacy memories now inspect as `legacy-durable` instead of `unknown`

## User-Facing Impact

### CLI
- New: `squish health`
- New: `squish inspect <id>`
- Improved: `squish context`
- Improved: `squish stats`
- Improved: `squish doctor`

### MCP
- New: `squish_inspect`
- Improved: `squish_context`
- Improved: `squish_health`
- Improved: `squish_stats`

## Verification Used For Release Prep

- `bun test tests/core/trust-report.test.ts tests/core/trust-state.test.ts tests/core/memory-explain.test.ts tests/core/session-working-set.test.ts tests/core/signal-engine.test.ts tests/core/write-gate.test.ts`
- `squish doctor`
- `squish doctor --json`
- `squish context --json --limit 2`
- `squish stats`
- `squish inspect <legacy-memory-id>`
- `squish-mcp --health`

## Notes

- Empty-state runtime status can still show `degraded` before any real capture has happened; that is an initialization-state signal, not a crash signal.
- Repo-local helper files used during development were left untouched unless they are part of the shipping surface.
