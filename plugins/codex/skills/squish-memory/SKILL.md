---
name: squish-memory
description: Persistent memory system for Codex with auto-capture, cross-session recall, and context injection.
---

# Squish Memory

Squish is a universal long-term memory system for AI agents. It persists memories across sessions, enables cross-session recall, and auto-captures context.

## Key Capabilities

- **Store**: Save important information, decisions, and context
- **Recall**: Search past memories with semantic or keyword queries
- **Context**: Load recent memories for the current project
- **Forget**: Remove or clean up old memories
- **Stats**: View memory usage and statistics

## When to Use

- User asks "what did we discuss last time" or "remind me about..."
- User says "remember this" or "save this for later"
- User asks about past decisions, preferences, or project context
- User wants to review what was done in previous sessions
- User explicitly asks to recall, remember, or load memories

## Available Commands

Use the squish CLI via MCP tools:
- `squish remember <content>` -- Store a new memory
- `squish recall <query>` -- Search memories
- `squish context` -- Show project context
- `squish status --stats` -- View statistics
- `squish sessions search <query> --source all` -- Search past agent sessions (sources: opencode, claude-code, codex, gemini, all)

Recall results carry a verdict: `confident`, `qualified`, or `no_reliable_memory`.
Close the loop with the `squish_feedback` MCP tool (`confirm` / `used` / `contradict`)
so future ranking reflects what actually helped.
