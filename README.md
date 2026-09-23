# Squish

**Your agents forget. Squish doesn't.**

One memory system for every agent. Local-first. Open source. Cloud optional.

Claude Code -- Codex -- OpenCode -- MCP -- your own agents

---

## Quick Start

```bash
npm install -g squish-memory && squish install --all
```

That is it. CLI, MCP server, and hooks for every coding agent on your machine. No API keys. No config. No Docker.

---

## For developers

One package. Three interfaces.

```bash
npm install -g squish-memory
```

- **squish CLI** — remember, recall, search, stats, cloud sync
- **squish mcp** — MCP server for any MCP-compatible agent
- **Desktop** — visual memory browser and knowledge graph explorer

That's it. No separate SDK to install, no second package to version, no HTTP client to maintain.

If you need to access Squish from your own JS/TS code:
- Local: import from @squish/core-sdk (internal, workspace-only — not a public SDK)
- Remote: use any MCP-compatible client against `squish mcp --http`

MCP is the standardized programmatic interface. There is no @squish/sdk.

---

## Desktop App

Visual memory browser, knowledge graph explorer, and settings. Native installers for Mac, Windows, Linux.

[Download Desktop -- $99 once](https://github.com/4m-labs/squish/releases/latest)

Own this version forever. No subscription.

---

## How It Works

1. **Capture** -- Squish runs in the background, capturing decisions, constraints, and preferences as you work
2. **Store** -- Memories are stored locally in SQLite with automatic decay scoring
3. **Recall** -- When your agent starts a new session, Squish injects only the relevant context (50-200 tokens)
4. **Connect** -- Works with Claude Code, Cursor, Codex, OpenCode, Windsurf, and any MCP-compatible tool

---

## Agents

| Agent | Install |
|-------|---------|
| Claude Code | `npx squish install --claude-code` |
| Cursor | `npx squish install --cursor` |
| Codex | `npx squish install --codex` |
| OpenCode | `npx squish install --opencode` |
| All at once | `npx squish install --all` |

---

## Architecture

```
Your AI Tool (Claude Code, Cursor, etc.)
        |
    squish-mcp (MCP server)
        |
    squish-core (memory engine)
        |
    SQLite (.squish/squish.db)
```

- **Local-first**: All data stays on your machine
- **No account required**: Works offline, no cloud dependency
- **BYOK**: Bring your own API keys for embeddings and inference
- **MCP standard**: Works with any MCP-compatible tool

---

## CLI

```bash
squish remember "Use Drizzle ORM, not Prisma"
squish recall "What ORM should I use?"
squish search "database"
squish stats
```

---

## Cloud (Optional)

Prepaid credit packs for sync and managed AI services. No subscription.

| Pack | Price | Per Credit |
|------|-------|------------|
| 10,000 | $5 | $0.0005 |
| 50,000 | $15 | $0.0003 |
| 200,000 | $40 | $0.0002 |

Credits buy: cloud storage, managed embeddings, LLM inference, remote sync.

---

## Security

Squish's HTTP server (`squish mcp --http`) binds to localhost by default and is intended for local use only. HTTP mode transmits data in plaintext -- do not expose it to the internet without a TLS-terminating reverse proxy (e.g., Nginx, Caddy, Cloudflare Tunnel).

For remote access:

1. Set up a reverse proxy with TLS termination in front of the Squish HTTP server.
2. Restrict network access to authorized clients only.
3. Never bind the Squish HTTP server directly to a public interface.

All local data is stored in SQLite at `.squish/squish.db` with no encryption at rest. The database file permissions should be restricted on shared systems.

---

## Benchmarks (v2.1.0)

Offline, deterministic benchmarks on a 60-memory corpus. No LLM calls. Reproducible.

| Metric | Score | Threshold |
|--------|-------|-----------|
| Recall@5 | **0.935** | 0.85 |
| MRR | **0.904** | 0.82 |
| Hit@1 | **0.870** | 0.78 |
| ECE (calibration) | **0.055** | 0.15 |

By query type:

| Category | n | Recall@5 | MRR | Hit@1 |
|----------|---|----------|-----|-------|
| Entity | 9 | 1.000 | 0.944 | 0.889 |
| Temporal | 8 | 1.000 | 1.000 | 1.000 |
| Multi-hop | 4 | 1.000 | 1.000 | 1.000 |
| Procedural | 8 | 0.875 | 0.888 | 0.875 |
| Paraphrase | 9 | 0.889 | 0.889 | 0.889 |
| Negation | 8 | 0.875 | 0.750 | 0.625 |

**Resurrection**: 5/5 scenarios pass (dormant strengthening, irrelevant decay, accidental retrieval immunity, contradiction handling).

---

## License

**AGPLv3** -- Free to use, modify, and self-host. Commercial license available for proprietary embedding.

See [LICENSING.md](../LICENSING.md) for details.
