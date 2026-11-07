# Squish Changelog

## Unreleased local changes - 2026-10-20

- **Compact recall contract** — MCP and JSON CLI recall return only `status`, `memories` (`id`, `content`, `type`, and available confidence), and deterministic query-derived `missing` fragments. Local recall applies the configured confidence floor after caller authorization and measures `maxTokens` against the emitted compact JSON.

## Unreleased source candidate 2.2.0 - 2026-10-13

This source candidate has not been published to npm. The published package version and host compatibility do not yet match this entry; check the current release before installing or relying on these changes.

### What's new

- **Decision-model layer** — rules-first decisions at four production sites (write-path memory-type override, contradiction relation veto, query-router retrieval-view routing, UserPromptSubmit prompt gate). Rules always answer first and stand as the permanent fallback: any model failure, timeout, or below-band verdict leaves the rule result untouched.
- **System One decision backend** — provider-agnostic client for the TypeSafe `/v1/systemone` wire (`choice`/`noul`/`score` questions answered in one forward pass): ollaya local (default, no key, localhost only), OpenRouter, TypeSafe, and Cloudflare Workers AI (experimental envelope translator). Vercel AI Gateway ships as a config-only preset gated behind the AI SDK evaluate integration (no new dependency). Selected via `SQUISH_DECISION_MODEL_BACKEND=off|llm|systemone` through the `DecisionRunner` seam.
- **Confidence-gated escalation replacing LLM self-report** — System One verdicts carry calibrated model probabilities instead of self-reported chat confidence, gated by risk-tiered bands: `SQUISH_DECISION_CONFIDENCE_THRESHOLD` (default 0.7) as a global floor under per-site consequence bases (classify 0.8, relation 0.75, route 0.7, gate 0.7). Calibration harness: `bench/decision-model/` (B9) reports stub-mode overall ECE 0.117 against the 0.15 gate; live-model calibration is a pre-default-flip requirement.
- **UserPromptSubmit prompt gate wired into Claude Code and Codex** — rules-first, fail-open gate (`squish gate`); the hook spawns it detached and never blocks the prompt. OpenCode stays SDK-only.
- **Speculative fan-out batching** — on System One, the write site asks memory type and the discard noul in one call, and the gate site asks search and hint domain in one call; each answer parses independently. Discard marking is gated off by default (`SQUISH_DECISION_DISCARD_ACTION`) and never changes persistence.
- **Phase A integrity fixes** — decision-model validator precedence in the contradiction resolver (decision validator only when layer and model flags are set and the backend is not `off`); tags serialization across read and merge paths; graph stats now count project-scoped memory associations; durable count reads live active rows; approve-merge binds embeddings through the blob encoder.

### Notes

- Defaults: the layer is off by default (`SQUISH_DECISION_LAYER_ENABLED=false` + `SQUISH_DECISION_MODEL_ENABLED=false`) and the backend default is `llm`, so shipped behavior is unchanged. Privacy default is local (ollaya, no egress); hosted providers are explicit opt-ins with a one-time egress announcement. Decision egress is governed by the decision flags, not the master `SQUISH_LLM_ENABLED`.
- **Operator note (WS1a-T1.3): `SQUISH_WEIGHT_IMPORTANCE` is now LIVE.** The weight was previously dead config -- setting it changed nothing. It is now consumed on the serving path as an additive boost (`weight x normalized importance`, stored importance 0-100 mapped to 0..1). Anyone who pinned the OLD `.env.example` guidance value of `2` now gets up to +2.0 added to importance-100 memories, a large ranking reshaping. The new neutral default is `0`; unset or re-pin the variable unless importance-weighted recall is intentional. Same warning is in `.env.example`.
- Benchmark/claims reconciliation (WS1b): published benchmark numbers in `README.md`, `docs/BENCHMARK.md`, and `tests/golden/README.md` were updated to the current output of the committed offline harnesses (golden retrieval + memory bench) and now agree across all docs; the committed `tests/benchmarks/reports/baseline.json` and `tests/golden/baseline-report.json` were regenerated from fresh deterministic runs; contradictory LoCoMo figures were consolidated into one indicative, caveated statement (LoCoMo is LLM-dependent, not CI-gated); unverifiable competitor score tables were replaced with capability positioning. `scripts/calibration-report.ts` was repointed to the moved golden harness (`bench/runners/retrieval.ts`), which had silently broken `bun run report:calibration`.
- Full suite: 2476 pass / 27 skip / 0 fail (verified 2026-10-13 with `bun test --isolate`; WS1b docs reconciliation added no test failures).

### Files changed

- `core/decision-model/backend-factory.ts`, `systemone-client.ts`, `systemone-backend.ts`, `systemone-providers.ts` — runner seam, wire client, four primitives, provider presets
- `core/decision-model/provider.ts`, `prompts.ts` — LLM path, risk-tiered bands, strict parsers
- `mcp/tools/memory.ts`, `core/memory/contradiction-resolver.ts`, `core/retrieval/query-router.ts`, `core/hooks/prompt-gate.ts`, `cli/commands/gate.ts` — wiring sites
- `plugin/scripts/new-hook.js`, `plugin/codex/scripts/new-hook.js`, `plugin/templates/hooks/*.json` — UserPromptSubmit hook (Claude Code + Codex)
- `config.ts`, `.env.example`, `docs/ENV-CONFIG.md` — decision layer env surface
- `bench/decision-model/` — calibration harness and fixtures
- `package.json`, `server.json`, `mcp/index.ts`, `plugin/*/package.json` — version 2.2.0

## v2.1.1 — 2026-10-04

### What's new

- **Decision Model layer** — lightweight structured memory classification without LLM calls. Classifies observations into episodic, semantic, procedural, preference, or discard using regex pattern matching. Pluggable interface supports external decision models (e.g., Jev).
- **License migration** — AGPL-3.0 → MIT. No copyleft obligations.
- **17 new tests** — full coverage for decision model classification and edge cases.
- **FTS5 retrieval upgrade** — Porter stemming, BM25 field weighting, stopword removal, and optional quoted-phrase / negative-term query parsing. Existing SQLite indexes rebuild transactionally and preserve searchable memory records.
- **Compact result-card helper** — query-centred, bounded snippets available for opt-in consumers; recall output shape is unchanged.

### Files changed

- `core/decision-model/model.ts` — DecisionModel class
- `core/decision-model/decisions.ts` — pattern-based classification logic
- `core/decision-model/types.ts` — type contracts
- `tests/core/decision-model.test.ts` — 17 tests
- `LICENSE` — MIT
- `package.json` — version 2.1.1, license MIT
- `core/memory/keyword-search.ts` — stopword removal and optional query parser
- `core/memory/result-card.ts` — compact snippet/result-card helper
- `db/bootstrap.ts` — Porter tokenizer and BM25 default
- `db/migrations/fts.ts` — transactional index rebuild for existing databases
- `db/schema-repair.ts` — matching tokenizer/ranking settings for repaired databases
- `tests/core/memory/fts5-leviathan.test.ts` — retrieval, migration, parser, and card tests

## v2.1.0 — 2026-09-19

### What's new

- **Places system wired through knowledge_edges** -- memories route to spatial places (WIP, Board, Ref, Sandbox, Sparks, Archive, Inbox) via `knowledge_edges` table. Place routing, retrieval, walking, and context injection all functional.
- **Knowledge schema v2.0.0** -- `knowledge` + `knowledge_edges` tables replace the old `memories` + `memory_places` + `entity_relations` tables. Edge types: `placed_in`, `related_to`, `depends_on`, `contradicts`.
- **Consolidation pipeline** -- merge similar memories, LLM-powered consolidation. Automatic dedup with configurable thresholds.
- **Team memory** -- personal + team scope. Teams share memory graphs. Invitations, sharing, ACL.
- **Edit proposal workflow** (`squish_edits`) -- propose edits, preview diffs, approve/reject/correct with undo snapshots.
- **Scoring v2 composite ranking** -- graph boost, recency, importance, contextual retrieval, MMR, query expansion, temporal validity.
- **19 MCP tools** -- remember, recall, forget, link, context, stats, inspect, team, loadout, compile, skill, extract, feedback, places, sessions, tier, dedup, edits, stale_report.
- **1638/1638 tests pass** -- full suite runs in ~190s.

### Benchmarks

_Historical v2.1.0-era snapshot. Current, reproducible numbers: `docs/BENCHMARK.md` (verified 2026-10-13)._

- Golden retrieval: Recall@5=0.935, MRR=0.904, Hit@1=0.870, ECE=0.055
- Resurrection: 5/5 scenarios pass
- Temporal validity: Recall@5=0.837, MRR=0.809, Hit@1=0.739

### Migration notes

- `memory_places` table no longer created on new installs. Existing data migrates to `knowledge_edges` automatically.
- `entity_relations` table migrated to `knowledge_edges`. No manual action required.
- Place routing now works through `knowledge_edges` -- old `memory-places.ts` functions are real implementations, not no-ops.

## v2.0.0 — 2026-08-27

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

Squish is developed by Michiel Horstman and maintained at [github.com/michielhdoteth/squish-memory](https://github.com/michielhdoteth/squish-memory).

MIT License.

---

*For older releases, see the GitHub release history.*
