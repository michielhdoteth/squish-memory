# Squish Codebase Map (post-Batch 8)

## Project Structure Overview

```
squish/
├── core/                      # Core business logic
│   ├── acl/                   # Access control + visibility rules
│   ├── adapters/              # External service adapters
│   ├── algorithms/            # KEEP dedup workflow: detection -> proposals -> approve/reject/reverse
│   ├── associations.ts        # Memory association graph (waypoints)
│   ├── clustering/            # GAC geometry: strategy selector, cluster engine, splitters
│   ├── commands/              # Shared command helpers
│   ├── consolidation.ts       # Maintenance orchestrator (squish clean); dedup step routes to proposals
│   ├── consolidation/         # LLM consolidator (insight discovery, non-destructive)
│   ├── context/               # Agent context assembly
│   ├── decay/                 # Ebbinghaus decay + retention mirror
│   ├── embeddings/            # Provider layer (local/openai/ollama/google)
│   ├── engines/               # Contradiction, importance, decay engines
│   ├── extraction/            # Skill extraction via LLM (wiki half removed in Batch 8)
│   ├── graph/                 # Multi-hop retrieval over associations
│   ├── hooks/                 # Capture hook plumbing
│   ├── ingestion/             # Learnings/observations ingest
│   ├── knowledge/             # Unified knowledge table: beliefs, strategies, edges
│   ├── layers/                # L0/L1 content layers
│   ├── lib/                   # DB client, validation, parsing utils
│   ├── llm/                   # Optional LLM client
│   ├── loadout/               # Agent loadouts
│   ├── memory/                # Memory CRUD, hybrid search, sector router,
│   │                          #   GAC consolidation (core/memory/consolidation.ts)
│   ├── places/                # Cognitive places routing
│   ├── projects/              # Project registry
│   ├── retrieval/             # Query router, MMR, expansion, reranker, config flags
│   ├── runtime/               # Trust state / bootstrap composer
│   ├── scheduler/             # Cron scheduler (decay, dedup, weekly GAC, LLM consolidation)
│   ├── scoring/               # Scoring v2 + recall-confidence verdicts
│   ├── search/                # Entity search, QMD wrapper
│   ├── security/              # Privacy filtering, secret detection, encryption
│   ├── session/               # Session working set signals
│   ├── sessions/              # Agent-store adapters (opencode/claude-code/codex/gemini)
│   ├── skills/                # Skill documents
│   ├── snapshots/             # Snapshot export/retrieval
│   ├── storage/               # Storage facade + cache
│   └── wiki/                  # REMOVED in Batch 8 (db-only memory; see below)
├── db/                        # Drizzle schemas (sqlite/pg), bootstrap, migrations
│   └── migrations/wiki-to-memory.ts   # One-time legacy wiki -> memories migration
├── packages/
│   ├── cli/                   # squish CLI (commander): remember/recall/forget/link/
│   │                          #   clean/run/doctor/install/pin/sessions/cloud/status/context
│   ├── mcp/                   # MCP server: 15 tools by default (+gated squish_maintenance = 16)
│   ├── sdk/                   # @squish/sdk: standalone zero-dep MCP-over-HTTP client (private until npm publish)
│   └── core-sdk/              # @squish/core-sdk: internal facade over core/ + db/ (workspace-only)
├── plugin/                    # Claude Code / Codex / OpenCode / OpenClaw integrations
├── skills/                    # Distributable SKILL.md
├── scripts/                   # Operational scripts incl. consolidation-bakeoff.ts
├── tests/                     # bun test suite
└── webui/                     # Local dashboard
```

## Batch 8 deletions (this map reflects them)

| Removed | Why |
|---------|-----|
| `core/consolidation/engine.ts` (sleep-cycle DBSCAN) | Bake-off loser: tag-Jaccard found nothing under realistic tag noise; no provenance/undo. See docs/consolidation-bakeoff.md |
| SimHash dedup in root `core/consolidation.ts` | Bake-off loser: 141 incorrect pairs vs 14 correct; auto-merge wrote a nonexistent column (orphaned flips). Dedup is owned by core/algorithms + squish_dedup |
| `core/memory/sleep-consolidation.ts` | Dark code: zero production callers, destructive truncation semantics |
| `core/wiki/**` + `squish_wiki` tool + wiki tables | Operator decision: NO markdown pages/documents - database only. Legacy rows migrate into memories via db/migrations/wiki-to-memory.ts |
| Wiki half of `core/extraction/extraction.ts` | Same operator decision |
| `core/context/context-paging.ts` | Zero callers post-composer |
| `calculateCompositeScore` (core/retrieval) | Zero production callers; ranking served by scoring v2 |
| `autoArchiveOldMemories` (core/places) | Unreachable safety-gated deleter; tier_maintenance owns lifecycle |
| `getRetentionMap`/`getRetention` (core/decay) | Production uses computeRetention inline |
| Scheduler job `consolidation_sleep` | Its engine was deleted |

## Canonical pipelines after Batch 8

- **Consolidation**: GAC geometry-aware (`core/memory/consolidation.ts`) via the
  weekly `weekly_consolidation` job. Source-marked, undoable
  (`reverseConsolidation`). Rationale: docs/consolidation-bakeoff.md.
- **Dedup**: core/algorithms three-stage detector -> merge proposals ->
  approve/reject with history. Surfaced via `squish_dedup`; nightly
  `dedup_maintenance` creates proposals, auto-executes only when
  `SQUISH_DEDUP_AUTO=true`.
- **Insight discovery** (optional): LLM consolidator writes knowledge edges +
  insight records; non-destructive; skipped when `SQUISH_LLM_ENABLED=false`.

## Entry points

- MCP server: `packages/mcp/src/index.ts` (stdio default; `--http` supported)
- CLI: `packages/cli/src/program.ts`
- SDK (standalone HTTP client): `packages/sdk/src/index.ts` (`@squish/sdk`, private until publish)
- SDK (in-process facade): `packages/core-sdk/src/index.ts` (`@squish/core-sdk`)
