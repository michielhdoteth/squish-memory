import { describe, it, expect, afterEach } from 'bun:test';
import { SquishClient } from '../src/client.js';
import {
  SquishHttpError,
  SquishRpcError,
  SquishToolError,
  SquishTransportError,
} from '../src/errors.js';

/**
 * Stub MCP server implementing just enough of the streamable-HTTP contract
 * to exercise the client: initialize/session, tools/list, tools/call,
 * auth, session expiry, retries, SSE framing, and error shapes.
 */

interface StubState {
  server: ReturnType<Bun['serve']> | null;
  port: number;
  requests: Array<{ method: string; hasSession: boolean; session?: string }>;
  latestSession: string | null;
  four29Once: boolean;
}

function rpcResult(id: number | undefined, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: number | undefined, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}

function startStub(overrides: Partial<{ requireAuth: boolean }> = {}) {
  const state: StubState = {
    server: null,
    port: 0,
    requests: [],
    latestSession: null,
    four29Once: false,
  };

  const requireAuth = overrides.requireAuth ?? true;

  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' });
      }

      if (req.method !== 'POST') {
        return new Response(null, { status: 202 });
      }

      const apiKey = req.headers.get('x-api-key');
      if (requireAuth && apiKey !== 'secret') {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      const body = (await req.json()) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      const session = req.headers.get('mcp-session-id') ?? undefined;
      state.requests.push({ method: body.method, hasSession: !!session, session });

      // initialize: mint a NEW session id and hand it back via header
      if (body.method === 'initialize') {
        state.latestSession = `sess-${state.latestSession === null ? 1 : state.latestSession.length + 2}`;
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { serverInfo: { name: 'stub', version: '1.0.0' }, capabilities: { tools: {} } },
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': state.latestSession! } },
        );
      }

      // Notifications (no id) get 202
      if (body.id === undefined) {
        return new Response(null, { status: 202 });
      }

      // Anything else requires the CURRENT session; stale ones 404
      if (session !== state.latestSession) {
        return new Response(JSON.stringify({ message: 'session not found' }), { status: 404 });
      }

      if (body.method === 'tools/list') {
        return rpcResult(body.id, { tools: [{ name: 'squish_remember' }, { name: 'squish_recall' }] });
      }

      if (body.method === 'tools/call') {
        const tool = body.params?.name;
        const args = body.params?.arguments ?? {};

        if (tool === 'rate_limited_tool' && !state.four29Once) {
          state.four29Once = true;
          return new Response(JSON.stringify({ error: 'slow down' }), {
            status: 429,
            headers: { 'retry-after': '0' },
          });
        }

        if (tool === 'rate_limited_tool') {
          return rpcResult(body.id, {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, id: 'mem-1', routing: 'memory' }) }],
          });
        }

        if (tool === 'sse_tool') {
          const payload = {
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, via: 'sse' }) }] },
          };
          return new Response(`: keepalive\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }

        if (tool === 'failing_tool') {
          return rpcResult(body.id, { content: [{ type: 'text', text: 'boom' }], isError: true });
        }

        if (tool === 'rpc_error_tool') {
          return rpcError(body.id, -32601, 'Method not found');
        }

        if (tool === 'squish_remember') {
          return rpcResult(body.id, {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, id: 'mem-1', routing: 'memory' }) }],
          });
        }

        if (tool === 'squish_recall') {
          return rpcResult(body.id, {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                count: 1,
                results: [{ id: 'mem-1', content: args.query, similarity: 0.9 }],
                recallAssessment: { verdict: 'confident', bestConfidence: 0.95, tier: 'HIGH' },
              }),
            }],
          });
        }

        if (tool === 'non_json_tool') {
          return rpcResult(body.id, { content: [{ type: 'text', text: 'plain text reply' }] });
        }
      }

      return rpcError(body.id, -32601, `Unknown method ${body.method}`);
    },
  });

  state.port = state.server.port;
  return state;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('SquishClient (unit, stub server)', () => {
  it('initializes lazily, captures the session, and sends it on subsequent calls', async () => {
    const stub = startStub();
    cleanups.push(() => stub.server?.stop(true));
    const client = new SquishClient({
      baseUrl: `http://127.0.0.1:${stub.port}/mcp`,
      apiKey: 'secret',
    });
    expect(client.getSessionId()).toBeNull();

    const result = await client.remember({ content: 'hello world' });
    expect(result.ok).toBe(true);
    expect(result.id).toBe('mem-1');
    expect(client.getSessionId()).toBe(stub.latestSession);

    // Second call reuses the session: exactly one initialize so far
    await client.recall({ query: 'hello world' });
    const inits = stub.requests.filter((r) => r.method === 'initialize');
    expect(inits.length).toBe(1);
    const calls = stub.requests.filter((r) => r.method === 'tools/call');
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.session === stub.latestSession)).toBe(true);
  });

  it('rejects with SquishHttpError HTTP_401 on a bad API key', async () => {
    const stub = startStub();
    cleanups.push(() => stub.server?.stop(true));
    const client = new SquishClient({
      baseUrl: `http://127.0.0.1:${stub.port}/mcp`,
      apiKey: 'wrong',
    });
    expect.assertions(3);
    try {
      await client.tools();
    } catch (error) {
      expect(error).toBeInstanceOf(SquishHttpError);
      expect((error as SquishHttpError).code).toBe('HTTP_401');
      expect((error as SquishHttpError).status).toBe(401);
    }
  });

  it('retries a 429 honoring Retry-After and then succeeds', async () => {
    const stub = startStub();
    cleanups.push(() => stub.server?.stop(true));
    const client = new SquishClient({
      baseUrl: `http://127.0.0.1:${stub.port}/mcp`,
      apiKey: 'secret',
      maxRetries: 2,
    });
    const result = await client.call('rate_limited_tool');
    expect(result).toEqual({ ok: true, id: 'mem-1', routing: 'memory' });
    expect(stub.four29Once).toBe(true);
  });

  it('re-initializes once when the session expired (404) and retries the call', async () => {
    const stub = startStub();
    cleanups.push(() => stub.server?.stop(true));
    const client = new SquishClient({
      baseUrl: `http://127.0.0.1:${stub.port}/mcp`,
      apiKey: 'secret',
    });

    // Prime a session, then simulate a server restart (new session minted,
    // old one invalid) by poking internals: the stub 404s stale sessions.
    await client.tools();
    const oldSession = stub.latestSession;
    stub.latestSession = `sess-${Math.floor(Math.random() * 1e6)}`; // client doesn't know this
    // Force the client to hold the now-stale id: only stub knows the new one.
    // Client sends old id -> 404 -> re-init -> new id -> success.
    const clientSessionBefore = client.getSessionId();
    expect(clientSessionBefore).toBe(oldSession);

    const result = await client.remember({ content: 'after restart' });
    expect(result.ok).toBe(true);
    expect(client.getSessionId()).toBe(stub.latestSession);
    const inits = stub.requests.filter((r) => r.method === 'initialize');
    expect(inits.length).toBe(2);
  });

  it('parses SSE-framed JSON-RPC responses', async () => {
    const stub = startStub();
    cleanups.push(() => stub.server?.stop(true));
    const client = new SquishClient({
      baseUrl: `http://127.0.0.1:${stub.port}/mcp`,
      apiKey: 'secret',
    });
    const result = await client.call<{ ok: boolean; via: string }>('sse_tool');
    expect(result.via).toBe('sse');
    expect(result.ok).toBe(true);
  });

  it('throws SquishToolError when the tool reports isError', async () => {
    const stub = startStub();
    cleanups.push(() => stub.server?.stop(true));
    const client = new SquishClient({
      baseUrl: `http://127.0.0.1:${stub.port}/mcp`,
      apiKey: 'secret',
    });
    expect.assertions(2);
    try {
      await client.call('failing_tool');
    } catch (error) {
      expect(error).toBeInstanceOf(SquishToolError);
      expect((error as SquishToolError).message).toBe('boom');
    }
  });

  it('normalizes JSON-RPC errors into SquishRpcError', async () => {
    const stub = startStub();
    cleanups.push(() => stub.server?.stop(true));
    const client = new SquishClient({
      baseUrl: `http://127.0.0.1:${stub.port}/mcp`,
      apiKey: 'secret',
    });
    expect.assertions(3);
    try {
      await client.call('rpc_error_tool');
    } catch (error) {
      expect(error).toBeInstanceOf(SquishRpcError);
      expect((error as SquishRpcError).code).toBe('RPC_-32601');
      expect((error as SquishRpcError).rpcCode).toBe(-32601);
    }
  });

  it('falls back to raw text when the payload is not JSON', async () => {
    const stub = startStub();
    cleanups.push(() => stub.server?.stop(true));
    const client = new SquishClient({
      baseUrl: `http://127.0.0.1:${stub.port}/mcp`,
      apiKey: 'secret',
    });
    const result = await client.call<string>('non_json_tool');
    expect(result).toBe('plain text reply');
  });

  it('surfaces timeouts as SquishTransportError TIMEOUT_ERROR', async () => {
    const stub = startStub();
    cleanups.push(() => stub.server?.stop(true));
    const client = new SquishClient({
      baseUrl: `http://127.0.0.1:${stub.port}/mcp`,
      apiKey: 'secret',
      requestTimeoutMs: 50,
    });

    // Monkey-patch the stub path: reuse failing route via a server-side sleep.
    // Simpler: point the client at a hanging endpoint.
    const hangServer = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}), // never resolves
    });
    cleanups.push(() => hangServer.stop(true));
    const hangClient = new SquishClient({
      baseUrl: `http://127.0.0.1:${hangServer.port}/mcp`,
      apiKey: 'secret',
      requestTimeoutMs: 50,
    });
    expect.assertions(2);
    try {
      await hangClient.tools();
    } catch (error) {
      expect(error).toBeInstanceOf(SquishTransportError);
      expect((error as SquishTransportError).code).toBe('TIMEOUT_ERROR');
    }
    void stub; // stub unused in this test beyond cleanup symmetry
  });

  it('close() clears the session and a following call re-initializes', async () => {
    const stub = startStub();
    cleanups.push(() => stub.server?.stop(true));
    const client = new SquishClient({
      baseUrl: `http://127.0.0.1:${stub.port}/mcp`,
      apiKey: 'secret',
    });
    await client.tools();
    expect(client.getSessionId()).not.toBeNull();
    await client.close();
    expect(client.getSessionId()).toBeNull();
    await client.tools();
    expect(client.getSessionId()).not.toBeNull();
    expect(stub.requests.filter((r) => r.method === 'initialize').length).toBe(2);
  });

  it('recall returns the calibrated assessment contract', async () => {
    const stub = startStub();
    cleanups.push(() => stub.server?.stop(true));
    const client = new SquishClient({
      baseUrl: `http://127.0.0.1:${stub.port}/mcp`,
      apiKey: 'secret',
    });
    const result = await client.recall({ query: 'anything' });
    expect(result.ok).toBe(true);
    expect(result.recallAssessment?.verdict).toBe('confident');
    expect(result.results?.[0]?.id).toBe('mem-1');
  });
});
