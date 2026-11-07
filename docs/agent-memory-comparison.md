# Squish vs AgentMemory: A Fair Comparison

## Overview

Both Squish and AgentMemory solve a real problem: AI agents forget context between sessions. However, they target different use cases and make different architectural tradeoffs. This document provides a factual comparison to help developers choose the right tool for their needs.

---

## AgentMemory Strengths

AgentMemory is a well-designed plugin that addresses a clear pain point: Claude Code forgetting context between coding sessions.

- **Clear pain, clear solution**: AgentMemory directly solves the "Claude Code forgets" problem with a focused approach. Users install it and immediately see improved session continuity.
- **Easy install**: Plugin installation within the Claude Code / agent ecosystem is straightforward. No configuration or API setup needed.
- **Broad agent support**: Works with Claude Code, Codex, Cursor, Windsurf, and other agents, making it accessible to a wide range of developers.
- **LLM-powered extraction**: Uses a second LLM to extract and summarize memories, which can capture nuanced context that deterministic methods might miss.
- **Growing ecosystem**: Rapidly adding features and integrations, with a community-driven development approach.

## Squish Differentiators

Squish takes a different architectural approach, targeting production-grade memory infrastructure rather than coding-session-only recall.

- **No memory LLM required**: Squish uses local-first embeddings for memory retrieval. Signal extraction, belief derivation, and context restoration work without a secondary language model, eliminating per-token costs and reducing latency.
- **Production agent focus**: Built for autonomous agents, multi-agent systems, scheduled tasks, embedded devices, and team workflows -- not just interactive coding sessions.
- **Geometry-aware consolidation**: Score-based decay system with spatial segmentation (Places), graph enrichment, and contradiction handling keeps memory size manageable without LLM-driven summarization.
- **Reproducible, open eval harness**: a deterministic, offline golden-set eval ships in the repo (Recall@5 0.9457, ECE 0.0429 on the current committed harness, 2026-10-13). Public LoCoMo results are documented once in `docs/BENCHMARK.md` with explicit caveats: LLM-dependent, small-sample, not CI-gated, and treated as indicative pending the rigorous WS7 eval -- never as a self-certified quality gate.
- **Multiple integration surfaces**: CLI for scripts and automation, MCP server for agent integration, Web UI for inspection, and SDK for custom integrations.
- **Local-first by default**: Runs entirely on-device with SQLite. Team workspaces are cloud-managed on Squish Cloud. No data leaves your machine unless you configure paid Squish Cloud sync.
- **Private-first company memory**: Shared knowledge is promoted explicitly through project/team/global scopes, with promotion history and sharing rationale preserved in the record.

## Architecture Differences

| Aspect | AgentMemory | Squish |
|--------|-------------|--------|
| Memory extraction | LLM-powered (second LLM required) | Signal engine with local embeddings (no LLM required) |
| Storage | Managed by the plugin | SQLite local / Squish Cloud team workspace |
| Retrieval | LLM-context injection | Hybrid search (semantic + keyword BM25 + RRF) |
| Consolidation | LLM-driven summarization | Geometry-aware tiers, Places, graph enrichment |
| Lifecycle | Recent/archived | Score-based decay with expiration |
| Encryption | Not specified | AES-256-GCM client-side encryption |
| Session continuity | Context injection | Compacted working set + durable memory restore |

## Cost Comparison

| Scenario | AgentMemory Cost | Squish Cost |
|----------|-----------------|-------------|
| Default path | LLM API costs per memory operation | $0 (local embeddings) |
| With optional LLM | LLM API costs (required) | LLM API costs only if configured |
| Team deployment | N/A | PostgreSQL hosting costs |
| Per-operation latency | 500-5000ms (LLM call) | 1-20ms (local processing) |

## When to Use Each

### Choose AgentMemory when:
- You primarily use Claude Code for interactive coding sessions
- You want a plugin that works within your existing agent ecosystem
- You prefer LLM-driven extraction that can capture nuanced context
- Agent session memory is your primary concern, not production infrastructure

### Choose Squish when:
- You are building production agents that need durable memory as a runtime primitive
- You want to eliminate LLM costs and latency from memory operations
- You need memory for autonomous agents, multi-agent systems, or scheduled tasks
- You want verifiable benchmark results for memory recall quality
- You need multiple integration surfaces (CLI, MCP, SDK, Web UI)
- You prefer local-first architecture with a paid cloud sync option
- You need team/shared memory across multiple agent instances

## Summary

Both tools address the real pain of agents forgetting context. AgentMemory solves it for coding sessions with an LLM-powered plugin approach. Squish solves it for production agents with a local-first memory runtime that eliminates the need for a second LLM.

The right choice depends on your use case: coding session continuity, or production agent memory infrastructure.
