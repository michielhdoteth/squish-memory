# Squish Changelog

## Unreleased

- `squish_edits` — edit proposal workflow with propose/list/preview/approve/reject/correct actions and undo snapshots.
- Corrections loop — approval/correction paths feed reinforcement feedback (`confirm`) and store `memory_snapshots` as `correction`.
- Staleness report — read-only grouped report with at-risk items and suggested actions.
- SDK v2 migration — `@squish/sdk` HTTP surface, `@squish/core-sdk` internal facade, zod v4 authoring.
- `packages/mcp` upgraded to `@modelcontextprotocol/client` / `@modelcontextprotocol/server` v2 with Node 20+ transports.
- Node engine enforced at `>=20` across root and packages.

## v2.1.0 — 2026-09-02

### What's new

- **SDK split for third-party consumers** — `@squish/sdk` is now a standalone, zero-dependency TypeScript client that talks to a running squish instance (local `squish-mcp --http` or cloud) over MCP streamable HTTP: auth, sessions, timeouts, retries (429 honoring Retry-After), and normalized errors in one request path, with a typed method per tool. Structurally publishable; kept private until release approval.
- **In-process facade renamed** — the engine facade that CLI and MCP consume internally is now `@squish/core-sdk` (`packages/core-sdk`), workspace-only and never published. No more misleading npm claims: the old facade could never have shipped standalone.
- **MCP-over-HTTP is the third-party surface** — full read/write parity with agent tooling (all 15 tools) over one protocol, with API-key auth (`x-api-key` or `Authorization: Bearer`).
- **Node/tsx loadability** — the sessions agent stores load `bun:sqlite` lazily, so the engine no longer hard-requires Bun at module load on bun-less installs.
- **Fixes** — `@squish/core-sdk` now typechecks clean (missing `DedupScanResult` / `MergeProposalListInput` types, undefined-safety in `dedupAutoMerge`); `packages/mcp` and `packages/cli` typecheck clean for the first time (drizzle row typing, `.mjs` declaration files, `bootstrapDatabase` removal fallout, sessions command using the current `getSessionChunks`/`getOpenCodeSession` contracts, invalid `allowImportingTsExtensions` tsconfig combo); `bun:sqlite` adapter passes schema bootstrap with an explicit cast.
- **Docs** — README and `docs/map.md` describe the two-SDK architecture; `packages/sdk` has an honest README (publish pending) with quickstart, error taxonomy, and retry semantics.

### Notes

- `@squish/sdk` ships with `private: true`; flip the flag and publish when ready. Release CI (`release.yml`) publishes only the root `squish-memory` package on `v*` tags.
- Repo-root `NUL` file (accidental redirect artifact containing an SSH public key) removed.

## v2.0.0 — 2026-08-27

### What's new

- **16 MCP tools** — 15 by default, 16th (squish_maintenance) gated behind `SQUISH_ENABLE_MAINTENANCE_TOOLS=true`. Tools: remember, recall, forget, link, context, stats, inspect, skill, loadout, extract, feedback, places, sessions, tier, dedup, maintenance.
- **squish_skill** — Full CRUD for reusable SOPs: list, get, create, update, delete, search, versions, assign, unassign, record_usage. Versioned workflows with triggers, steps, and validation rules.
- **squish_loadout** — Agent loadouts and visibility rules (ACL). Bind memory assets to agents, manage access control, check visibility.
- **squish_extract** — Auto-extract reusable skills from accumulated memories via LLM analysis. Groups memories by tags, extracts SOPs from groups with 3+ memories.
- **squish_feedback** — Reinforcement loop. Push confirm/used/contradict signals back into memory, beliefs, and strategies. Confirmation strengthens confidence; contradiction marks disputed.
- **squish_places** — Memory places (spatial organization): list places, get memories at a place. Place types: inbox, ref, wip, sandbox, board, sparks, archive.
- **squish_sessions** — Agent session history across harnesses. List, show, search, related. Every result tagged with harness origin. Source filter: opencode, claude-code, codex, gemini, all.
- **squish_tier** — Memory tier management. Promote, demote, list by tier.
- **squish_dedup** — Duplicate detection and merge workflow. Scan (no merges), list, preview, approve, reject, reverse (undo via history ID), auto (requires SQUISH_DEDUP_AUTO=true, capped).
- **squish_maintenance** (gated) — Run maintenance operations (dedup, stale, consolidate, inbox) in one call. Dry-run support.
- **recall assessments** — Every recall result carries a calibrated verdict: `confident`, `qualified`, or `no_reliable_memory`. Feed back via squish_feedback.
- **hybrid retrieval with scoring v2** — BM25 + semantic with RRF fusion. Scoring v2 adds graph boost, recency, importance, contextual retrieval, MMR, query expansion, temporal validity.
- **multimodal ingestion** — 27+ file types: images, audio, video, documents. MIME detection, per-type extractors, LLM descriptions (optional), embeddings.
- **belief engine** — Observations stored; beliefs derived and inspectable. Confidence tracking, evidence trails.
- **knowledge graph** — Reinforced edges from usage. Multi-hop retrieval. Compounds as agents use it.
- **decay system** — Automatic relevance management. Pin to persist.
- **local dashboard** — WebUI at localhost:37777.

### Memory model

- Three-tier memory model: durable memories, learnings (success/failure/fix/insight), notes
- Session working set: active context that persists within a session
- Raw fallback snapshots: reversible artifacts for debugging-heavy events
- Places routing: organize memories by project, feature, or context
- Graph enrichment: automatic relationship extraction from durable writes

### SDK

- `@squish/sdk` — typed, event-emitting client
- Plugin system with hooks: before/after store, search, delete, consolidate, graph build
- Storage provider, embedding provider, LLM provider interfaces
- Event bus with 17 event types
- Typed error classes: SquishError, ConfigError, StorageError, EmbeddingError, LLMError, NotFoundError
- All core operations as methods on SquishClient

### Configuration

- Local-first: SQLite, TF-IDF embeddings, zero API keys
- Optional LLM consolidation (off by default)
- Optional embedding providers: OpenAI, Ollama, Google
- Gated features behind environment flags
- Full environment reference in .env.example

### What's changed

- MCP server is now the primary integration surface (15 tools + 1 gated)
- SDK is the public API for building on Squish
- CLI, MCP server, and WebUI are thin wrappers over the SDK
- All core features work without an LLM (LLM is optional, off by default)

### Contributors

Squish is developed by Michiel Horstman and maintained at [github.com/michielhdoteth/squish](https://github.com/michielhdoteth/squish).

MIT License.

---

*For older releases, see the GitHub release history.*
