# Squish Configuration

Squish uses a **hybrid configuration system**: settings.json for preferences, environment variables for overrides and secrets.

## Configuration Priority

| Priority | Source | Use Case |
|----------|--------|----------|
| 1st | Environment Variables | Secrets, overrides, CI/CD |
| 2nd | `config/settings.json` | User preferences, defaults |
| 3rd | `config.ts` | Fallback defaults |

## Configuration Files

### 1. config/settings.json

Main configuration file with all available options:

```json
{
  "version": "1.2.0",

  "data": {
    "dir": ".squish"
  },

  "mcp": {
    "serverPort": 8767,
    "serverEnabled": true,
    "mode": "stdio"
  },

  "database": {
    "type": "sqlite",
    "url": ""
  },

  "embeddings": {
    "enabled": true,
    "provider": "local",
    "timeout": 30000,
    "models": {
      "openai": { "model": "" },
      "google": { "model": "", "location": "us-central1" },
      "ollama": { "url": "http://localhost:11434", "model": "" },
      "lmstudio": { "url": "http://localhost:1234", "model": "" },
      "transformers": { "model": "", "device": "cpu" }
    }
  },

  "api": {
    "openai": { "apiKey": null, "apiUrl": "https://api.openai.com/v1/embeddings" },
    "google": { "apiKey": null, "projectId": null, "location": "us-central1" },
    "ollama": { "url": "http://localhost:11434" },
    "lmstudio": { "url": "http://localhost:1234" }
  },

  "security": {
    "encryptionEnabled": false,
    "encryptionPassphrase": ""
  },

  "features": {
    "lifecycleEnabled": true,
    "summarizationEnabled": true,
    "agentIsolation": true,
    "governanceEnabled": true,
    "consolidationEnabled": false
  },

  "multimodal": {
    "enabled": true,
    "inboxDir": "./inbox",
    "pollIntervalMs": 5000,
    "maxFileSizeBytes": 104857600
  },

  "consolidation": {
    "llmEnabled": false,
    "batchSize": 50,
    "minAgeDays": 7,
    "minConnections": 2
  },

  "lifecycle": {
    "interval": 3600000,
    "decay": {
      "threshold": 0.1,
      "episodic": 30,
      "semantic": 90,
      "procedural": 180,
      "autobiographical": 365,
      "working": 7
    }
  },

  "scoring": {
    "weights": {
      "recency": 0.5,
      "relevance": 3,
      "importance": 2,
      "vectorSim": 3,
      "graphBoost": 1.5
    }
  },

  "scheduler": {
    "mode": "cron",
    "cronEnabled": true,
    "heartbeatInterval": 60000,
    "jobRetentionDays": 30
  },

  "supabase": {
    "url": "",
    "key": ""
  },

  "neon": {
    "projectId": "",
    "serviceKey": ""
  }
}
```

### 2. .env (Data Directory)

Encryption passphrase and secrets only. Located in the data directory (`.squish/.env`):

```bash
# Encryption passphrase (set manually in .squish/.env)
SQUISH_ENCRYPTION_PASSPHRASE=your-secure-passphrase
# Enable client-side encryption (also configurable in settings.json)
SQUISH_ENCRYPTION_ENABLED=true
```

### 3. Environment Variables (Override)

Override settings.json via environment:

```bash
# Override embeddings provider
SQUISH_EMBEDDINGS_PROVIDER=ollama
SQUISH_OLLAMA_EMBEDDING_MODEL=<ollama-embedding-model>

# Override MCP port
SQUISH_MCP_PORT=9000

# Enable encryption passphrase
SQUISH_ENCRYPTION_PASSPHRASE=my-secret

# Multimodal Ingestion
SQUISH_MULTIMODAL_ENABLED=true           # Enable/disable multimodal (default: true)
SQUISH_MULTIMODAL_INBOX_DIR=./inbox      # Inbox directory for file watcher
SQUISH_MULTIMODAL_POLL_INTERVAL_MS=5000  # Watcher poll interval in ms
SQUISH_MULTIMODAL_MAX_FILE_SIZE_BYTES=104857600  # Max file size (default: 100MB)

# LLM Consolidation
SQUISH_LLM_CONSOLIDATION_ENABLED=false   # Enable LLM cross-connection finding
SQUISH_LLM_CONSOLIDATION_BATCH_SIZE=50   # Batch size for analysis
SQUISH_LLM_CONSOLIDATION_MIN_AGE_DAYS=7  # Min memory age before consolidation
SQUISH_LLM_CONSOLIDATION_MIN_CONNECTIONS=2  # Min existing connections threshold
```

#### Language LLM

Language-model calls are disabled by default and use a separate opt-in from the
decision-model layer below. For OpenAI, set `SQUISH_LLM_ENABLED=true` and
`SQUISH_OPENAI_API_KEY`; without a custom endpoint the provider uses
`https://api.openai.com/v1`. For another OpenAI-compatible service, set both
`SQUISH_LLM_ENDPOINT` and `SQUISH_LLM_API_KEY`. The generic key is never sent
to an implicit endpoint, and an ambient `OPENAI_API_KEY` is never forwarded to
a custom endpoint. Credentials are rejected for localhost or insecure
HTTP endpoints; local inference should use the dedicated `ollama` or
`lmstudio` provider instead.

The language LLM extracts or enriches memory content. A decision model is a
separate structured decision provider with independent enablement, credentials,
confidence handling, and fallback behavior. Enabling one does not enable the
other.

#### Decision Model Layer

Rules-first structured decisions with optional model escalation. Rules
always run first and are the fallback; the model wins only when the layer is
enabled AND the model is confident. Everything defaults off.

```bash
# Master kill switch: false disables the whole layer in one flag
SQUISH_DECISION_LAYER_ENABLED=false
# Enables model escalation at all sites
SQUISH_DECISION_MODEL_ENABLED=false
# Escalation engine: off | llm | systemone. Default llm preserves the
# chat-model escalation path. systemone + ollaya (provider default) is the
# recommended private/calibrated path: localhost-only, calibrated confidences,
# millisecond answers.
SQUISH_DECISION_MODEL_BACKEND=llm
# Provider for the LLM backend: auto (follows SQUISH_LLM_PROVIDER) or a name
SQUISH_DECISION_MODEL_PROVIDER=auto
# Global confidence floor (wired): model verdicts below it never beat the
# rules; raising it tightens every site band at once. The risk-tiered per-site
# bands stay as lower bounds: 0.8 type override, 0.75 relation veto,
# 0.7 route, 0.7 prompt gate.
SQUISH_DECISION_CONFIDENCE_THRESHOLD=0.7
# Hot-path (route) model timeout in ms (LLM backend)
SQUISH_DECISION_ROUTE_TIMEOUT_MS=300
# Write-path (classify) model timeout in ms (LLM backend)
SQUISH_DECISION_CLASSIFY_TIMEOUT_MS=1000

# Harness prompt gate (rules-only, zero cost, local; needs the layer enabled)
SQUISH_PROMPT_GATE_ENABLED=true
# Gate model escalation for uncertain prompts (also needs
# SQUISH_DECISION_MODEL_ENABLED=true)
SQUISH_PROMPT_GATE_MODEL_ESCALATION=false
# Gate model timeout in ms; the gate itself runs detached, never blocking
SQUISH_PROMPT_GATE_TIMEOUT_MS=300
```

LLM-backend decision calls always use `SQUISH_LLM_REASONING_MODEL` as the
model name and reuse the existing provider registry
(openai/anthropic/google/ollama/lmstudio). See [README](../README.md) under
Decision Models for the wired call sites and thresholds.
`auto` is an intentional choice; an invalid explicit provider is rejected and
does not fall back to the ordinary LLM provider. An invalid backend also
resolves to rules-only (`off`).

##### System One backend (SQUISH_DECISION_MODEL_BACKEND=systemone)

A decision model answers typed questions with bounded structured outcomes. The
System One-compatible providers use TypeSafe's `/v1/systemone` contract. Cloudflare
Clef uses the Workers AI REST endpoint with its documented model ID and selector.

```bash
# Provider preset: ollaya | openrouter | typesafe | laya | cloudflare | vercel
SQUISH_DECISION_SYSTEMONE_PROVIDER=ollaya
# Override the preset API root (default ollaya: http://localhost:11435/v1)
SQUISH_DECISION_SYSTEMONE_BASE_URL=
# Override the preset model id (ollaya: winnow:e4b, openrouter:
# typesafe/jev-1.13, typesafe: jev-latest, laya: jev-latest compatibility alias,
# cloudflare: @cf/cloudflare/clef,
# @cf/cloudflare/clef-flash, or @cf/cloudflare/clef-omni)
SQUISH_DECISION_SYSTEMONE_MODEL=
```

An invalid System One provider name is rejected and never falls back to the
local default provider.

Hosted providers require the additional opt-in
`SQUISH_DECISION_HOSTED_EGRESS_ENABLED=true`. It defaults to false and blocks
the transport before any hosted request; local `ollaya` is unaffected. This
setting is an egress consent gate, not a spend limit or billing control.

Provider keys come from the environment only and are never stored in
settings.json:

| Provider   | Key env var                                     | Status                          |
|------------|--------------------------------------------------|---------------------------------|
| ollaya     | none (local runtime, 127.0.0.1:11435)            | default, private                |
| openrouter | `OPENROUTER_API_KEY`                             | wire-identical systemone        |
| typesafe   | `SQUISH_DECISION_TYPESAFE_API_KEY` or `TYPESAFE_API_KEY` | wire-identical systemone |
| laya       | `LAYA_API_KEY`                                 | hosted Jev-compatible API; 32-question cap, live quality/calibration unverified |
| cloudflare | `CLOUDFLARE_AI_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`  | Clef family; mocked contract, live-key validation pending |
| vercel     | -                                                | gated: requires the AI SDK evaluate integration (not bundled) |

Privacy and egress:

- With provider `ollaya`, requests go to localhost only: no decision content
  ever reaches a third party.
- With a hosted provider (`openrouter`, `typesafe`, `laya`, `cloudflare`), decision
  content (max 2000 characters per request) is sent to that endpoint and
  Squish emits a one-time info log naming the target when the backend is
  first used. Missing keys fail closed: the rules stand and no request is
  sent.
- Decision egress is governed by `SQUISH_DECISION_MODEL_BACKEND` /
  `SQUISH_DECISION_MODEL_ENABLED`, NOT by the master `SQUISH_LLM_ENABLED`
  flag: the decision layer and the extraction LLM opt in independently.

Timeouts: System One models answer in ~20-330ms, so the client budgets 500ms
for the local ollaya endpoint and 2500-3000ms for hosted surfaces (one
bounded attempt, no retries; on any timeout the rules stand).

#### Project Scope

`SQUISH_WORKING_DIRECTORY` decides which project every default write and recall
lands in. Resolution order: `SQUISH_WORKING_DIRECTORY`, then `INIT_CWD`, then
the process working directory. A blank value is treated as unset.

```bash
# Absolute path to the workspace that should own memories by default
SQUISH_WORKING_DIRECTORY=/absolute/path/to/workspace
```

You rarely need to set this. The `squish` and `squish-mcp` wrappers forward the
directory they were launched with, so MCP hosts (opencode, claude, cursor) get
their session workspace automatically. Set it to pin one fixed scope, for
example when a systemd unit or a scheduled job has an arbitrary cwd.

Rules that follow from how the value is stored:

- Use an absolute path. A leading `~/` or `~\` is expanded; relative paths are
  resolved against the process working directory.
- It must match a `projects.path` row for project-scoped reads to return
  anything. Writes create the row on demand; reads do not invent one.
- The value is trimmed and normalised, so surrounding whitespace and a trailing
  separator do not create a second, near-identical project.

#### Write-time Near-Duplicate Dedup (WS2a)

`SQUISH_WRITE_DEDUP` (settings key `features.writeDedup`) adds a near-duplicate
stage to the remember path, after the memory is stored. Three modes:

| Mode | Behavior | Default |
|------|----------|---------|
| `off` | Nothing runs. Shipped default: identical behavior and write latency. | yes |
| `link` | Bounded top-K similarity scan in the new memory's own scope; each near-duplicate gets a bidirectional `near_duplicate` association and the new memory records `metadata.dedup = { mode, detectedAt, similarIds, maxSimilarity }`. Non-destructive. | no |
| `merge` | Explicit opt-in. Near-duplicates run through the existing reversible merge workflow (proposal -> approve-merge -> single canonical + snapshot history, undoable by reverse-merge). | no |

Safety guarantees:

- `off` and `link` NEVER drop, merge, or rewrite any memory. In `link` mode both
  the new and the existing memory stay active; only associations and lightweight
  metadata are added.
- `merge` is the only mutating mode and reuses the proven transactional
  approve-merge machinery, so every merge keeps a snapshot history and is
  reversible via the existing reverse-merge. Any safety-check blocker (type
  mismatch, immutable/merged/inactive source, low similarity) degrades to
  `link`, and a projectless memory (no proposal row is possible without a
  project) also falls back to `link`. Nothing is ever silently dropped.
- Detection is strictly same-scope: near-duplicates from a different project or
  team are never linked, even if the similarity search surfaces them.
- The scan is a bounded top-K (`SQUISH_WRITE_DEDUP_TOP_K`, default 5) through
  the regular similarity search, not a full-corpus pass. It still runs the same
  retrieval pipeline a recall would, so `link` mode costs roughly one extra
  search per write (measured locally: median write latency rises from ~72ms to
  ~165-172ms on a small corpus; association/metadata cost itself is <1ms).

Threshold: `SQUISH_WRITE_DEDUP_THRESHOLD` defaults to **0.85** - this REUSES
the existing detector bar (the semantic threshold that `findSimilarMemories`
and the two-stage detector's `DetectionOptions.threshold` gate on); it is not
a new invented value. An empty or invalid value falls back to the 0.85
default at this read (WS2a carryover guard: `Number('') === 0` would
otherwise link every write; the shared numeric config parser is unchanged).
The SimHash/MinHash prefilter of the nightly two-stage detector requires a
corpus-wide pass and therefore stays out of the write path.

WS3 plans to ship a `high-recall` profile that enables `link` (detection +
linking without any mutation). The nightly `dedup_maintenance` batch and
`SQUISH_DEDUP_AUTO` are unchanged by this stage.

```bash
SQUISH_WRITE_DEDUP=off                     # off | link | merge
SQUISH_WRITE_DEDUP_THRESHOLD=0.85          # near-duplicate semantic bar (reused detector bar)
SQUISH_WRITE_DEDUP_TOP_K=5                 # bounded candidate window per write, never a full scan
```

## Quick Reference

### Embeddings Provider

| Provider | API Key | Description |
|----------|--------|------------|
| `local` | No | TF-IDF (default, free) |
| `openai` | Yes | Requires `SQUISH_OPENAI_EMBEDDING_MODEL` |
| `ollama` | No | Requires `SQUISH_OLLAMA_EMBEDDING_MODEL` |
| `google` | Yes | Requires `SQUISH_GOOGLE_EMBEDDING_MODEL` |
| `lmstudio` | No | Requires `SQUISH_LM_STUDIO_EMBEDDING_MODEL` |
| `transformers` | No | Requires `SQUISH_LOCAL_MODEL` |

### Database Mode

| Mode | Database | Use Case |
|------|----------|----------|
| `local` | SQLite | Single user, free |
| `team` | PostgreSQL | Squish Cloud team workspace only |
| `remote` | Supabase/Neon | Cloud backend |

## Example Configurations

### Local Mode (Default)

```json
{
  "mcp": { "serverPort": 8767 },
  "embeddings": { "provider": "local" },
  "features": { "lifecycleEnabled": true }
}
```

### Team Mode (Squish Cloud)

```json
{
  "managed": { "enabled": true },
  "database": { "type": "postgres", "url": "postgres://user:pass@host/db" },
  "embeddings": { "provider": "openai", "models": { "openai": { "model": "<openai-embedding-model>" } } },
  "api": { "openai": { "apiKey": "sk-..." } }
}
```

### Remote Mode (Supabase)

```json
{
  "remote": { "backend": "supabase" },
  "supabase": { "url": "https://xxx.supabase.co", "key": "xxx" },
  "embeddings": { "provider": "openai", "models": { "openai": { "model": "<openai-embedding-model>" } } }
}
```

## Security Note

The following are NOT available via MCP (must be configured manually):
- Encryption passphrase: Edit `.squish/.env` directly
- API keys: Use environment or settings.json

## Troubleshooting

```bash
# Check current config
squish context --json

# Health check
squish health

# MCP verification
squish-mcp --health
```

## Retrieval profiles

`SQUISH_PROFILE=fast-local` is the default. It disables reranking, query
expansion, and contextual enrichment. `SQUISH_PROFILE=high-recall` enables
those local retrieval stages and bounded graph expansion where the caller
supports it. Both profiles remain offline; profile selection never enables a
remote provider or network egress. Explicit `SQUISH_RERANKER_ENABLED`,
`SQUISH_QUERY_EXPANSION`, and `SQUISH_CONTEXTUAL_RETRIEVAL` values override
profile defaults. `SQUISH_VECTOR_SCAN=full` is the recall-first default;
`recency` is an explicit latency tradeoff. ACL/trust settings are independent
of retrieval profiles.

The reranker loads cached model files only by default. Set
`SQUISH_ALLOW_MODEL_DOWNLOADS=true` to permit downloading a missing local model
from its configured model host; choosing `high-recall` alone never initiates
that network request.

## Strict trust policy

`SQUISH_TRUST_POLICY=strict` enables fail-closed ACL enforcement and durable,
minimized audit events for SDK memory search. It requires an explicit caller
ID and a versioned Ed25519 signature on each returned record. Configure
`SQUISH_PROVENANCE_PRIVATE_KEY` and `SQUISH_PROVENANCE_KEY_ID` for signed
writes. Configure `SQUISH_PROVENANCE_PUBLIC_KEY` with the same key ID, or
`SQUISH_PROVENANCE_PUBLIC_KEYS` as a JSON object from key IDs to PEM public
keys, for verification. When the key map is set, it is authoritative: omitted
key IDs are rejected even if the single-key fallback is also set. Keep private
keys in the environment or secret store;
never in the database. Unsigned legacy rows are denied. Local-compatible mode
remains the default and does not require key configuration.

Strict enforcement currently covers SDK memory search. Direct ID, context,
and graph reads still need the shared gate before strict mode is a complete
trust boundary for every interface.
