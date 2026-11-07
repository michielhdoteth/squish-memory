# Squish

Local-first memory runtime for AI agents.

Squish stores durable memory in SQLite and exposes it through a CLI, MCP server, and selected host integrations. Retrieval can use lexical, semantic, temporal, and graph signals depending on the enabled profile and configuration. Retrieved context is evidence for an agent; it does not guarantee a correct answer.

Squish Core is first-party open-source software under the MIT License. You may use, modify, distribute, and integrate it into personal or commercial applications, including proprietary software, subject to the MIT License terms and notices. Squish Cloud subscriptions and managed inference are separate commercial services; they are not required for local use.

- **Local storage** — the core runtime uses a local SQLite database. Configured model providers, downloads, updates, and optional services may use the network.
- **Retrieval signals** — query results can include confidence information and source references. Their usefulness depends on the corpus, query, and enabled retrieval path.
- **Temporal and graph relations** — the runtime stores time-aware facts and typed relationships for supported retrieval paths.
- **Decision layer** — rules run first; optional model escalation is separately configured and is not the answer-generation model.
- **Host interfaces** — CLI and MCP, with supported host integrations documented per release.

---

## Why Squish

| Capability | What it does |
|------------|--------------|
| Retrieval confidence | Some retrieval paths return confidence and evidence signals; they are not a guarantee of downstream answer accuracy |
| Abstention | Strict retrieval paths can return `NO CONFIDENT MATCH` when no result clears their configured threshold |
| Hybrid retrieval | Vector + FTS5/BM25 lexical + belief search fused with RRF, plus optional cross-encoder reranking |
| Temporal validity at query time | Past-referencing queries retrieve what was true then -- "what frameworks was I using in March?" |
| Knowledge graph | Typed edges (related_to, depends_on, contradicts, placed_in) feeding retrieval and contradiction handling |
| Decay and tiering | Ebbinghaus retention scoring, stability tiers, pinned protection |
| Decision-model layer | Rules-first memory decisions with optional confidence-gated escalation to a small fast model (local or hosted) |
| Local-first, open source | Core memory storage uses SQLite locally and is MIT licensed. Optional provider and host features may use the network |
| MCP and CLI | MCP tools and CLI commands expose memory operations; host coverage varies by release |
| Evaluation | The repository includes deterministic retrieval diagnostics. They do not measure model-generated answer quality |

The evaluation section describes the limits of the available evidence. Retrieval-only diagnostics do not establish answer quality, action success, or a comparable ranking across systems.

---

## Current installation status

As checked on 2026-11-01, the published npm package is `1.9.0`, while this source checkout declares `2.2.0` and has not been published. The published package has not passed current data-path and host-compatibility checks. Installation commands for this checkout are withheld until a matching release and update path are verified. Do not use the stale registry package for customer data.

## For developers

This repository contains the current source, not a published `2.2.0` release. CLI, MCP, and desktop are separate interfaces with release-specific support. Check release status before installing or configuring a host.

- **squish CLI** — remember, recall, search, and stats
- **MCP server** — MCP-compatible clients can connect when the current release supports their transport and setup.
- **Desktop** — visual memory browser and knowledge graph explorer

That's it. No separate SDK to install, no second package to version, no HTTP client to maintain.

If you need to access Squish from your own JS/TS code:
- In-process TypeScript: `@squish/core-sdk` is workspace-internal and is not a public SDK.
- Local HTTP MCP: `squish mcp --http` serves local clients and binds to localhost by default; it is not the hosted API.

MCP is the standardized programmatic interface. There is no @squish/sdk.

---

## Desktop App

The latest published desktop release is `2.1.1` and currently provides a Windows installer. The installer is unsigned and has not been validated against this `2.2.0` source checkout. Check the release notes and signing status before installation.

[View Desktop Releases](https://github.com/michielhdoteth/squish-memory/releases)

---

## How It Works

```
Capture → Distill → Store → Score → Recall
   ↓         ↓        ↓       ↓       ↓
 Hooks    Signal    SQLite  FTS5+   MCP/CLI
          Engine    +Graph  Vector  +WebUI
```

1. **Capture** — add memories through the CLI, MCP, or a configured host integration; host coverage varies.
2. **Distill** — rules classify supported observations; optional decision-model escalation can be enabled separately.
3. **Store** — local memory data is persisted in SQLite; graph derivation and lifecycle behavior depend on the active profile.
4. **Retrieve** — lexical and semantic search are available, with optional temporal, graph, and reranking paths.
5. **Recall** — the caller receives retrieved context and evidence to use in its own response.

---

## Host compatibility

Host integrations and setup vary by release. The current published package does not match this source checkout, so per-host installation commands are withheld until package and client compatibility are verified.

---

## Architecture

```
Your AI Tool (Claude Code, Cursor, etc.)
        |
    squish-mcp (MCP server)
        |
    squish-core (memory engine)
        |
    SQLite (user data directory, usually ~/.squish/squish.db)
```

- **Local-first**: Core memory storage is local; configured providers, host integrations, downloads, and updates may use the network
- **No account required for local use**: Hosted features, when available, have separate account and service requirements
- **BYOK**: Bring your own provider credentials for supported model or embedding paths
- **MCP interface**: Clients must support the transport and configuration used by the selected Squish release

---

## CLI

```bash
squish remember "Use Drizzle ORM, not Prisma"
squish recall "What ORM should I use?"
squish search "database"
squish stats
```

---

## Hosted services

The hosted API responds, but as checked on 2026-11-01 its live plan catalog does not return pricing or a cloud-sync entitlement. The landing site does not enable checkout in this build. Treat paid-plan purchase and cross-device synchronization as unverified until the live catalog and checkout agree. Managed AI is not enabled and the current source plan configuration grants no managed-AI allowance. Local inference and BYOK remain separate options where supported.

---

## Security

Squish's HTTP server (`squish mcp --http`) binds to localhost by default and is intended for local use only. HTTP mode transmits data in plaintext -- do not expose it to the internet without a TLS-terminating reverse proxy (e.g., Nginx, Caddy, Cloudflare Tunnel).

For remote access:

1. Set up a reverse proxy with TLS termination in front of the Squish HTTP server.
2. Restrict network access to authorized clients only.
3. Never bind the Squish HTTP server directly to a public interface.

The local SQLite database is stored under the user's Squish data directory (usually `~/.squish/squish.db`, or its platform equivalent). Do not assume the whole database is encrypted at rest; restrict file access and use operating-system disk encryption where required.

---

## Benchmarks

The public benchmark page does not currently publish a comparable end-to-end answer-quality or agent-task score. A committed 46-query fixture report records retrieval-only metrics, but it is a small historical diagnostic; it does not establish model-backed answer quality, action success, or superiority to another system. See [`docs/BENCHMARK.md`](docs/BENCHMARK.md) for the exact fixture, historical run caveats, and reproducibility instructions. Do not reuse the older ECE 0.055 marketing figure as a current result.

---

## Decision Models

Squish makes structured memory decisions with a rules-first engine, and can escalate each decision to a small fast model when you enable the decision layer. Rules always execute first and are the fallback: the model wins only when it is enabled AND confident, and any failure, timeout, or malformed output leaves the rule result untouched.

**Built-in rules (always on, no LLM)**:
- **Write classification** — regex pattern matching classifies observations into episodic, semantic, procedural, preference, or discard
- **Relation judging** — lexical heuristics classify pairs of memories as temporal, causal, entity, or semantic relations
- **Query routing** — lexical heuristics map queries to temporal/causal/entity/semantic retrieval views
- **Prompt gate** — opt-out phrases ("without using memory"), greetings, and task cues decide whether the harness hook searches memory for context

**Model escalation (opt-in)** — set both `SQUISH_DECISION_LAYER_ENABLED=true` and `SQUISH_DECISION_MODEL_ENABLED=true`. Decision inference has an explicit backend, independent from ordinary language-model generation:

- `SQUISH_DECISION_MODEL_BACKEND=systemone` selects a typed decision provider. Choose its provider with `SQUISH_DECISION_SYSTEMONE_PROVIDER` (for example, `ollaya`, `typesafe`, `laya`, or `cloudflare`) and configure that provider's credential separately. Hosted providers also require `SQUISH_DECISION_HOSTED_EGRESS_ENABLED=true`; this sends decision content to that provider. Local `ollaya` does not require this flag. This path does not use the ordinary language-model writer or its credentials.
- `SQUISH_DECISION_MODEL_BACKEND=llm` uses the chat-model adapter, `SQUISH_DECISION_MODEL_PROVIDER`, and `SQUISH_LLM_REASONING_MODEL`. This is the compatibility default when no backend is specified.
- `SQUISH_DECISION_MODEL_BACKEND=off` keeps every decision rules-only. Invalid explicit backends fail closed to `off`; invalid provider names fail closed with no provider call. Neither case falls back to the language-model writer or another decision provider.

The complete provider, credential, and egress configuration is in [Decision model configuration](docs/ENV-CONFIG.md#decision-model-layer).

| Decision site | Wired into | Escalates when | Model wins at |
|---|---|---|---|
| Write classification | `squish_remember` type detection | model enabled | confidence ≥ 0.8 |
| Relation judging | contradiction validator | model enabled | confidence ≥ 0.75 |
| Query routing | `autoRoute` | rules confidence < 0.6 | confidence ≥ 0.7 |
| Prompt gate | `squish gate` | rules uncertain | confidence ≥ 0.7 |

Key behaviors:

- **Fail-safe**: every site falls back to its rule result; the gate fails open to "search anyway"; `SQUISH_DECISION_LAYER_ENABLED=false` disables the entire layer in one flag. Missing credentials and invalid backend/provider values do not redirect decision prompts to another provider.
- **Bounded**: hot-path model calls get 300 ms, write-path 1000 ms, one attempt, no retries.
- **Private**: no prompt text or content in logs — only source, latency, and confidence.

```
squish/core/decision-model/
├── model.ts       # DecisionModel rules — classifyMemoryType, judgeRelation, routeQuery
├── decisions.ts   # Pattern-based classification logic (no LLM calls)
├── provider.ts    # DecisionModelClient — rules-first escalation, model-only primitives
├── prompts.ts     # Prompt templates + strict JSON parsers
└── types.ts       # MemoryObservation, ClassificationDecision, RelationDecision, RetrievalDecision
```

The harness prompt gate (`core/hooks/prompt-gate.ts`, CLI `squish gate`) runs on every submitted prompt: `squish install` registers a UserPromptSubmit hook (`plugin/scripts/new-hook.js`) in Claude Code's settings and in the Codex plugin bundle, and that hook spawns the gate detached, so the prompt is never blocked. The gate spawns `squish context <queryHint>` only when the decision is to search. With the decision layer off (the default) the gate fails open -- search anyway -- in one fast CLI call, and if the gate binary is missing or broken the hook still exits clean, never erroring the host. OpenCode has no JSON hook registration (its config schema has no `hooks` key); its integration runs through the plugin SDK. See `.env.example` and [docs/ENV-CONFIG.md](docs/ENV-CONFIG.md) for the full configuration surface.

---

## License

**MIT** -- Free to use, modify, and distribute. No copyleft obligations.

See [LICENSING.md](../LICENSING.md) for details.
