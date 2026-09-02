# Squish Documentation

This directory contains technical documentation for the Squish memory infrastructure.

## Authoritative docs

These docs are current and reflect the codebase as of the latest release:

- **[ARCHITECTURE.md](Architecture)** — System design, package structure, architecture layers, storage modes, technology stack, key configuration. The canonical technical reference.
- **[MCP-SERVER.md](MCP-Server)** — MCP server tool reference (15 tools + 1 gated), agent configuration, transport modes, environment variables. Updated to match the current codebase.
- **[INSTALL-QUICKSTART.md](INSTALL-QUICKSTART)** — Install, verify, first memory. Getting started guide.

## Deep dives

These docs go deeper into specific subsystems:

- **[v2-scoring.md](v2-scoring)** — Scoring v2: composite ranking, graph boost, recency, importance, contextual retrieval. Internal detail on how recall results are ranked.
- **[calibration-report.md](calibration-report)** — Recall confidence calibration methodology. How the system calibrates confidence scores.
- **[consolidation-bakeoff.md](consolidation-bakeoff)** — Consolidation algorithm bake-off results. Why GAC geometry-aware consolidation won.
- **[DECAY.md](DECAY)** — How memories age and lose relevance over time.

## Philosophy (published on GitHub wiki)

The product philosophy lives on the GitHub wiki, not in this directory:

- **Laws of Memory** — 8 fundamental laws of the Squish memory runtime
- **Compound Rules** — How memory accumulates, reinforces, and decays
- **Promises** — What Squish promises developers who build on it

See: https://github.com/michielhdoteth/squish/wiki

## Quick links

- [GitHub](https://github.com/michielhdoteth/squish)
- [npm](https://www.npmjs.com/package/squish-memory)
- [Website](https://squishplugin.dev)
- [Documentation (external)](https://docs.squishplugin.dev)

## Doc status

| Doc | Status | Last verified |
|-----|--------|---------------|
| ARCHITECTURE.md | Current | Matches codebase |
| MCP-SERVER.md | Current | Rewritten to match codebase |
| INSTALL-QUICKSTART.md | Current | Install commands verified |
| v2-scoring.md | Current | Scoring flags match code |
| calibration-report.md | Current | Methodology valid |
| consolidation-bakeoff.md | Current | Reflects Batch 8 decisions |
| DECAY.md | Current | Decay system accurate |

If a doc looks stale, flag it — don't let it go unmaintained.
