import { describe, it, expect, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { SquishClient } from '../src/client.js';

/**
 * E2E: drive a REAL squish MCP server in HTTP mode with the SDK client.
 * Mirrors tests/mcp/http-e2e.test.ts but exercises the full read/write
 * round-trip a third-party consumer would perform.
 */

const ROOT = join(import.meta.dir, '..', '..', '..');
const MCP_ENTRY = join(ROOT, 'packages', 'mcp', 'src', 'index.ts');

const runningServers: Array<{ proc: ChildProcess; dataDir: string }> = [];

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer(): Promise<{ client: SquishClient; port: number; dataDir: string; proc: ChildProcess }> {
  const port = await findFreePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'squish-sdk-e2e-'));

  const proc = spawn(process.execPath, [MCP_ENTRY, '--http', '--port', String(port)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: ROOT,
    env: {
      ...process.env,
      SQUISH_DATA_DIR: dataDir,
      SQUISH_MCP_MODE: 'http',
      SQUISH_MCP_API_KEY: 'sdk-e2e-key',
      SQUISH_QUIET: '1',
    },
  });

  // Wait for the unauthenticated health endpoint
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) ready = true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!ready) {
    proc.kill();
    throw new Error('squish MCP server did not become healthy in time');
  }

  const client = new SquishClient({
    baseUrl: `http://127.0.0.1:${port}/mcp`,
    apiKey: 'sdk-e2e-key',
    requestTimeoutMs: 60_000,
  });

  runningServers.push({ proc, dataDir });
  return { client, port, dataDir, proc };
}

let server: Awaited<ReturnType<typeof startServer>> | null = null;

afterAll(async () => {
  for (const { proc, dataDir } of runningServers.splice(0)) {
    proc.kill();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('SquishClient e2e (real squish MCP server over HTTP)', () => {
  it('exposes the squish tools', async () => {
    server ??= await startServer();
    const tools = await server.client.tools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('squish_remember');
    expect(names).toContain('squish_recall');
    expect(names).toContain('squish_forget');
  }, 90_000);

  it('performs a remember -> recall -> forget round-trip', async () => {
    server ??= await startServer();
    const { client } = server;

    const content = `SDK e2e round-trip memory ${Date.now()}`;
    const remembered = await client.remember({ content, type: 'fact', tags: ['sdk-e2e'] });
    expect(remembered.ok).toBe(true);
    expect(remembered.id).toBeTruthy();

    const recall = await client.recall({ query: content, limit: 5 });
    expect(recall.ok).toBe(true);
    expect(recall.results?.some((r) => r.id === remembered.id)).toBe(true);

    const forgotten = await client.forget({ memoryId: remembered.id });
    expect(forgotten.ok).toBe(true);
  }, 120_000);
});
