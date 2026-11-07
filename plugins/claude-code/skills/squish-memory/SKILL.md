---
name: squish-memory
description: Persistent memory system for Claude Code. Use when you need to store, recall, or search project memories, facts, decisions, and learnings across sessions. Triggers on: remember, recall, memory, forget, search memories, store context, project knowledge, what did we decide, previous conversation.
when_to_use: User mentions memory, recall, remember, forget, search memories, store context, project knowledge, prior decisions, past conversations
allowed-tools: Bash
---

# Squish Memory

> **Release status (2026-10-20): Squish 2.2.0 is an unpublished source candidate.** The published
> package currently resolves to 1.9.0 and has not been validated with this skill. Do not install or
> configure Squish from these notes until a matching release is announced. The reference sections
> below describe target-version behavior.

Persistent memory system using the Squish CLI. Auto-captures context and provides durable memory across sessions.

## Auto-Install

There is no supported install command for this source candidate. Follow the release announcement
for a validated install and update path.

## Commands

### Store Memory
```bash
squish remember "content" --type observation --project .
```

Types: `observation`, `fact`, `decision`, `context`, `preference`

Places: `inbox`, `wip`, `ref`, `sandbox`, `board`, `sparks`, `archive`

### Recall Memory
```bash
squish recall "query" --limit 5 --project .
```

Every recall result carries a recall assessment with a verdict:
- `confident` - top result is reliable; act on it
- `qualified` - usable, but treat with care
- `no_reliable_memory` - nothing trustworthy found; say so instead of guessing

Close the loop with feedback (MCP tool `squish_feedback`): signal `confirm`,
`used`, or `contradict` on recalled items so future ranking improves.

### Load Context
```bash
squish context --json --limit 5 --project .
```

### Past Agent Sessions
```bash
squish sessions search "postgres migration" --source all
squish sessions list --source opencode
squish sessions show <session-id>
```

Sources: `opencode`, `claude-code` (alias `claude`), `codex`, `gemini`, `all`.
Sessions are raw evidence from past agent runs - separate from long-term memory.

### Status and Stats
```bash
squish status --stats --project .
```

### Health Check
```bash
squish doctor --json
```

## Workflow

1. **Before starting work**: `squish context` for prior context
2. **During work**: `squish remember` for decisions and observations
3. **After work**: `squish remember` for learnings and outcomes

## Example

```bash
# Store a decision
squish remember "We chose PostgreSQL for team mode" --type decision

# Recall related memories
squish recall "database choice"

# Load context for current project
squish context
```
