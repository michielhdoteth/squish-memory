import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const ROOT = join(import.meta.dir, "..", "..");
const MCP_ENTRY = join(ROOT, "mcp", "index.ts");

interface ServerHandle {
  proc: ChildProcess;
  port: number;
  dataDir: string;
}

const runningServers: ServerHandle[] = [];

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer(): Promise<ServerHandle> {
  const port = await findFreePort();
  const dataDir = await mkdtemp(join(tmpdir(), "squish-mcp-e2e-"));

  const proc = spawn(process.execPath, [MCP_ENTRY, "--http", "--port", String(port)], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: ROOT,
    env: {
      ...process.env,
      SQUISH_DATA_DIR: dataDir,
      SQUISH_MCP_MODE: "http",
      SQUISH_MCP_API_KEY: "test-e2e-key",
    },
  });

  await waitForServerReady(proc, port);

  const handle: ServerHandle = { proc, port, dataDir };
  runningServers.push(handle);
  return handle;
}

function waitForServerReady(proc: ChildProcess, port: number, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let stderrBuf = "";

    const check = () => {
      if (Date.now() > deadline) {
        proc.kill("SIGKILL");
        reject(new Error(`Server did not start within ${timeoutMs}ms on port ${port}. stderr: ${stderrBuf}`));
        return;
      }

      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
        .then((res) => {
          if (res.ok) {
            resolve();
          } else {
            setTimeout(check, 200);
          }
        })
        .catch(() => {
          setTimeout(check, 200);
        });
    };

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (!stderrBuf.includes("listening")) {
        reject(new Error(`Server exited with code ${code} before becoming ready. stderr: ${stderrBuf}`));
      }
    });

    check();
  });
}

/** Parse SSE response body to extract the JSON-RPC result */
async function parseSseResponse(res: Response): Promise<any> {
  const text = await res.text();
  // SSE format: "event: message\ndata: {...}\n\n"
  const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
  if (dataLines.length === 0) {
    // Maybe it's plain JSON
    return JSON.parse(text);
  }
  const lastData = dataLines[dataLines.length - 1].slice(6); // strip "data: "
  return JSON.parse(lastData);
}

/** Send a JSON-RPC request to the MCP HTTP endpoint, parse SSE response */
async function mcpRequest(
  port: number,
  body: Record<string, unknown>,
  opts?: { apiKey?: string; timeoutMs?: number }
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...(opts?.apiKey ? { "x-api-key": opts.apiKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 8000),
  });

  if (res.status === 401) {
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  const json = res.ok ? await parseSseResponse(res) : await res.json().catch(() => null);
  return { status: res.status, json };
}

function killServer(handle: ServerHandle): Promise<void> {
  return new Promise((resolve) => {
    if (handle.proc.killed) {
      resolve();
      return;
    }
    handle.proc.on("exit", () => resolve());
    handle.proc.kill("SIGTERM");
    setTimeout(() => {
      if (!handle.proc.killed) {
        handle.proc.kill("SIGKILL");
      }
      resolve();
    }, 2000);
  });
}

afterAll(async () => {
  for (const srv of runningServers) {
    await killServer(srv);
    await rm(srv.dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("MCP HTTP server e2e", () => {
  it(
    "MCP HTTP server starts on specified port",
    async () => {
      const server = await startServer();

      const res = await fetch(`http://127.0.0.1:${server.port}/health`, {
        signal: AbortSignal.timeout(5000),
      });

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("server", "squish-memory");
      expect(body).toHaveProperty("version", "2.1.0");
      expect(["ok", "degraded", "broken"]).toContain(body.status);
    },
    15_000,
  );

  it(
    "MCP HTTP /mcp endpoint handles initialize",
    async () => {
      const server = await startServer();

      const { status, json } = await mcpRequest(server.port, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }, { apiKey: "test-e2e-key" });

      expect(status).toBe(200);
      expect(json).toHaveProperty("jsonrpc", "2.0");
      expect(json).toHaveProperty("id", 1);
      expect(json).toHaveProperty("result");
      expect(json.result).toHaveProperty("serverInfo");
      expect(json.result.serverInfo).toHaveProperty("name", "squish-memory");
      expect(json.result.serverInfo).toHaveProperty("version", "2.1.0");
      expect(json.result).toHaveProperty("capabilities");
    },
    15_000,
  );

  it(
    "MCP HTTP /mcp endpoint handles tools/list",
    async () => {
      const server = await startServer();

      // Initialize first
      const init = await mcpRequest(server.port, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }, { apiKey: "test-e2e-key" });
      expect(init.status).toBe(200);

      // tools/list
      const list = await mcpRequest(server.port, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }, { apiKey: "test-e2e-key" });

      expect(list.status).toBe(200);
      expect(list.json).toHaveProperty("jsonrpc", "2.0");
      expect(list.json).toHaveProperty("id", 2);
      expect(list.json).toHaveProperty("result");
      expect(list.json.result).toHaveProperty("tools");
      expect(Array.isArray(list.json.result.tools)).toBe(true);
      expect(list.json.result.tools.length).toBe(19);
    },
    15_000,
  );

  it(
    "MCP HTTP rejects requests without API key",
    async () => {
      const server = await startServer();

      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
        signal: AbortSignal.timeout(5000),
      });

      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body).toHaveProperty("error");
    },
    15_000,
  );
});
