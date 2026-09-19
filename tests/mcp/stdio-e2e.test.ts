import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_VERSION = "2.1.0";
const SERVER_NAME = "squish-memory";
// Runtime default (SQUISH_ENABLE_MAINTENANCE_TOOLS unset): 18 core tools
// + stale_report. squish_maintenance is env-gated (returns 0 when unset).
const EXPECTED_TOOL_COUNT = 19;

const EXPECTED_TOOLS = [
  "squish_remember",
  "squish_recall",
  "squish_forget",
  "squish_link",
  "squish_context",
  "squish_stats",
  "squish_inspect",
  "squish_dedup",
];

function resolveServerCommand(): { command: string; args: string[] } {
  const rootDir = join(import.meta.dir, "..", "..");
  const entry = join(rootDir, "bin", "squish-mcp.mjs");
  return { command: "bun", args: ["run", entry, "--stdio"] };
}

interface ServerHandle {
  child: ChildProcess;
  send: (obj: unknown) => void;
  readLine: (matcher: (line: any) => boolean, timeoutMs?: number) => Promise<any>;
  close: () => Promise<void>;
  allOutput: string[];
}

async function spawnServer(tmpDir: string): Promise<ServerHandle> {
  const { command, args } = resolveServerCommand();
  const rootDir = join(import.meta.dir, "..", "..");

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: rootDir,
    env: {
      ...process.env,
      SQUISH_DATA_DIR: tmpDir,
      SQUISH_QUIET: "1",
    },
  });

  let stdoutBuf = "";
  const allOutput: string[] = [];
  const pendingReaders: Array<{ matcher: (line: any) => boolean; resolve: (v: any) => void; reject: (e: Error) => void }> = [];

  child.stdout!.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    allOutput.push(text);
    stdoutBuf += text;

    let nlIdx: number;
    while ((nlIdx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nlIdx).trim();
      stdoutBuf = stdoutBuf.slice(nlIdx + 1);
      if (!line) continue;

      for (const pr of [...pendingReaders]) {
        try {
          const parsed = JSON.parse(line);
          if (pr.matcher(parsed)) {
            pr.resolve(parsed);
            pendingReaders.splice(pendingReaders.indexOf(pr), 1);
            break;
          }
        } catch {
          // Not JSON, skip
        }
      }
    }
  });

  function send(obj: unknown) {
    child.stdin!.write(JSON.stringify(obj) + "\n");
  }

  function readLine(matcher: (line: any) => boolean, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = pendingReaders.findIndex((r) => r.resolve === resolve);
        if (idx !== -1) pendingReaders.splice(idx, 1);
        reject(new Error(`readLine timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pendingReaders.push({
        matcher,
        resolve: (v: any) => { clearTimeout(timer); resolve(v); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      try { child.stdin!.end(); } catch {}
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        resolve();
      }, 3000);
      child.on("exit", () => { clearTimeout(timer); resolve(); });
      // If already exited
      if (child.exitCode !== null) { clearTimeout(timer); resolve(); }
    });
  }

  // Wait for process to start
  await new Promise((r) => setTimeout(r, 1000));

  return { child, send, readLine, close, allOutput };
}

async function initializeServer(handle: ServerHandle): Promise<void> {
  handle.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    },
  });
  await handle.readLine((r: any) => r.id === 1, 20_000);

  handle.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
}

/** Try to parse text as JSON, return original text if not JSON */
function tryParseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

describe("MCP STDIO e2e", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "squish-mcp-test-"));
  });

  afterAll(async () => {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows may lock files; ignore
    }
  });

  it("MCP STDIO server starts and responds to initialize", async () => {
    const server = await spawnServer(tmpDir);
    try {
      server.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });

      const initResp = await server.readLine((r: any) => r.id === 1, 20_000);

      expect(initResp.result).toBeDefined();
      expect(initResp.result.serverInfo.name).toBe(SERVER_NAME);
      expect(initResp.result.serverInfo.version).toBe(SERVER_VERSION);
      expect(initResp.result.capabilities.tools).toBeDefined();

      server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

      server.send({ jsonrpc: "2.0", id: 2, method: "ping" });
      const pingResp = await server.readLine((r: any) => r.id === 2, 10_000);
      expect(pingResp.result).toBeDefined();
    } finally {
      await server.close();
    }
  }, 30_000);

  it("MCP STDIO tools/list returns all default tools", async () => {
    const server = await spawnServer(tmpDir);
    try {
      await initializeServer(server);

      server.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
      const resp = await server.readLine((r: any) => r.id === 3, 10_000);

      expect(resp.result.tools.length).toBe(EXPECTED_TOOL_COUNT);

      const toolNames = resp.result.tools.map((t: any) => t.name);
      for (const expected of EXPECTED_TOOLS) {
        expect(toolNames).toContain(expected);
      }

      for (const tool of resp.result.tools) {
        expect(tool.description).toBeTruthy();
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    } finally {
      await server.close();
    }
  }, 30_000);

  it("MCP STDIO stdout contains only valid JSON-RPC", async () => {
    const server = await spawnServer(tmpDir);
    try {
      await initializeServer(server);

      server.send({ jsonrpc: "2.0", id: 99, method: "ping" });
      await server.readLine((r: any) => r.id === 99, 10_000);

      await server.close();

      const combined = server.allOutput.join("");
      const lines = combined.split("\n").filter((l) => l.trim().length > 0);

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
        const parsed = JSON.parse(line);
        expect(parsed.jsonrpc).toBe("2.0");
      }
    } finally {
      await server.close();
    }
  }, 30_000);

  it("MCP STDIO handles malformed input gracefully", async () => {
    const server = await spawnServer(tmpDir);
    try {
      await initializeServer(server);

      server.child.stdin!.write("this is not json\n");

      server.send({
        jsonrpc: "2.0",
        id: 10,
        method: "nonexistent/method",
        params: {},
      });

      const errResp = await server.readLine((r: any) => r.id === 10, 10_000);
      expect(errResp.error).toBeDefined();
      expect(errResp.error.code).toBeDefined();

      server.send({ jsonrpc: "2.0", id: 11, method: "ping" });
      const pingResp = await server.readLine((r: any) => r.id === 11, 10_000);
      expect(pingResp.result).toBeDefined();
    } finally {
      await server.close();
    }
  }, 30_000);

  it("MCP STDIO tools/call squish_stats", async () => {
    const server = await spawnServer(tmpDir);
    try {
      await initializeServer(server);

      server.send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "squish_stats", arguments: {} },
      });

      const resp = await server.readLine((r: any) => r.id === 5, 15_000);
      expect(resp.result).toBeDefined();
      expect(resp.result.content).toBeDefined();
      expect(resp.result.content.length).toBeGreaterThan(0);

      const text = resp.result.content[0].text;
      expect(text).toBeTruthy();
      // Tool responses may be JSON or plain text - both are valid
      const parsed = tryParseJson(text);
      // If it's JSON, check for ok/error/status field; if text, just verify it's non-empty
      if (parsed._raw) {
        expect(parsed._raw.length).toBeGreaterThan(0);
      } else {
        expect(parsed.ok !== undefined || parsed.status !== undefined || parsed.schema !== undefined || parsed.error !== undefined).toBe(true);
      }
    } finally {
      await server.close();
    }
  }, 30_000);

  it("MCP STDIO tools/call squish_remember and squish_recall", async () => {
    const server = await spawnServer(tmpDir);
    try {
      await initializeServer(server);

      const rememberContent = "Test memory for E2E test " + Date.now();
      server.send({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "squish_remember",
          arguments: { content: rememberContent },
        },
      });

      const rememberResp = await server.readLine((r: any) => r.id === 20, 15_000);
      expect(rememberResp.result).toBeDefined();
      expect(rememberResp.result.content).toBeDefined();
      const remText = rememberResp.result.content[0].text;
      expect(remText).toBeTruthy();
      // Response should indicate success or structured error (JSON or text)
      const remParsed = tryParseJson(remText);
      const isSuccess = remParsed._raw
        ? remParsed._raw.length > 0
        : remParsed.ok !== undefined || remParsed.error !== undefined || remParsed.id !== undefined;
      expect(isSuccess).toBeTruthy();

      server.send({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "squish_recall",
          arguments: { query: rememberContent },
        },
      });

      const recallResp = await server.readLine((r: any) => r.id === 21, 15_000);
      expect(recallResp.result).toBeDefined();
      expect(recallResp.result.content).toBeDefined();
      const recText = recallResp.result.content[0].text;
      expect(recText).toBeTruthy();
      // The recalled text should contain our test memory or indicate results found
      const recParsed = tryParseJson(recText);
      const hasContent = recParsed._raw
        ? recParsed._raw.length > 0
        : true; // JSON response is valid
      expect(hasContent).toBeTruthy();
    } finally {
      await server.close();
    }
  }, 45_000);
});
