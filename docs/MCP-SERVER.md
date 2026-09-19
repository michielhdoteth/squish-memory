# Squish Memory Infrastructure — MCP Server

Universal memory layer for AI agents via Model Context Protocol (MCP). Local-first, works with any MCP-compatible client.

## What it is

The Squish MCP server is how agents talk to Squish's memory runtime. It exposes 15 tools by default, with a 16th (squish_maintenance) gated behind `SQUISH_ENABLE_MAINTENANCE_TOOLS=true`. The server runs locally via stdio (default) or Streamable HTTP. Under the hood it uses the same runtime as the CLI and SDK — SQLite or PostgreSQL storage, local TF-IDF embeddings, hybrid retrieval, belief engine, decay, and knowledge graph.

## Quick start

### STDIO Mode (Default)

```bash
squish-mcp
```

### HTTP Mode

```bash
squish-mcp --http --port 8767
```

Or via environment:

```bash
SQUISH_MCP_MODE=http SQUISH_MCP_PORT=8767 squish-mcp
```

Server runs on `http://localhost:8767` by default in HTTP mode.

### Health check

```bash
squish-mcp --health
```

Expected output:

```
[MCP] Running health check...
[MCP] Health check passed. Server initialized with 16 tools.
```

### Endpoints (HTTP Mode)

- **Health**: `GET /health` — Server status, backend health, tool count
- **MCP**: `POST /mcp` — Streamable HTTP endpoint for MCP calls

## Tools

### 1. squish_remember

Store any memory, learning, or ingest media files. System auto-detects type and routes appropriately. Supports multimodal ingestion via file path.

```json
{
  "name": "squish_remember",
  "arguments": {
    "content": "Implemented OAuth2 flow with PKCE for better security",
    "type": "decision",
    "tags": ["auth", "security"]
  }
}
```

Multimodal ingestion (image, audio, video, document):

```json
{
  "name": "squish_remember",
  "arguments": {
    "filePath": "/absolute/path/to/file.pdf",
    "description": "Architecture diagram for the auth service",
    "tags": ["architecture", "auth"]
  }
}
```

**Parameters:**
- `content` (optional): Text content to store. Provide either `content` or `filePath`.
- `filePath` (optional): Absolute path to a media file to ingest. Provide either `content` or `filePath`.
- `type` (optional): Memory type hint — `observation`, `fact`, `decision`, `context`, `preference`, `note`. Auto-detected if omitted.
- `tags` (optional): Array of tags for organization.
- `description` (optional): Description or context for file ingestion.

Auto-detection: the tool classifies content into memory, learning (success/failure/fix/insight), or note based on patterns in the text.

### 2. squish_recall

Recall memories by query, or retrieve a specific memory by ID. Returns a top-level `recallAssessment` with a calibrated verdict.

```json
{
  "name": "squish_recall",
  "arguments": {
    "query": "authentication implementation",
    "limit": 5,
    "project": "/path/to/project"
  }
}
```

Retrieve by ID:

```json
{
  "name": "squish_recall",
  "arguments": {
    "query": "uuid-string"
  }
}
```

**Recall assessment verdicts:**
- `confident` — best match >= 0.90, rely on it
- `qualified` — best match plausible but not certain, verify before relying on it
- `no_reliable_memory` — no result clears the reliability floor, treat as no memory found

**Parameters:**
- `query` (required): Query text or memory ID to recall.
- `limit` (optional, default 5): Maximum results for query recall.
- `project` (optional): Project path filter.

### 3. squish_forget

Delete a memory by ID, or bulk delete with search filters.

```json
{
  "name": "squish_forget",
  "arguments": {
    "memoryId": "uuid-string"
  }
}
```

Bulk delete by search (dry-run by default):

```json
{
  "name": "squish_forget",
  "arguments": {
    "search": "old debug notes",
    "confirm": true
  }
}
```

**Parameters:**
- `memoryId` (optional): Memory ID to delete (single, immediate).
- `search` (optional): Search query to match specific memories for bulk delete.
- `confirm` (optional): Must be `true` to execute a destructive bulk delete. Without it, the operation is a dry run.

### 4. squish_link

Manage memory associations: find related memories or add a link between two memories.

```json
{
  "name": "squish_link",
  "arguments": {
    "action": "find",
    "memoryId": "uuid-string"
  }
}
```

Actions:
- `find` — Get related memories (graph traversal)
- `add` — Create association between two memories

**Parameters:**
- `action` (required): `find` or `add`
- `memoryId` (required for `find`): Memory ID to find relations for
- `fromId` (required for `add`): Source memory ID
- `toId` (required for `add`): Target memory ID

### 5. squish_context

Get project context or list registered projects. Use action `session-start` to compose the canonical session-bootstrap context block (token-capped, priority-ordered).

```json
{
  "name": "squish_context",
  "arguments": {
    "project": "/path/to/project",
    "limit": 10,
    "action": "session-start"
  }
}
```

**Parameters:**
- `project` (optional): Project path.
- `limit` (optional, default 10): Maximum memories to return.
- `listProjects` (optional): List registered projects instead of loading context.
- `action` (optional): `"session-start"` — compose the canonical session-start bootstrap block.

### 6. squish_stats

Get memory statistics and system health. Use action to control watcher or run LLM consolidation.

```json
{
  "name": "squish_stats",
  "arguments": {
    "project": "/path/to/project",
    "action": "status"
  }
}
```

**Actions:**
- `status` (default) — Return stats + health + watcher status + consolidation config + QMD availability + version
- `start_watcher` — Start file watcher for multimodal ingestion
- `stop_watcher` — Stop file watcher
- `consolidate` — Run LLM cross-connection finding between memories
- `traces` — Tool-call trace summary (durations, errors, recent calls)
- `engines` — ACL read-gate decision log summary and recent would-filter entries

**Parameters:**
- `project` (optional): Project path filter (global if omitted).
- `action` (optional, default `"status"`): One of the actions above.

### 7. squish_inspect

Explain why a memory was retained, where it was routed, and whether raw fallback exists.

```json
{
  "name": "squish_inspect",
  "arguments": {
    "memoryId": "uuid-string"
  }
}
```

**Parameters:**
- `memoryId` (required): Memory ID to inspect (UUID format).

### 8. squish_skill

Manage reusable skills (SOPs). Skills are versioned workflows with triggers, steps, and validation rules.

Actions: `list`, `get`, `create`, `update`, `delete`, `search`, `versions`, `assign`, `unassign`, `record_usage`.

```json
{
  "name": "squish_skill",
  "arguments": {
    "action": "create",
    "name": "Database Migration SOP",
    "skillType": "workflow",
    "steps": [
      { "step": 1, "action": "backup", "description": "Take full backup before migration" },
      { "step": 2, "action": "run-migration", "description": "Execute migration script" }
    ],
    "tags": ["database", "operations"]
  }
}
```

**Parameters:**
- `action` (required): One of the actions above.
- `skillId` (optional): Skill ID (required for get, update, delete, versions, assign, unassign, record_usage).
- `name` (optional): Skill name (required for create).
- `description` (optional): Skill description.
- `skillType` (optional): `workflow`, `troubleshooting`, `checklist`, `template`, `playbook`.
- `visibility` (optional): `private`, `team`, `restricted`.
- `steps` (optional): Ordered execution steps.
- `triggerConditions` (optional): When this skill should be used.
- `tags` (optional): Tags for organization.
- `agentId` (optional): Agent to assign skill to (for assign/unassign).
- `query` (optional): Search query (for search).
- `status` (optional): Filter by status.
- `success` (optional): Whether usage was successful (for record_usage).
- `changeSummary` (optional): Summary of changes (for update).

### 9. squish_loadout

Manage agent loadouts (bind memory assets to agents) and visibility rules (ACL).

Actions: `add_loadout`, `remove_loadout`, `get_loadout`, `set_visibility`, `remove_visibility`, `check_visibility`, `get_rules`.

```json
{
  "name": "squish_loadout",
  "arguments": {
    "action": "add_loadout",
    "agentId": "agent-1",
    "assetType": "memory",
    "assetId": "memory-uuid",
    "priority": 10,
    "injectionMode": "prepend"
  }
}
```

**Parameters:**
- `action` (required): One of the actions above.
- `agentId` (optional): Agent ID (required for loadout operations).
- `assetType` (optional): `memory`, `skill`, `belief`, `strategy`, `learning`.
- `assetId` (optional): Asset ID.
- `priority` (optional): Priority (higher = loaded first).
- `injectionMode` (optional): `append`, `prepend`, `replace`.
- `ruleType` (optional): `owner`, `team`, `user`, `role`, `everyone`.
- `granteeType` (optional): `user`, `team`, `everyone`.
- `granteeId` (optional): Grantee ID.
- `permission` (optional): `read`, `write`, `admin`.
- `userId` (optional): User ID for visibility check.
- `teamIds` (optional): Team IDs for visibility check.

### 10. squish_extract

Auto-extract reusable skills (SOPs) from accumulated memories using LLM analysis.

Actions: `run`, `status`.

```json
{
  "name": "squish_extract",
  "arguments": {
    "action": "run",
    "hoursBack": 24,
    "projectId": "project-uuid"
  }
}
```

**Parameters:**
- `action` (required): `run` or `status`.
- `hoursBack` (optional, default 24): How many hours back to look for memories.
- `projectId` (optional): Project ID to extract from.

### 11. squish_feedback

Reinforce or weaken a recalled item. Push confirm/used/contradict signals back into memory, beliefs, or strategies.

```json
{
  "name": "squish_feedback",
  "arguments": {
    "targetType": "memory",
    "id": "memory-uuid",
    "signal": "confirm",
    "project": "/path/to/project"
  }
}
```

**Parameters:**
- `targetType` (required): `memory`, `belief`, or `strategy`.
- `id` (required): Target record ID (from a recall result).
- `signal` (required): `confirm`, `contradict`, or `used`.
- `project` (optional): Project path (feedback is rejected when the target belongs to a different project).

### 12. squish_places

Memory places (spatial organization). Actions: `list` (all places for project), `get` (memories at a place by ID or type).

Place types: `inbox`, `ref`, `wip`, `sandbox`, `board`, `sparks`, `archive`.

```json
{
  "name": "squish_places",
  "arguments": {
    "action": "list",
    "project": "/path/to/project"
  }
}
```

**Parameters:**
- `action` (required): `list` or `get`.
- `placeId` (optional, required for `get`): Place ID or place type.
- `limit` (optional, default 50): Max memories to return for `get`.
- `project` (optional): Project path filter.

### 13. squish_sessions

Agent session history across harnesses. Actions: `list` (recent sessions), `show` (chunks of a session), `search` (search chunk content), `related` (sessions related to current project directory).

```json
{
  "name": "squish_sessions",
  "arguments": {
    "action": "list",
    "limit": 10,
    "source": "claude-code"
  }
}
```

**Parameters:**
- `action` (required): `list`, `show`, `search`, or `related`.
- `sessionId` (optional): Session ID (for show).
- `limit` (optional): Max results.
- `query` (optional): Search query (for search).
- `source` (optional): `opencode`, `claude-code`, `codex`, `gemini`, `all`. Every result is tagged with its harness origin.

### 14. squish_tier

Memory tier management. Promote, demote, and list memories by tier.

```json
{
  "name": "squish_tier",
  "arguments": {
    "action": "list",
    "tier": "sturdy",
    "limit": 20
  }
}
```

**Parameters:**
- `action` (required): Tier management action.
- `tier` (optional): Filter by tier.
- `limit` (optional): Max results.

### 15. squish_dedup

Duplicate detection and merge workflow for memories.

Actions: `scan` (detect duplicates, create proposals — no merges), `list` (pending merge proposals), `preview` (before/after of one proposal), `approve` / `reject` (act on one proposal), `reverse` (undo an executed merge via its history ID), `auto` (merge all pending proposals above confidence threshold; requires `SQUISH_DEDUP_AUTO=true`, capped per invocation).

```json
{
  "name": "squish_dedup",
  "arguments": {
    "action": "scan",
    "threshold": 0.95,
    "project": "/path/to/project"
  }
}
```

**Parameters:**
- `action` (required): One of the actions above.
- `proposalId` (optional): Proposal ID (required for preview, approve, reject).
- `mergeHistoryId` (optional): Merge history ID (required for reverse).
- `threshold` (optional, default 0.95): Minimum similarity score to act on.
- `limit` (optional, default 20): Max results for list.
- `cap` (optional, default 25): Max merges per auto invocation.
- `reviewNotes` (optional): Optional review notes recorded with approve/reject.
- `reason` (optional): Optional reason recorded with reverse.
- `project` (optional): Project path filter (for scan/list).

### 16. squish_maintenance (gated)

Gated behind `SQUISH_ENABLE_MAINTENANCE_TOOLS=true`. Run maintenance operations (dedup, stale, consolidate, inbox) in one call.

```json
{
  "name": "squish_maintenance",
  "arguments": {
    "steps": ["dedup", "stale"],
    "dryRun": true,
    "project": "/path/to/project"
  }
}
```

**Parameters:**
- `steps` (optional): Specific maintenance steps to run — `dedup`, `stale`, `consolidate`, `inbox`.
- `dryRun` (optional): Dry run without making changes.
- `project` (optional): Project path to scope the operation.
- `age` (optional): Age threshold in days.
- `llmEnabled` (optional): Whether to use LLM for enhanced steps.

## Configuration

### Environment Variables

```bash
# MCP Server
SQUISH_MCP_PORT=8767                  # MCP server port (default: 8767)
SQUISH_MCP_MODE=stdio                 # Mode: stdio or http (default: stdio)
SQUISH_MCP_HTTP=true                  # Alternative: enable HTTP mode

# Storage
SQUISH_DATA_DIR=/path/to/data         # Data directory (default: ~/.squish)
SQUISH_DB_TYPE=sqlite                # Database: sqlite or postgres

# Embeddings
SQUISH_EMBEDDINGS_PROVIDER=local     # Provider: local|openai|ollama|google|auto
SQUISH_LOCAL_BUNDLED_MODEL=bundled   # Set 'off' to pin deterministic TF-IDF (CI, offline evals)

# Multimodal Ingestion
SQUISH_MULTIMODAL_ENABLED=true        # Enable multimodal ingestion (default: true)
SQUISH_MULTIMODAL_INBOX_DIR=./inbox   # Inbox directory for file watcher
SQUISH_MULTIMODAL_POLL_INTERVAL_MS=5000  # File watcher poll interval
SQUISH_MULTIMODAL_MAX_FILE_SIZE_BYTES=104857600  # Max file size (default: 100MB)

# LLM Consolidation (optional)
SQUISH_LLM_CONSOLIDATION_ENABLED=false  # Enable LLM cross-connection finding
SQUISH_LLM_CONSOLIDATION_BATCH_SIZE=50
SQUISH_LLM_CONSOLIDATION_MIN_AGE_DAYS=7
SQUISH_LLM_CONSOLIDATION_MIN_CONNECTIONS=2

# Dedup
SQUISH_DEDUP_AUTO=false              # When true, nightly dedup may auto-execute high-threshold merges

# Maintenance Tools
SQUISH_ENABLE_MAINTENANCE_TOOLS=false  # Set true to expose squish_maintenance (16th tool)

# Vector Scan
SQUISH_VECTOR_SCAN=recency           # Candidate selection: full (complete recall) or recency (newest window)

# Recall Behavior
SQUISH_SEARCH_BELIEFS=true           # Include belief records in hybrid retrieval
SQUISH_ABSTAIN_BELOW=unset           # Recall-confidence floor; below it recall returns no_reliable_memory verdict

# Scoring
SQUISH_SCORING_V2=true               # Serve v2 composite ranking
SQUISH_SCORING_SHADOW=false          # When true, log v2 alongside v1 without serving
```

### Embedding Providers

1. **local** (default): TF-IDF based embeddings, 768-dim, no API calls
2. **openai**: Requires `SQUISH_OPENAI_API_KEY`
3. **ollama**: Requires `SQUISH_OLLAMA_URL`
4. **google**: Requires Google credentials/project
5. **auto**: Tries configured providers and falls back to local TF-IDF

### Agent configuration

#### Claude Code

Squish detects Claude Code and adds plugin hooks automatically. No MCP config needed — the plugin wrapper handles it.

To verify:
```bash
squish context    # See what your agent remembers
squish status --stats  # Check memory health
```

#### Codex CLI

Add to your Codex MCP config:

```json
{
  "mcpServers": {
    "squish": {
      "command": "squish-mcp",
      "args": ["--http", "--port", "8767"]
    }
  }
}
```

#### Cursor / Windsurf / Cline

Add the same MCP server block to your editor's MCP settings:

```json
{
  "mcpServers": {
    "squish": {
      "command": "squish-mcp",
      "args": ["--http", "--port", "8767"],
      "env": {
        "SQUISH_DB_PATH": "./squish-data"
      }
    }
  }
}
```

#### OpenCode

```bash
squish install --all
```

OpenCode gets both MCP tools and auto-capture hooks.

#### Any MCP Client

```json
{
  "mcpServers": {
    "squish": {
      "command": "squish-mcp",
      "args": ["--http", "--port", "8767"],
      "env": {
        "SQUISH_MCP_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

HTTP mode requires `SQUISH_MCP_API_KEY` to be set.

## Transport modes

### STDIO (default)

The server reads JSON-RPC from stdin and writes to stderr. This is the mode used by Claude Code, Codex, Cursor, and most MCP clients when running as a subprocess.

### Streamable HTTP

The server exposes a `/mcp` endpoint using the Streamable HTTP transport. Useful for remote MCP clients or when you want to run the server as a standalone service.

Health endpoint: `GET /health`

## Security note

The following operations are NOT available via MCP:
- Setting encryption passphrase
- Rotating encryption key

These must be done manually via the `.env` file in the data directory.

## Version

The MCP server reports version `2.0.0` in health checks and tool responses.

## Links

- [GitHub](https://github.com/michielhdoteth/squish)
- [npm](https://www.npmjs.com/package/squish-memory)
- [MCP Documentation](https://github.com/michielhdoteth/squish/blob/master/packages/mcp/README.md)
