# @squish/sdk

Dependency-free TypeScript client for [squish-memory](https://github.com/michielhdoteth/squish-memory) over MCP streamable HTTP. Talk to a local squish instance or a cloud deployment from Node 18+, Bun, Deno, or edge runtimes.

The whole client is one small file: one request path handles auth, sessions, timeouts, retries, and error normalization, then a typed method per squish tool on top. It is deliberately small enough to read in one sitting - if something breaks, the answer is in the source.

## Status

Not yet published to npm. Until then, vendor the `src/` folder or install from a git checkout. This README describes the package as it will be published.

## Quick start

Start a local squish HTTP server first:

```bash
SQUISH_MCP_API_KEY=my-key npx squish-mcp --http --port 8767
```

Then, from your application:

```typescript
import { SquishClient } from '@squish/sdk';

const squish = new SquishClient({
  baseUrl: 'http://127.0.0.1:8767/mcp',
  apiKey: 'my-key',
});

// Store a memory (routing to memory / learning / note is automatic)
await squish.remember({ content: 'Use event-driven architecture for the payment service' });

// Recall with a calibrated confidence verdict
const recall = await squish.recall({ query: 'architecture decisions', limit: 5 });
if (recall.recallAssessment?.verdict === 'confident') {
  console.log(recall.results?.[0]?.content);
}

// Session teardown (optional; idle sessions are reaped server-side)
await squish.close();
```

Cloud usage is the same client with a different `baseUrl` and key.

## API

### Constructor options

| Option | Default | Description |
|--------|---------|-------------|
| `baseUrl` | `http://127.0.0.1:8767/mcp` | MCP endpoint of the squish instance |
| `apiKey` | - | Sent as `x-api-key` and `Authorization: Bearer` |
| `protocolVersion` | `2024-11-05` | MCP protocol version to negotiate |
| `requestTimeoutMs` | `30000` | Per-request timeout |
| `maxRetries` | `2` | Retries for 429 / 502 / 503 / 504 and connection errors |
| `clientInfo` | `{ name: '@squish/sdk', version }` | Identity reported in the MCP handshake |
| `fetch` | global `fetch` | Injectable fetch (tests, proxies) |

### Methods

Generic surface:

- `call<T>(tool, args)` - call any tool by name; returns the tool's JSON payload (first text content, parsed).
- `tools()` - list tools exposed by the server.
- `close()` - tear down the MCP session (best effort).
- `getSessionId()` - current MCP session id, or null.

Typed tool methods (one per squish tool):

| Method | Tool | Notes |
|--------|------|-------|
| `remember(input)` | squish_remember | Text memory or media file ingestion; auto-routes |
| `recall(input)` | squish_recall | Query or memory ID; carries `recallAssessment.verdict`: `confident` / `qualified` / `no_reliable_memory` |
| `forget(input)` | squish_forget | Single by ID, or bulk by search (`confirm: true` required) |
| `link(input)` | squish_link | `find` related memories or `add` a graph link |
| `context(input)` | squish_context | Project context, project list, or session-start bootstrap |
| `stats(input)` | squish_stats | Status, watchers, consolidation, traces, engines |
| `inspect(input)` | squish_inspect | Explain retention/routing for a memory |
| `skill(input)` | squish_skill | Skills (SOPs) CRUD, search, assignment, usage |
| `loadout(input)` | squish_loadout | Agent loadouts and visibility rules |
| `extract(input)` | squish_extract | Auto-extract skills from memories |
| `feedback(input)` | squish_feedback | `confirm` / `used` / `contradict` reinforcement |
| `places(input)` | squish_places | Memory places (inbox, ref, wip, ...) |
| `sessions(input)` | squish_sessions | Agent session history across harnesses |
| `tier(input)` | squish_tier | Pin / unpin / promote / tier stats |
| `dedup(input)` | squish_dedup | Duplicate detection and merge workflow |
| `maintenance(input)` | squish_maintenance | Server-gated (`SQUISH_ENABLE_MAINTENANCE_TOOLS=true`) |

### Error handling

All failures normalize into one hierarchy - switch on `err.code`:

```typescript
import { SquishClient, SquishHttpError, SquishRpcError, SquishToolError, SquishTransportError } from '@squish/sdk';

try {
  await squish.remember({ content: '...' });
} catch (err) {
  if (err instanceof SquishHttpError) {
    // err.status, err.code === `HTTP_${status}` (HTTP_401 = bad key, HTTP_429 = rate limited)
  } else if (err instanceof SquishRpcError) {
    // JSON-RPC level failure; err.rpcCode, err.code === `RPC_${rpcCode}`
  } else if (err instanceof SquishToolError) {
    // The tool ran and reported failure (isError: true)
  } else if (err instanceof SquishTransportError) {
    // Network error or timeout; err.code === 'TIMEOUT_ERROR' | 'TRANSPORT_ERROR'
  } else if (err instanceof SquishError) {
    // Anything else (e.g. SESSION_ERROR)
  }
}
```

### Sessions, timeouts, retries

- **Sessions**: the MCP handshake runs lazily on the first call and the session is reused. If the server restarts or reaps the session (404 / 400 `-32000`), the client re-initializes once and retries transparently.
- **Timeouts**: every request is bounded by `requestTimeoutMs` via `AbortController`; timeouts surface as `SquishTransportError` with code `TIMEOUT_ERROR`.
- **Retries**: 429 (honoring `Retry-After`), 502/503/504, and connection-refused errors are retried with capped exponential backoff. HTTP 500 and timeouts are NOT retried by default because the tool call may already have been applied server-side. Tune with `maxRetries`.

### Running the tests

```bash
bun install
bun test packages/sdk
```

Unit tests run against a stub MCP server; one e2e test spawns the real squish MCP server in HTTP mode with a throwaway data directory.

## License

MIT
