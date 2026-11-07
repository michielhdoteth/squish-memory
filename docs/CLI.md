# Squish CLI Reference

Current reference for the shipped CLI in `packages/cli/src/index.ts`.

## Overview

Squish exposes a compact operational CLI:

- runtime commands for the Web UI, plus a dedicated `squish-mcp` binary
- direct commands for explicit save, retrieval, inspection, and diagnostics
- project/runtime visibility commands for trust and release debugging

## Runtime

### squish-mcp

Start the MCP server for Claude Code, Codex, Cursor, OpenCode, and other MCP clients:

```bash
squish-mcp
squish-mcp --health
```

### squish run web

Start only the Web UI:

```bash
squish run web
```

## Memory Capture And Retrieval

### squish remember

Store an explicit memory:

```bash
squish remember "User prefers TypeScript" --type preference
squish remember "Chose PostgreSQL for Squish Cloud team mode" --type decision --project /path/to/project
```

### squish recall

Recall by query or memory ID:

```bash
squish recall "user preferences"
squish recall "authentication patterns" --limit 10
squish recall 123e4567-e89b-12d3-a456-426614174000
```

Machine-readable recall uses `--json` and returns `{ status, memories, missing }`, where
status is `ok`, `partial`, or `none` and `missing` lists uncovered query fragments.
Each memory contains `id`, `content`, `type`, and `confidence` when available.
The `--format json` export option remains a separate full-record export.

### squish recent

Show recent memory activity:

```bash
squish recent --period today
squish recent --period 7days
```

### squish inspect

Explain why a memory exists and whether extra runtime metadata exists:

```bash
squish inspect <memory-id>
squish inspect <memory-id> --json
```

## Context And Diagnostics

### squish context

Show current project context or list projects:

```bash
squish context
squish context --json
squish context --list-projects
```

### squish health

Show trust-oriented runtime health:

```bash
squish health
squish health --json
```

### squish stats

Show durable totals plus capture-era signal telemetry:

```bash
squish stats
squish stats --json
```

### squish doctor

Run combined trust + diagnostics checks:

```bash
squish doctor
squish doctor --json
squish doctor --verbose
```

### squish gate

Decide whether memory context should be searched for a prompt. Rules-only by default (no database needed). After `squish install` it runs on every prompt through the installed UserPromptSubmit hook (`plugin/scripts/new-hook.js`): the installer registers it in Claude Code's settings merge and the Codex plugin bundles it. Also useful manually for debugging gate decisions:

```bash
squish gate "Fix the login bug"
squish gate --json "Fix the login bug"
echo '{"prompt":"why did the build fail?","cwd":"/path/to/project"}' | squish gate --json
squish gate --json --exec    # also spawns `squish context <hint>` when search is true
```

Input comes from a positional prompt argument or piped stdin (stdin is capped at 2 seconds so the gate can never hang). Stdin accepts the hook's JSON payload (`prompt`, alias `user_message_text`, optional `cwd`) or raw prompt text.

With `--json` the decision is one line:

```json
{"search":true,"queryHints":["login bug"],"reason":"...","source":"rule"}
```

- `search`: whether memory context should be loaded for this prompt
- `queryHints`: suggested queries to run against memory
- `reason`: human-readable justification for the decision
- `source`: `"rule"`, `"model"` (decision-layer escalation), or `"failopen"`

The command always exits 0. Its failure mode is "search anyway" (`source: "failopen"`), never an error surface for the harness. With the decision layer disabled (the default), every prompt short-circuits to `search: true` / `source: "failopen"`, so the installed hook stays fast and never blocks the submission path.

## Sessions

The CLI supports listing, inspecting, searching, indexing, comparing, and replaying sessions. Listing, inspecting, comparing, and replaying read sessions already stored in the Squish database; `search` reads supported local agent transcript sources.

```bash
squish sessions list --limit 10
squish sessions list --has-transcript
squish sessions search "deployment decision" --source all
squish sessions search "deployment decision" --project "/path/to/project"
squish sessions index --source opencode
squish sessions inspect <session-id>
squish sessions diff <session-id-a> <session-id-b>
squish sessions replay <session-id> --format json
```

Search defaults to all supported transcript sources and reports when a bounded scan ends early. An OpenCode search may use a local FTS sidecar index; when the index is missing or stale, an unscoped search explains how to build it. Indexing is explicit and never starts automatically: it reads the full local database and may take minutes, using local CPU and disk but no language model or embedding model. Project-scoped search stays bounded to matching source rows and does not build the full-database index. Strict-trust mode may deny raw transcript history until the source access and provenance contract is satisfied. See [MCP Server](MCP-SERVER.md#12-squish_sessions) for MCP search behavior.
## Maintenance

### squish forget

Delete a memory:

```bash
squish forget <memory-id>
```

### squish link

Manage associations:

```bash
squish link find <memory-id>
squish link add <from-id> <to-id> related
squish link list <memory-id>
```

### squish stale

Show stale memories:

```bash
squish stale --days 30
```

### squish clean

Run cleanup / maintenance tasks:

```bash
squish clean
```

### squish migrate

Unify multiple local `.squish` folders into the current workspace location:

```bash
squish migrate
```

## Quick Reference

| Family | Commands |
|--------|----------|
| Runtime | `squish-mcp`, `squish run web` |
| Capture / Retrieval | `squish remember`, `squish recall`, `squish recent`, `squish inspect` |
| Sessions | `squish sessions list`, `squish sessions search`, `squish sessions index`, `squish sessions inspect`, `squish sessions diff`, `squish sessions replay` |
| Context / Trust | `squish context`, `squish health`, `squish stats`, `squish doctor`, `squish gate` |
| Maintenance | `squish forget`, `squish link`, `squish stale`, `squish clean`, `squish migrate` |
