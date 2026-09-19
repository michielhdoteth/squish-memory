import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const MCP_SRC = join(process.cwd(), "mcp", "index.ts");

function readSource(): string {
  return readFileSync(MCP_SRC, "utf8");
}

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
      SQUISH_MODE: "local",
    },
  });

  let stdoutBuf = "";
  const allOutput: string[] = [];
  const pendingReaders: Array<{
    matcher: (line: any) => boolean;
    resolve: (v: any) => void;
    reject: (e: Error) => void;
  }> = [];

  child.stdout!.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    allOutput.push(text);
    stdoutBuf += text;

    let nlIdx: number;
    while ((nlIdx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nlIdx).trim();
      stdoutBuf = stdoutBuf.slice(nlIdx + 1);
      if (!line) continue;

      for (const pr of pendingReaders) {
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

  function readLine(matcher: (line: any) => boolean, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = pendingReaders.findIndex((r) => r.resolve === resolve);
        if (idx !== -1) pendingReaders.splice(idx, 1);
        reject(new Error(`readLine timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pendingReaders.push({
        matcher,
        resolve: (v: any) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      child.stdin!.end();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  await new Promise((r) => setTimeout(r, 500));
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
  await handle.readLine((r: any) => r.id === 1);
  handle.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

describe("console.log/info redirect to stderr", () => {
  it("console.log and console.info are redirected to stderr", () => {
    // WHY: MCP stdio transport requires stdout to contain ONLY JSON-RPC messages.
    // If any console.log/info goes to stdout, it corrupts the protocol stream
    // and the client crashes with "Invalid JSON" or similar parse errors.
    const source = readSource();

    expect(source).toContain("console.log = console.error");
    expect(source).toContain("console.info = console.error");
  });

  it("console.log redirect is after all imports (ESM hoisting fix)", () => {
    // WHY: ESM hoists all import declarations to the top of the module before
    // any imperative code runs. If console.log = console.error is placed BEFORE
    // imports, the imports execute first and any console.log in imported modules
    // still goes to stdout (un-redirected). The redirect MUST be after all imports.
    const lines = readSource().split("\n");

    const redirectLine = lines.findIndex((l) => l.includes("console.log = console.error"));
    expect(redirectLine).toBeGreaterThanOrEqual(0);

    const importLines = lines
      .map((l, i) => ({ line: l.trim(), index: i }))
      .filter(({ line }) => line.startsWith("import ") && !line.startsWith("import("));

    expect(importLines.length).toBeGreaterThan(0);
    const lastImportLine = importLines[importLines.length - 1].index;

    expect(redirectLine).toBeGreaterThan(lastImportLine);
  });
});

describe("stdout contains only valid JSON-RPC messages", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "squish-mcp-console-redirect-"));
  });

  afterAll(async () => {
    // Windows may hold a lock briefly after child exits — retry cleanup
    for (let i = 0; i < 3; i++) {
      try { await rm(tmpDir, { recursive: true, force: true }); return; } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
  });

  it(
    "stdout contains only valid JSON-RPC messages",
    async () => {
      // WHY: If any console.log leaks to stdout during startup or initialization,
      // the MCP client receives non-JSON lines and crashes. This test spawns the
      // real server, sends an initialize request, and verifies every non-empty
      // stdout line is valid JSON-RPC.
      const server = await spawnServer(tmpDir);
      try {
        await initializeServer(server);

        server.send({ jsonrpc: "2.0", id: 2, method: "ping" });
        await server.readLine((r: any) => r.id === 2);

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
    },
    15_000
  );

  it(
    "no console.log output on stdout during tools/list",
    async () => {
      // WHY: Tool registration uses console.error for logging, but if any code
      // path accidentally uses console.log during tools/list, it injects garbage
      // into stdout. This test sends tools/list after initialize and verifies
      // every stdout line remains valid JSON-RPC.
      const server = await spawnServer(tmpDir);
      try {
        await initializeServer(server);

        server.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
        await server.readLine((r: any) => r.id === 3);

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
    },
    15_000
  );
});
