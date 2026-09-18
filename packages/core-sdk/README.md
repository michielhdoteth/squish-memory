# @squish/core-sdk

**Internal facade over the squish engine. Workspace-only - never published to npm.**

This package is the typed in-process API that the CLI (`packages/cli`) and the MCP server (`packages/mcp`) use to talk to the core engine without deep relative imports. It wraps `core/` and `db/` modules and exposes the `SquishClient` class plus re-exported core utilities.

It only works inside this monorepo (or inside the published `squish-memory` package, which ships it under `packages/core-sdk/`): its imports reach into `core/` and `db/` by relative path by design.

## Third-party consumers

If you are building an application that talks to a **running** squish instance (local `squish-mcp --http` or cloud), use any MCP-compatible client — the MCP server (`packages/mcp/src/index.ts`) speaks standard MCP over stdio or HTTP. There is no separate `@squish/sdk` package.

If you want to embed the engine in-process, depend on the `squish-memory` package itself.

## Layout

- `src/index.ts` - facade: `SquishClient`, core re-exports, error classes, dedup types
- `src/types.ts` - self-contained type surface (no monorepo imports)
- `src/interfaces/` - pluggable provider interfaces (storage, embeddings, LLM, events, config)
- `src/events/` - event bus implementation (consumed by `core/event-bus.ts`)
- `src/plugins.ts` - plugin registry
