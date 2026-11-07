# Squish Documentation

This directory contains technical documentation for Squish. Check the release and availability notes before relying on an installation path or hosted entitlement.

## Authoritative docs

Primary references:

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — System design, package structure, architecture layers, storage modes, and key configuration. Verify release-specific details before use.
- **[MCP-SERVER.md](MCP-SERVER.md)** — MCP server tool reference, agent configuration, transport modes, and environment variables. Verify that each transport is supported by your release.
- **[INSTALL-QUICKSTART.md](INSTALL-QUICKSTART.md)** — Install, verify, first memory. Check current package/release status before following installation commands.
- **[PRODUCT-OFFERING.md](PRODUCT-OFFERING)** — License boundary, current cloud availability, pricing sources, and benchmark-claim policy.

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

See: https://github.com/michielhdoteth/squish-memory/wiki

## Quick links

- [GitHub](https://github.com/michielhdoteth/squish-memory)
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
