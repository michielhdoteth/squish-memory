import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const ROOT = join(import.meta.dir, "..", "..");
const MCP_ENTRY = join(ROOT, "packages", "mcp", "src", "index.ts");

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
        proc.kill("SIGTERM");
        reject(new Error(`Server did not start within ${timeoutMs}ms on port ${port}. stderr: ${stderrBuf}`));
        return;
      }

      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
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
    }, 3000);
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

      const initBody = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      };

      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "x-api-key": "test-e2e-key",
        },
        body: JSON.stringify(initBody),
        signal: AbortSignal.timeout(5000),
      });

      expect(res.status).toBe(200);

      const sessionId = res.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      expect(sessionId!.length).toBeGreaterThan(0);

      const body = await res.json();
      expect(body).toHaveProperty("jsonrpc", "2.0");
      expect(body).toHaveProperty("id", 1);
      expect(body).toHaveProperty("result");
      expect(body.result).toHaveProperty("serverInfo");
      expect(body.result.serverInfo).toHaveProperty("name", "squish-memory");
      expect(body.result.serverInfo).toHaveProperty("version", "2.1.0");
      expect(body.result).toHaveProperty("capabilities");
    },
    15_000,
  );

  it(
    "MCP HTTP /mcp endpoint handles tools/list",
    async () => {
      const server = await startServer();

      // Initialize session
      const initRes = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "x-api-key": "test-e2e-key",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
        signal: AbortSignal.timeout(5000),
      });

      const sessionId = initRes.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      // tools/list with session
      const listRes = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
          "x-api-key": "test-e2e-key",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        }),
        signal: AbortSignal.timeout(5000),
      });

      expect(listRes.status).toBe(200);

      const body = await listRes.json();
      expect(body).toHaveProperty("jsonrpc", "2.0");
      expect(body).toHaveProperty("id", 2);
      expect(body).toHaveProperty("result");
      expect(body.result).toHaveProperty("tools");
      expect(Array.isArray(body.result.tools)).toBe(true);
      expect(body.result.tools.length).toBe(17);
    },
    15_000,
  );

  it(
    "MCP HTTP rejects requests without valid session",
    async () => {
      const server = await startServer();

      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "x-api-key": "test-e2e-key",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
        }),
        signal: AbortSignal.timeout(5000),
      });

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body).toHaveProperty("jsonrpc", "2.0");
      expect(body).toHaveProperty("error");
      expect(body.error).toHaveProperty("code");
      expect(body.error).toHaveProperty("message");
    },
    15_000,
  );
});
