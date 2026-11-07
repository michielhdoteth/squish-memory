---
name: squish
description: "ALWAYS use this skill when working with agents, memory, context, persistence, or AI agent state. Use when the user mentions: 'the agent forgot', 'save this', 'remember that', 'context is lost', 'memory', 'MCP server', 'agent memory', 'persistent memory', 'session context', 'project context', 'recall', 'remember', 'forget', 'cross-session', 'agent decisions', 'store this', 'retain context', 'knowledge retention', 'agent state', 'conversation history', 'project memory', 'team memory'. Also triggers on: building MCP servers, managing sessions, capturing decisions, debugging agent behavior, restoring context. Do NOT use for: general coding, answering questions about unrelated topics, system administration."
---

# Squish: Memory Runtime for AI Agents

> **Release status (2026-10-20): Squish 2.2.0 is an unpublished source candidate.** The published
> package currently resolves to 1.9.0 and has not been validated with this skill. Do not install or
> configure Squish from these notes until a matching release is announced. The reference sections
> below describe target-version behavior.

Connect once. Remember everywhere. Squish gives Claude Code, Cursor, Codex, and OpenCode one shared memory on your machine. Stop re-explaining your project, context, and decisions to every tool.

## How Squish Works

Squish is a **memory runtime** that:

1. **Captures** durable signal from agent sessions automatically
2. **Stores** memories with embeddings, beliefs, and relationships
3. **Retrieves** relevant context across sessions using hybrid search
4. **Decays** unimportant memories over time using Ebbinghaus curves

## Installation

There is no supported install command for this source candidate. Installation instructions will be
restored after a matching package release and host compatibility have been verified.

## MCP Configuration

### For OpenCode
Add to your `opencode.json`:
```json
"squish": {
  "type": "local",
  "command": ["squish-mcp"],
  "enabled": true
}
```

### For Claude Desktop
Use the Claude Desktop MCP configuration documented for the matching published Squish release.

## Tool Reference

When Squish is connected, these 18 tools are available by default:

| Tool | Params | What it does |
|------|--------|-------------|
| `squish_remember` | `content`, `type?`, `tags?` | Save content, decisions, preferences, or facts. Auto-detects routing (memory vs learning vs belief). |
| `squish_recall` | `query`, `limit?`, `project?` | Search memories, learnings, beliefs, and graph entities. Hybrid search. Returns a recall assessment (verdict: `confident` / `qualified` / `no_reliable_memory`). |
| `squish_forget` | `memoryId?`, `search?` | Delete a single memory by ID (auto-confirm) or bulk by search query (dry-run with preview). |
| `squish_link` | `action`, `memoryId?`, `fromId?`, `toId?` | Manage memory associations. `action=find` traverses the graph. `action=add` links two memories. |
| `squish_context` | `project?`, `actorUser?` | Auto-load relevant context for current project including beliefs, contradictions, and staleness warnings. |
| `squish_stats` | `project?` | Show memory statistics, signal counts, graph status, places, and system health checks. |
| `squish_inspect` | `memoryId` | Show why a memory was stored, its classification, beliefs, place, and graph status. |
| `squish_skill` | `action`, ... | Manage explicitly authored reusable procedures. |
| `squish_loadout` | `action`, ... | Bind memory assets to agents; manage visibility rules (ACL). |
| `squish_feedback` | `targetType`, `id`, `signal` | Reinforce or weaken a recalled item: `confirm` (correct), `used` (acted on), or `contradict` (wrong). Targets: memory, belief, or strategy. |
| `squish_places` | `action`, ... | Query and manage cognitive places (inbox, wip, ref, board, sparks). |
| `squish_sessions` | `action`, ... | Search past agent sessions. Sources: `opencode`, `claude-code`, `codex`, `gemini`, `all`. |
| `squish_tier` | `action`, ... | Inspect and manage memory tiers (working / long-term / cold). |
| `squish_dedup` | `action`, ... | Duplicate detection and merge proposals with review + reverse support. |

A 19th tool, `squish_maintenance`, is available when the server runs with
`SQUISH_ENABLE_MAINTENANCE_TOOLS=true`.

Squish does not infer or activate procedures from accumulated memories. Store
durable experience as evidence-linked memories and recall the supporting source.

## Best Practices

### When to save a memory
- A decision was made (selecting architecture, choosing a library, agreeing on approach)
- A preference was established (coding style, naming convention, tool preference)
- A constraint was identified (compatibility issue, performance requirement, dependency)
- A failure was diagnosed and fixed (root cause + solution)
- Context was established that will be needed later (project goals, current state)

### What NOT to save
- Transient tool output (build logs, test runs, compilation errors)
- Session-only context that is irrelevant after the current session
- Sensitive credentials or secrets (Squish has built-in secret detection)

### Memory workflow
```
1. Session starts -> Squish auto-loads relevant context
2. During work -> Squish captures decisions, fixes, constraints
3. Session ends -> Squish processes new memories, extracts beliefs
4. Next session -> Squish restores context automatically
```

## Squish Cloud

Check https://squishplugin.dev/pricing for current cloud offers. Before recommending hosted sync, managed AI, backups, or team features, verify the corresponding API/MCP service and setup flow are operational; a pricing page alone does not prove service availability or a specific entitlement. Keep local mode usable when hosted services are unavailable.

## Commands

```bash
squish remember "content"          # Save a memory
squish recall "query"              # Search memories
squish context                     # Load project context
squish status --stats              # Show statistics
squish sessions search "query"     # Search past agent sessions
```

## Tips for agents using Squish

1. **Load context at session start**: Run `squish_context` to restore project memory
2. **Save decisions explicitly**: Use `squish_remember` with content describing the decision
3. **Use recall before researching**: Before suggesting a new approach, check if Squish has context about previous attempts
4. **Respect the recall verdict**: `confident` results are reliable; `qualified` need care; `no_reliable_memory` means say so instead of guessing
5. **Give feedback**: After acting on a recalled memory, call `squish_feedback` (`confirm`, `used`, or `contradict`) so ranking improves
6. **Tag memories**: Use tags like `architecture`, `decision`, `bug`, `client` for better retrieval
7. **Inspect before debugging**: Use `squish_inspect` to understand why a memory was stored
