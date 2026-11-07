# Squish Codebase Map (post-Batch 8)

## Planning references

- `../PLAN.md`: main execution roadmap and global status; it links each bounded subplan and matching spec.
- `plans/2026-11-01-runtime-lifecycle.md` / `specs/2026-11-01-runtime-lifecycle.md`: write lifecycle, temporal correctness, lineage, and compaction.
- `plans/2026-11-01-memory-capabilities.md` / `specs/2026-11-01-memory-capabilities.md`: branch isolation, commitments, evidence confidence, context, and sequence proposals.
- `plans/2026-11-01-cloud-api.md` / `specs/2026-11-01-cloud-api.md`: cloud API correctness and release verification.
- `plans/2026-11-01-release-gates.md` / `specs/2026-11-01-release-gates.md`: candidate freeze and final go/no-go gates.
- `specs/2026-11-01-provider-complaint-map.md`: research themes routed to their workstreams.
- `plans/completed/`: finished work summaries marked DONE; `plans/archive/`: dated historical records.
- `specs/README.md`: index of per-plan technical contracts and acceptance checks.
- `ADR-324-main-plan-with-executable-subplans.md`: root `PLAN.md` is the main roadmap; ADR-323 is superseded on that point.
- API contracts `ADR-008`–`ADR-010` live in `../squish-cloud/squish-api/docs/`; they cover anonymous desktop analytics, hosted MCP response/access bounds, and managed-AI project scope.
- `ADR-273-resolve-embedding-vector-space-identity.md`: preserve actual provider/model identity across auto fallback and avoid known cross-space cosine comparisons.
- `ADR-274-apply-vector-space-gates-to-dedup.md`: prevent semantic duplicate proposals from comparing same-dimension vectors with different known model identities.
- `ADR-275-evict-corrected-memories-from-consolidation-clusters.md`: evict corrected memories' stale process-local vectors after successful approved or direct revisions.
- `ADR-276-isolate-consolidation-clusters-by-embedding-model.md`: prevent known same-dimension cross-model vectors from sharing ephemeral consolidation clusters.
- `ADR-277-add-bounded-laya-decision-provider.md`: add the documented Laya Studio System One endpoint as an opt-in provider with its stricter question cap.
- `ADR-278-evict-project-deletions-from-consolidation-clusters.md`: evict every project-deleted memory from process-local consolidation state after the SQLite transaction commits.
- `ADR-279-evict-revised-and-forgotten-memory-feedback-buffers.md`: remove stale query and copied memory content from feedback buffers after committed memory revisions and deletions.
- `ADR-280-evict-expired-memory-runtime-state.md`: evict expired memory vectors and feedback buffers only after temporal expiry commits.
- `ADR-281-evict-superseded-memory-runtime-state.md`: evict old vectors and feedback buffers immediately after a memory is superseded.
- `ADR-282-evict-archived-memory-runtime-state.md`: evict process-local state after weekly stale-memory archive commits.
- `ADR-283-invalidate-feedback-during-async-flush.md`: prevent not-yet-applied in-flight feedback from surviving a memory lifecycle invalidation.
- `ADR-284-migrate-postgres-memory-token-estimate.md`: add the source token-estimate column required by PostgreSQL runtime writes.
- `ADR-285-migrate-postgres-memory-embedding-model.md`: add the source embedding model identity required by PostgreSQL vector retrieval.
- `ADR-286-sqlite-primary-postgres-compatibility.md`: set SQLite as the canonical runtime and quality gate while keeping PostgreSQL as a bounded compatibility target.
- `ADR-287-atomic-captured-session-forget.md`: delete all selected SQLite session memories and defer runtime side effects until the batch commits.
- `ADR-288-use-persisted-edges-for-retrieval-boost.md`: source local-compatible graph ranking from persisted associations instead of a process-global in-memory graph.
- `ADR-289-batch-persisted-graph-boost-traversal.md`: fetch candidate graph frontiers in bounded batches to avoid per-candidate database traversal cost.
- `ADR-290-preserve-multiview-decision-routing.md`: preserve all selected decision-model retrieval views through the router and activate every corresponding retrieval enhancement; budget/stop semantics stay deferred.
- `../LOG.md`: concise current checkpoint; full prior history is in `plans/archive/development-log-through-2026-11-01.md`.
- `ADR-317-revalidate-session-recovery-scope.md`: recheck caller ACL and requested project after asynchronous session reads before returning evidence.
- `../MAP.md`: local runtime navigation entrypoint.
- `ADR-324-main-plan-with-executable-subplans.md`: main roadmap/subplan hierarchy; it supersedes ADR-323 on root plan ownership.
- `GRAPH-EDGE-ATTESTATION.md`: WAL-safe copied-database procedure for reviewing and explicitly attesting legacy entity relations.
- `STRICT-MCP-TRUST-INVENTORY.md`: per-tool strict trust behavior and evidence for fail-closed surfaces.
- `ADR-011-bi-temporal-knowledge-edges.md`: temporal edge versioning, migration, and query contract.
- `ADR-102-separate-benchmark-oracle-and-confident-wrong.md`: distinguish retrieval-oracle penalties from confidently wrong answers and constrain explicit historical-evidence credit.
- `ADR-103-atomic-strict-loadout-audit.md`: make strict loadout attach/detach and their hashed allow-audit atomic.
- `ADR-104-isolate-session-adapter-read-failures.md`: preserve healthy-host session results when one local adapter read fails.
- `ADR-105-atomic-temporal-fact-expiry.md`: recheck and expire SQLite source/projection rows in one synchronous native transaction.
- `ADR-012-memory-associations-canonical-edge-migration.md`: canonical graph edge direction and association migration parity window.
- `ADR-018-canonical-entity-graph-traversal.md`: graph traversal reader cutover to canonical temporal edges.
- `ADR-216-strict-postgres-team-promotion.md`: strict PostgreSQL team compilation uses persisted owner-scoped selection, locked signed-source revalidation, and atomic promotion/projection/audit writes.
- `ADR-217-strict-team-stale-cleanup.md`: explicit strict team cleanup requires persisted owner/admin membership and atomically audits and removes stale signed team memories on SQLite and PostgreSQL.
- `ADR-244-isolate-agent-session-parse-cache.md`: binds parsed-session cache entries to their source path and strict caller scope.
- `ADR-243-version-entity-support-cleanup.md`: SQLite memory cleanup preserves recorded-time versions when entity-relation source support is removed.
- `ADR-218-caller-scoped-strict-stale-listing.md`: strict stale listing requires a persisted matching caller and returns only signed, active, unexpired personal memories after ACL checks.
- `ADR-219-asof-strict-derived-graph-views.md`: strict entity graph views validate derived proof premises at the same valid/recorded snapshot as traversal.
- `ADR-220-caller-scoped-strict-temporal-expiry.md`: strict temporal expiry is caller-scoped, signed-source and ACL-gated, and atomic across source/projection/audit on SQLite and PostgreSQL.
- `ADR-221-cloudflare-clef-decision-provider-contract.md`: map documented Cloudflare Clef model IDs/selectors to the Workers AI REST contract within the decision-model provider layer.
- `ADR-222-source-anchored-fact-extraction.md`: require durable fact proposals to carry verified exact source quotes and offsets; do not treat quote location as entailment proof.
- `ADR-223-encrypted-memory-projection-boundary.md`: keep SQLite encrypted captures out of plaintext projections, indexes, search, and side effects; withhold strict-trust and PostgreSQL capture pending full parity.
- `ADR-224-atomic-strict-projection-deletion-audit.md`: allow already-authorized strict SQLite lifecycle deletion to remove canonical projections and write their audit records within the same transaction.
- `ADR-225-core-capture-idempotency.md`: optional core SQLite capture keys deduplicate exact replayed writes with transactional receipts that are removed on forget; no host plugin is wired yet.
- `ADR-226-cancel-decision-llm-on-deadline.md`: decision timeouts abort in-flight built-in LLM provider fetches while retaining deterministic fallback behavior.
- `ADR-227-scrub-linked-encrypted-memory-derivatives.md`: startup atomically removes or invalidates known legacy artifacts linked to encrypted SQLite sources and states the unlinked session/event limitation.
- `ADR-228-invalidate-source-linked-beliefs-on-forget.md`: permanent forget and stale cleanup remove source-linked belief projections and audit their deletion atomically across SQLite and PostgreSQL paths.
- `ADR-229-role-aware-transcript-fact-grounding.md`: role-labeled transcript extraction requires fact evidence from User/Human turns; text labels remain heuristic, not authenticated identity.
- `ADR-230-ground-deterministic-beliefs-in-user-turns.md`: deterministic beliefs from role-labeled transcripts use only User/Human turns, closing the non-LLM extractor bypass.
- `ADR-231-scope-strict-graph-edge-authorization-by-time.md`: strict entity-edge authorization enforces valid/recorded-time intervals and scopes cached decisions to caller, snapshot, and proof policy.
- `ADR-232-invalidate-derived-knowledge-on-source-correction.md`: source corrections retract stale fact/belief projections, preserve edge history, audit deletions, and requeue evidence analysis atomically.
- `ADR-252-deterministic-bounded-graph-view-scans.md`: graph-view scan ceilings select the same newest-first, ID-tiebroken edge prefix across query plans.
- `ADR-253-postgres-bi-temporal-graph-views.md`: PostgreSQL graph views use bounded temporal Drizzle queries and preserve JSONB edge metadata.
- `ADR-254-bound-decision-provider-payloads.md`: decision-provider instructions, criteria, requests, and streamed responses have explicit size limits.
- `ADR-019-strict-trust-derives-team-membership.md`: strict ACL team membership and private team-memory defaults.
- `ADR-020-memory-association-compatibility-adapter.md`: canonical memory-association read/write routing and projection-ID mapping.
- `ADR-021-canonical-entity-relations.md`: entity relation writes, reads, and lifecycle operations routed through temporal edges.
- `ADR-022-supersession-cycle-guard.md`: replacement-to-prior direction and cycle rejection for memory supersession.
- `ADR-023-reconcile-all-legacy-edge-imports.md`: transaction and count/payload reconciliation for every legacy edge source.
- `ADR-024-deny-idless-strict-results.md`: strict ACL denies and audits results without stable resource IDs.
- `ADR-025-retire-unqualified-strategy-projection.md`: ordinary memories do not directly create active strategies.
- `ADR-026-bind-strict-acl-to-trusted-principal.md`: strict ACL caller identity is bound to operator-trusted server configuration.
- `ADR-033-explicit-owner-attestation-for-legacy-memory.md`: explicit, audited adoption of unsigned local memory rows into strict trust.
- `ADR-036-verified-mcp-request-principals.md`: authenticated HTTP API-key-to-principal mapping and request-scoped strict ACL identity.
- `ADR-037-private-by-default-strict-memory-reads.md`: persisted owner/team scope checks and private-by-default behavior for unruled strict reads.
- `ADR-038-strict-explicit-team-memory-sharing.md`: owner-authorized share, admin revocation, and live strict read enforcement for explicit team shares.
- `ADR-039-scope-bound-memory-provenance.md`: v3 signatures bind persisted owner, team, and source-memory lineage to new writes, corrections, and legacy attestations.
- `ADR-040-explicit-v3-provenance-migration.md`: separate owner-confirmed v1/v2-to-v3 re-sign migration with validation, dry-run counts, and rollback-safe hashed audits.
- `ADR-041-canonical-only-memory-association-writes.md`: canonical-only association creation and feedback, retaining legacy import/read compatibility during migration.
- `ADR-042-forget-memory-projection-lifecycle.md`: permanent forget closes projection edges and removes canonical memory/FTS content.
- `ADR-043-strict-team-loadout-and-promotion-lineage.md`: caller-bound memory-only strict loadouts and owner-scoped, signed team promotion lineage.
- `ADR-044-canonical-entity-relation-runtime.md`: entity relation extraction, derivation, reads, and deduplication now use only temporal `knowledge_edges`.
- `ADR-045-local-project-erasure.md`: local SQLite project erasure transaction and cross-store cleanup boundary.
- `ADR-046-signed-fact-extraction-lineage.md`: derived fact/belief provenance, strict-source requirements, and stale-source commit fencing.
- `ADR-047-collision-resistant-embedding-caches.md`: full-input cache identity and belief-vector invalidation after edits.
- `ADR-048-canonical-association-read-cutover.md`: startup reconciliation of wiki-imported links and canonical-only association reads.
- `ADR-049-association-payload-reconciliation.md`: immutable legacy association payload snapshots and drift detection during import reconciliation.
- `ADR-050-recorded-time-edge-retraction.md`: explicit correction of erroneous recorded-time edge assertions while preserving valid-time bounds.
- `ADR-051-rebuild-memory-fts-during-repair.md`: doctor repair rebuilds potentially stale external-content FTS postings from canonical memory rows.
- `ADR-052-owner-audited-team-deletion.md`: owner-only audited team deletion and its cascading/preserved-memory contract.
- `ADR-053-dry-run-supersession-cycle-repair.md`: operator-selected, transactional repair of current temporal supersession cycles with record-time history preserved.
- `ADR-054-team-scoped-procedure-outcomes.md`: procedure outcome edges require matching persisted team scope.
- `ADR-055-supersession-projection-parity.md`: supersession lifecycle and valid-time boundaries stay aligned across memory rows and canonical knowledge projections.
- `ADR-056-provenance-aware-knowledge-dedup.md`: canonical-only knowledge maintenance skips source-backed memories and signed records.
- `ADR-057-protect-signed-belief-upserts.md`: legacy belief upserts cannot revise or reattribute signed derivation records.
- `ADR-058-temporal-expiry-projection-parity.md`: temporal expiry deactivates source memories and their canonical knowledge projections together.
- `ADR-059-bi-temporal-knowledge-projections.md`: source-memory writes preserve valid-time starts in canonical projections, whose typed reads expose valid and recorded time.
- `ADR-060-temporal-correction-and-derivation-parity.md`: corrections advance recorded time consistently; extracted facts inherit validity and are fenced against temporal source changes.
- `ADR-061-import-projection-temporal-parity.md`: workspace-memory import repairs/backfills preserve source validity and record time.
- `ADR-062-record-temporal-lifecycle-changes.md`: supersession and expiry advance source/projection record time with lifecycle state.

## Additional ADRs

- `ADR-066-signed-memory-projection-boundary.md`: source-verified projection signing, strict unlinked-write denial, and safe importer repair scope.
- `ADR-067-atomic-memory-projection-write.md`: SQLite capture, analysis-job, projection, and audit atomicity.
- `ADR-068-withhold-unscoped-strict-telemetry.md`: fail-closed telemetry/feedback helpers until caller-scoped strict authorization is available.
- `ADR-069-bind-strict-session-working-sets.md`: persisted owner/project checks for session snippets, summaries, statistics, and write-back.
- `ADR-070-withhold-unscoped-retrieval-feedback.md`: strict mode discards unscoped process-local retrieval feedback before association reinforcement.
- `ADR-071-bind-strict-sdk-capture-and-search.md`: SDK capture and caller-optional reads bind to the trusted principal; project listing remains withheld.
- `ADR-072-withhold-unscoped-strict-background-work.md`: scheduler jobs, full maintenance, unsigned learning writes, migration, and cross-project diagnostics are withheld under strict trust.
- `ADR-073-audit-strict-agent-loadout-changes.md`: reuses canonical memory lifecycle fields and audits strict agent-memory loadout attach/detach events.
- `ADR-074-authorize-and-audit-strict-memory-feedback.md`: enables owner/shared-memory feedback after strict provenance checks, with signal-specific hashed audit events; belief and strategy feedback remain withheld.
- `ADR-075-strict-retrieval-candidate-scope.md`: scopes strict memory vector and FTS candidates before bounded retrieval ranking.
- `ADR-076-transactional-strict-memory-feedback.md`: checks ACL/provenance, mutates, and appends the hashed allow audit atomically for strict memory feedback.
- `ADR-077-strict-source-scoped-belief-retrieval.md`: restores only source-scoped signed single-source beliefs to strict retrieval.
- `ADR-078-withhold-unscoped-strict-capture-effects.md`: withholds unscoped cross-memory derivation and raw-content events after strict capture.
- `ADR-079-transactional-signed-belief-feedback.md`: enables transactional, caller/ACL-authorized feedback for single-source signed beliefs.
- `ADR-080-strict-signed-file-ingestion.md`: binds local file extraction to strict caller identity and source-byte provenance.
- `ADR-081-transactional-stale-memory-archive.md`: snapshots stale memory content and synchronizes archive lifecycle state across source and canonical projection.
- `ADR-082-evict-forgotten-memories-from-consolidation-clusters.md`: removes successfully deleted memories from process-local consolidation clusters.
- `ADR-083-active-asset-strict-feedback.md`: strict feedback reads and mutates only active memory and belief assets.
- `ADR-084-withhold-unprovenanced-related-graph-reads.md`: strict related-memory graph reads fail closed until caller-scoped edge provenance is enforced.
- `ADR-085-owner-only-strict-memory-correction.md`: direct strict corrections are authenticated-owner-only and atomically snapshot, re-sign, update, and audit private memory assets.
- `ADR-086-strict-source-lifecycle-on-derived-reads.md`: strict derived retrieval requires an active, unexpired source at candidate selection and final result gating.
- `ADR-087-withhold-unscoped-place-counts.md`: strict MCP place reads omit aggregate counts until place assignments can be caller-scoped.
- `ADR-088-page-strict-place-reads-past-denied-records.md`: strict place retrieval continues past denied edge candidates until it fills the authorized result limit.
- `ADR-089-withhold-unverified-place-context.md`: strict context omits place labels and summaries until place edges have verifiable caller-scoped provenance.
- `ADR-090-strict-session-bootstrap-uses-gated-context.md`: strict session start injects only caller-scoped working-set text and signed, ACL-gated memories within the token ceiling.
- `ADR-091-strict-agent-adapter-boundaries.md`: strict UAM adapter reads use caller-bound gates and unprovenanced observation writes fail closed.
- `ADR-092-audit-strict-surface-denials.md`: wrapper-withheld strict MCP tools append hashed denial audit events without arguments.
- `ADR-093-scope-session-entity-cache.md`: partitions entity context by caller and gates persisted session metadata by owner.
- `ADR-094-partition-strict-embedding-cache.md`: isolates strict embedding vectors by caller and bypasses caching for unbound work.
- `ADR-095-signed-adapter-observation-capture.md`: writes caller-bound signed UAM observations without retaining raw tool results.
- `ADR-106-atomic-entity-graph-rebuild.md`: publishes local SQLite entity graph snapshots atomically and fails closed for unsupported destructive backend rebuilds.
- `ADR-107-strict-denial-before-schema-diagnostics.md`: denies withheld strict MCP routes before schema probes and diagnostics.
- `ADR-108-principal-partition-belief-embeddings.md`: partitions strict belief and strategy vector caches by verified principal.
- `ADR-109-deny-raw-snapshot-helper-under-strict-trust.md`: denies unscoped raw snapshot reads under strict trust.
- `ADR-110-deny-raw-snapshot-history-under-strict-trust.md`: denies unscoped snapshot-history reads under strict trust.
- `ADR-111-deny-unscoped-memory-reader-under-strict-trust.md`: denies direct unscoped memory reads under strict trust.
- `ADR-112-deny-association-writes-under-strict-trust.md`: denies low-level unscoped association writes under strict trust.
- `ADR-113-deny-unscoped-governance-writes-under-strict-trust.md`: denies raw pinning and tier mutations under strict trust.
- `ADR-114-deny-unscoped-learning-writes-under-strict-trust.md`: denies direct learning creation under strict trust.
- `ADR-115-deny-unscoped-memory-migration-under-strict-trust.md`: denies direct memory migration under strict trust.
- `ADR-116-deny-raw-session-history-under-strict-trust.md`: denies unscoped local session-history readers under strict trust.
- `ADR-117-deny-raw-agent-store-registry-under-strict-trust.md`: denies direct access to raw agent-store adapters under strict trust.
- `ADR-118-correct-batch-stale-memory-cleanup.md`: uses valid Drizzle ID-set predicates and deletes snapshots during batch stale-memory cleanup.
- `ADR-119-withhold-qmd-under-strict-trust.md`: blocks QMD subprocess/model access under strict trust until collection scope and download egress are verified.
- `ADR-120-atomic-local-memory-forget.md`: makes local SQLite permanent forget atomic across source, projection, temporal-edge, tag, and snapshot cleanup.
- `ADR-121-atomic-batch-stale-cleanup.md`: makes local SQLite batch stale-memory deletion atomic, supplementing ADR-120.
- `ADR-122-lock-stale-cleanup-eligibility.md`: scans stale candidates after acquiring the SQLite write transaction so eligibility cannot change before deletion.
- `ADR-123-fail-closed-nonsqlite-forget.md`: blocks destructive permanent cleanup on non-SQLite stores until equivalent lifecycle transactions are implemented.
- `ADR-212-postgres-local-compatible-permanent-forget.md`: supersedes ADR-123 for local-compatible PostgreSQL single-memory forget after transaction/rollback coverage; strict PostgreSQL deletion and non-SQLite batch cleanup remain fail-closed.
- `ADR-213-postgres-source-staleness-fields.md`: adds SQLite-compatible confidence-level and 0-100 importance fields to PostgreSQL source memories, backfilled once from canonical projections for stale-lifecycle parity.
- `ADR-214-strict-postgres-permanent-forget.md`: binds strict PostgreSQL single-memory caller authorization, hashed audit, and permanent cleanup to one serializable transaction; its batch-cleanup gate is superseded by ADR-215.
- `ADR-215-caller-scoped-strict-batch-forget.md`: enables transactional strict batch cleanup for signed, active personal memories owned by the caller; strict stale listing is now caller-scoped under ADR-218 and strict team cleanup is covered by ADR-217.
- `ADR-124-retire-entity-relations-from-fresh-schemas.md`: fresh schemas and health/repair paths no longer create or require the import-only legacy entity-relations table.
- `ADR-125-deny-raw-graph-traversal-under-strict-trust.md`: withhold unscoped raw graph traversal and graph-view reads under strict trust until edge scope and provenance are verified.
- `ADR-126-typed-document-context-graph.md`: add bounded document, matter, party, citation, version, status, and date graph vocabulary with evidence-only extraction rules.
- `ADR-127-retire-memory-associations-from-fresh-schemas.md`: keep legacy association import and cleanup conditional while fresh schemas use canonical `knowledge_edges` only.
- `ADR-128-retire-belief-edges-runtime-schema.md`: remove the unused SQLite belief-edge declaration and repair DDL while retaining legacy import compatibility.
- `ADR-129-align-postgres-edge-declarations.md`: remove obsolete PostgreSQL edge declarations while retaining canonical `knowledge_edges` and leaving physical legacy tables untouched.
- `ADR-130-preflight-strict-mcp-caller.md`: bind and validate strict MCP caller identity before schema probing or project-scope registration.
- `ADR-131-classify-strict-mcp-actions.md`: classify every strict MCP action independently and default-deny unknown or withheld routes.
- `ADR-132-track-entity-relation-memory-support.md`: track contributing memories through graph snapshots and forget operations.
- `ADR-133-sign-source-backed-graph-relations.md`: sign entity-relation payloads and re-sign them after support pruning.
- `ADR-134-caller-scoped-entity-graph-reads.md`: authorize and sanitize strict entity-graph reads against every source memory.
- `ADR-135-portable-trust-decision-audit.md`: share hashed trust-decision auditing across SQLite and PostgreSQL schemas.
- `ADR-136-proof-carrying-strict-entity-derivation.md`: authorize one-hop rule-based graph derivation through signed, caller-readable premise proofs.
- `ADR-137-caller-partitioned-graph-cache.md`: partition strict graph authorization cache entries by trusted caller.
- `ADR-138-evidence-faithful-locomo-scoring.md`: judge answers against the actual supplied context and preserve task-level LoCoMo provenance.
- `ADR-139-isolate-locomo-benchmark-storage.md`: keep LoCoMo data in temporary local SQLite and separate persona memories during retrieval.
- `ADR-140-poll-nvidia-hosted-completions.md`: poll NVIDIA hosted inference jobs accepted with HTTP 202; retry transient failures only.
- `ADR-141-widen-postgres-trust-audit-timestamps.md`: store trust-audit epoch milliseconds in a 64-bit PostgreSQL column.
- `ADR-142-add-forward-postgres-knowledge-graph-migration.md`: create canonical PostgreSQL knowledge/edge tables and reconcile legacy payloads without treating them as trusted provenance.
- `ADR-143-atomic-strict-team-mutations.md`: establish atomic strict SQLite team mutations and signed-memory promotion; its PostgreSQL parity gate is closed by ADR-216.

## Project Structure Overview

```
squish/
├── core/                      # Core business logic
│   ├── acl/                   # Visibility gates, signed provenance, trust audit
│   ├── adapters/              # External service adapters
│   ├── algorithms/            # KEEP dedup workflow: detection -> proposals -> approve/reject/reverse
│   ├── associations.ts        # Memory association API over canonical temporal edges
│   ├── clustering/            # GAC geometry: strategy selector, cluster engine, splitters
│   ├── commands/              # Shared command helpers
│   ├── consolidation.ts       # Maintenance orchestrator (squish clean); dedup step routes to proposals
│   ├── consolidation/         # LLM consolidator (insight discovery, non-destructive)
│   ├── context/               # Agent context assembly
│   ├── decay/                 # Ebbinghaus decay + retention mirror
│   ├── embeddings/            # Provider layer (local/openai/ollama/google)
│   ├── engines/               # Contradiction, importance, decay engines
│   ├── extraction/            # Explicit evidence-linked extraction; automatic skill extraction retired
│   ├── graph/                 # Canonical entity graph extraction and multi-hop retrieval (see core/graph/MAP.md)
│   ├── hooks/                 # Capture hook plumbing
│   ├── ingestion/             # Learnings/observations ingest
│   ├── knowledge/             # Unified knowledge table: beliefs, strategies, temporal edges
│   ├── layers/                # L0/L1 content layers
│   ├── lib/                   # DB client, validation, parsing utils; timestamps (epoch sec/ms) + token estimation primitives
│   ├── llm/                   # Optional LLM client
│   ├── loadout/               # Agent loadouts
│   ├── memory/                # Memory CRUD, hybrid search, fact extraction, sector router,
│   │                          #   GAC consolidation, MCP/CLI write router
│   ├── places/                # Cognitive places routing
│   ├── projects/              # Project registry
│   ├── retrieval/             # Query router, MMR, expansion, reranker, profiles/config
│   ├── runtime/               # Trust state / bootstrap composer
│   ├── scheduler/             # Cron scheduler (decay, dedup, weekly GAC, LLM consolidation)
│   ├── scoring/               # Scoring v2 + recall-confidence verdicts
│   ├── search/                # Entity search, QMD wrapper
│   ├── security/              # Privacy filtering, secret detection, encryption, encrypted-read path
│   ├── session/               # Session working set signals
│   ├── sessions/              # Agent-store adapters (opencode/claude-code/codex/gemini)
│   ├── skills/                # Skill documents
│   ├── snapshots/             # Snapshot export/retrieval
│   ├── storage/               # Storage facade + cache; SQLite transaction boundary (withSqliteTransaction)
│   └── wiki/                  # REMOVED in Batch 8 (db-only memory; see below)
├── db/                        # Drizzle schemas (sqlite/pg), bootstrap, migrations
│   └── migrations/wiki-to-memory.ts   # One-time legacy wiki -> memories migration
├── packages/
│   ├── cli/                   # squish CLI (commander): remember/recall/forget/link/
│   │                          #   clean/run/doctor/install/pin/sessions/cloud/status/context;
│   │                          #   shared quiet-mode helper (cli/quiet-mode.ts)
│   ├── mcp/                   # MCP server (+gated squish_maintenance); shared tool contract
│   │                          #   in mcp/tools/shared.ts (ToolCtx, jsonResult, SERVER_VERSION)
│   ├── core-sdk/              # @squish/core-sdk: internal facade over core/ + db/ (workspace-only)
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
| `core/wiki/**` + `squish_wiki` tool + wiki tables | Removed in Batch 8 (operator decision: database-only memory). Legacy SQLite pages migrate via `db/migrations/wiki-to-memory.ts`; legacy PostgreSQL pages migrate via `squish-cloud/squish-api/migrations/009-wiki-to-memory.sql`, preserving versions and links. |
| `core/extraction/extraction.ts` | Retired by [ADR-014](ADR-014-retire-automatic-skill-extraction.md); inferred skill extraction is outside Squish's memory role |
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
- In-process: `packages/core-sdk/src/index.ts` (`@squish/core-sdk`, workspace-only)

## Recent trust decisions

- Strict feedback for single-source signed beliefs is caller/ACL authorized,
  transactional, re-signed, and hashed-audited (ADR-079). Strategies and
  multi-source unsigned beliefs remain withheld.
- Strict MCP file ingestion propagates the authenticated caller through the existing extractor and signs a file-content digest; absolute source paths are omitted (ADR-080).
- Weekly stale-memory archive transactionally snapshots and archives both source and canonical projection (ADR-081).

- `ADR-161-authorize-strict-forget-inside-transaction.md`: validates caller, signed source, ACL, lifecycle, and audit atomically for direct strict deletion.

- `ADR-162-withhold-unscoped-mental-models-under-strict-trust.md`: blocks unscoped mental-model reads, writes, and LLM refresh under strict trust.

- `ADR-163-withhold-unscoped-progressive-disclosure-under-strict-trust.md`: denies legacy preview/index/session reads and mutations under strict trust.
- `ADR-164-withhold-unscoped-confidence-updates-under-strict-trust.md`: denies direct memory confidence updates under strict trust until caller and provenance authorization exists.
- `ADR-165-withhold-unscoped-memory-crud-reads-under-strict-trust.md`: denies direct low-level memory content readers and lazy score writes under strict trust; promotion reuses its authorized source read.
- `ADR-166-authorize-low-level-recent-memory-reads-under-strict-trust.md`: scopes direct recent-memory reads by caller and provenance/ACL in strict mode, ignoring untrusted candidate SQL.
- `ADR-167-withhold-unscoped-memory-aggregates-and-maintenance-candidates.md`: denies direct aggregate statistics and low-importance maintenance candidates under strict trust.
- `ADR-168-withhold-unscoped-maintenance-and-temporal-aggregates.md`: denies direct recalculation, consolidation/reversal, and temporal/consolidation aggregate helpers under strict trust.
- `ADR-169-withhold-direct-memory-inspection-under-strict-trust.md`: denies low-level raw memory inspection and its runtime state helper under strict trust.
- `ADR-170-withhold-unscoped-temporal-lifecycle-helpers.md`: denies unscoped temporal validity, supersession, and relation-linking helpers under strict trust; caller-scoped signed personal expiry is enabled by ADR-220.
- `ADR-171-scope-legacy-memory-reports-and-bridges.md`: denies direct unscoped staleness reports under strict trust and restricts bridge paths/metrics to project-local endpoints.
- `ADR-172-audit-stale-lifecycle-denials.md`: appends hashed strict-surface denial events for direct stale reads, batch cleanup, and unauthenticated permanent deletion.
- `ADR-173-locomo-retrieval-reproducibility-traces.md`: versions the LoCoMo diagnostic trace to capture pinned/effective settings, evidence fingerprints, and score components before accepting retrieval metrics.
- `ADR-174-use-source-session-times-in-locomo-retrieval.md`: seeds the LoCoMo diagnostic with deterministic UTC source-session timestamps to prevent wall-clock write timing from changing recency scores.
- `ADR-175-fix-locomo-evaluation-clock.md`: fixes the diagnostic retrieval as-of clock after the dataset timeline so heuristic recency score traces can be compared exactly.
- `ADR-176-opt-in-qmd-subprocess.md`: makes QMD subprocess access default-off because first-use model downloads may use the network.
- `ADR-177-withhold-generic-edge-creation-under-strict-trust.md`: denies generic canonical edge creation and withholds automatic place edges under strict trust.
- `ADR-178-atomic-strict-entity-edge-creation.md`: makes the authorized signed entity-edge check, hashed audit, duplicate validation, and SQLite insertion atomic.
- `ADR-179-attest-legacy-entity-edges.md`: adopt explicitly mapped legacy entity relations only when signed supporting memories pass the strict caller-scoped graph gate.

- ADR-185-strict-team-activity-audit-boundary.md: strict trust withholds team audit activity until caller-scoped membership and visibility checks are implemented.
- ADR-186-windows-opencode-cli-launch.md: safely invoke the OpenCode `.cmd` CLI shim on Windows and verify session write-back handoff.
- ADR-187-track-source-dirt-for-benchmark-provenance.md: define benchmark source cleanliness over staged and unstaged tracked changes, excluding scratch files.
- ADR-188-pin-memory-oracle-benchmark-inputs.md: pin the local oracle retrieval configuration and report the exact fixture digest/effective flags.
- ADR-189-postgres-memory-analysis-queue.md: add PostgreSQL enqueue storage for ordinary memory analysis jobs while retaining strict-write gates.
- ADR-190-use-postgres-project-uuid-for-memory-jobs.md: correct the PostgreSQL project ORM and memory-job project keys to the UUID base schema; supersedes ADR-189's initial fixture type.
- ADR-191-withhold-raw-graph-export-under-strict-trust.md: reject raw graph JSON/HTML export before data access or file writes under strict trust.
- ADR-192-withhold-incremental-graph-stats-under-strict-trust.md: withhold process-wide incremental graph counters and resets before project lookup under strict trust.
- ADR-193-withhold-direct-multi-hop-under-strict-trust.md: enforce ADR-064 at the exported multi-hop helper before extraction or retrieval.
- ADR-194-withhold-association-rows-under-strict-trust.md: deny direct memory-association rows and statistics with hashed audits under strict trust.
- ADR-195-withhold-unscoped-graph-projection-under-strict-trust.md: deny unscoped graph rebuild, extraction/storage, capture-sync, and clearing under strict trust while preserving authorized edge writes and forget cleanup.
- ADR-196-withhold-unscoped-graph-maintenance-and-llm-egress.md: deny direct entity deduplication, graph snapshot publication, and LLM-backed entity extraction under strict trust while retaining explicit local regex extraction.
- ADR-197-preserve-parallel-typed-edges-in-derivation.md: preserve every typed relation in graph fact derivation.
- ADR-198-withhold-unscoped-procedure-outcome-linking.md: deny direct unscoped procedure-outcome graph linking under strict trust.
- ADR-199-withhold-unscoped-memory-entity-helpers.md: deny legacy unscoped entity listing, lookup, and linking under strict trust.
- ADR-200-confine-graph-support-pruning-to-lifecycle.md: keep graph source pruning private to authorized memory lifecycle transactions.
- ADR-201-withhold-unscoped-place-surfaces.md: deny place catalogs, membership edges, assignment, rules, and walking without caller-scoped provenance under strict trust.
- ADR-202-independent-default-benchmark-judge.md: pin a distinct default judge model to reduce LoCoMo answer self-evaluation bias.
- `ADR-216-strict-postgres-team-promotion.md`: strict PostgreSQL team compilation uses persisted owner-scoped candidate selection, locked signed-source lifecycle revalidation, and atomic promotion/projection/audit writes; local-compatible PostgreSQL compilation stays unavailable.
- `ADR-217-strict-team-stale-cleanup.md`: explicit strict team cleanup requires persisted owner/admin membership and atomically audits and removes stale signed team memories on SQLite and PostgreSQL.

- ADR-291-strict-sqlite-owner-pin-transitions.md: enable transactional, audited owner pin/unpin for signed personal SQLite memories; team/shared and strict PostgreSQL paths remain withheld.

- ADR-292-strict-pinned-context-prefilter.md: prefilter strict pinned context by persisted owner and visibility before limiting, then pass parsed SQLite metadata through provenance verification.
- ADR-293-provider-selected-entity-anchor-count.md: carry a bounded typed entity-anchor count from optional decision providers through retrieval and graph expansion, with sanitized trace metadata.
- ADR-294-project-context-in-session-recovery.md: add bounded, opt-in durable project context beside captured-session recovery evidence.
- ADR-295-strict-session-context-recall-fallback.md: provide project-scoped strict FTS fallback, then revalidate each result through caller-authorized ID reads.
- ADR-296-locomo-hit-rate-denominator.md: define session hit rate over all scorable questions and version the report contract.
- ADR-297-strict-encrypted-sqlite-memory-capture-and-read.md: enable provenance-signed strict SQLite encrypted capture and caller-authorized ID reads while keeping search, team sharing, and PostgreSQL parity withheld.
- `ADR-306-strict-delete-authority.md`: separate strict read visibility from permanent-delete authority; personal memories are owner-only and team deletion requires owner/admin membership.

- `ADR-307-source-time-temporal-memory-contract.md`: preserve source event time and write time separately; make explicit temporal read controls consistent and validity intervals half-open.
- `ADR-308-bitemporal-correction-history.md`: define corrections as recorded-time content revisions that preserve valid-time bounds while snapshots retain the prior valid interval and recorded clock.
- `ADR-314-encrypted-strict-correction-history.md`: SQLite direct encrypted corrections and owner-only correction history use identity-bound encrypted snapshots; strict proposals and key rotation remain withheld.
- `ADR-312-bind-strict-graph-cache-to-edge-evidence.md`: bind cached strict graph authorization to the exact edge evidence and temporal bounds it validated.

