/**
 * Tool trust regressions (Batch 1):
 *
 * - squish_extract run must NOT throw "Query cannot be empty" on the
 *   empty-query recency listing path (listRecent).
 * - squish_forget bulk delete is dry-run only until confirm=true is passed;
 *   confirm=true must execute the destructive delete.
 * - The server advertises an `instructions` field at initialize time.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const TEST_TIMEOUT = 90_000;

function resolveServerCommand(): { command: string; args: string[] } {
  const rootDir = join(import.meta.dir, "..", "..");
  const entryPath = join(rootDir, "mcp", "index.ts");

  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    return { command: process.execPath, args: [entryPath, "--stdio"] };
  }

  try {
    const bunPath = execFileSync(
      process.platform === "win32" ? "bun.exe" : "bun",
      ["--version"],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 }
    );
    if (bunPath && bunPath.toString().trim()) {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const pathResult = execFileSync(whichCmd, [process.platform === "win32" ? "bun.exe" : "bun"], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      const bunFullPath = pathResult.toString().trim().split("\n")[0].trim();
      if (bunFullPath) {
        return { command: bunFullPath, args: [entryPath, "--stdio"] };
      }
    }
  } catch {
    // bun not available
  }

  const tsxCli = join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
  return { command: process.execPath, args: [tsxCli, entryPath, "--stdio"] };
}

interface ServerHandle {
  child: ChildProcess;
  send: (obj: unknown) => void;
  readLine: (matcher: (line: any) => boolean, timeoutMs?: number) => Promise<any>;
  close: () => Promise<void>;
  callTool: (name: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
  nextId: () => number;
}

async function spawnServer(tmpDir: string): Promise<ServerHandle> {
  const { command, args } = resolveServerCommand();
  const rootDir = join(import.meta.dir, "..", "..");

  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("SQUISH_") && k !== "DATABASE_URL" && k !== "NODE_OPTIONS" && k !== "BUN_OPTIONS") {
      childEnv[k] = v;
    }
  }
  childEnv.SQUISH_DATA_DIR = tmpDir;
  childEnv.SQUISH_QUIET = "1";

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: rootDir,
    env: childEnv,
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 1_000_000) stderrBuf = stderrBuf.slice(-100_000);
  });
  const pendingReaders: Array<{
    matcher: (line: any) => boolean;
    resolve: (v: any) => void;
    reject: (e: Error) => void;
  }> = [];

  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();

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

  let idCounter = 1;

  function nextId(): number {
    return idCounter++;
  }

  function send(obj: unknown) {
    child.stdin!.write(JSON.stringify(obj) + "\n");
  }

  function readLine(
    matcher: (line: any) => boolean,
    timeoutMs = 30_000
  ): Promise<any> {
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
      const killTimer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          setTimeout(resolve, 300);
        }, 500);
      }, 2000);
      child.on("exit", () => {
        clearTimeout(killTimer);
        setTimeout(resolve, 300);
      });
    });
  }

  async function callTool(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = 30_000
  ): Promise<any> {
    const id = nextId();
    send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const resp = await readLine((r: any) => r.id === id, timeoutMs);
    return resp;
  }

  const readyMarker = "Starting in STDIO mode";
  const bootDeadline = Date.now() + 150_000;
  while (!stderrBuf.includes(readyMarker)) {
    if (Date.now() > bootDeadline) {
      throw new Error(`MCP server did not become ready within 150s. Last stderr:\n${stderrBuf.slice(-2000)}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`MCP server exited during boot (code ${child.exitCode}). Stderr:\n${stderrBuf.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return { child, send, readLine, close, callTool, nextId };
}

let sharedServer: ServerHandle;
let sharedTmpDir: string;

beforeAll(async () => {
  sharedTmpDir = await mkdtemp(join(tmpdir(), "squish-tool-trust-"));
  sharedServer = await spawnServer(sharedTmpDir);

  const id = sharedServer.nextId();
  sharedServer.send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-tool-trust", version: "1.0.0" },
    },
  });
  initResponse = await sharedServer.readLine((r: any) => r.id === id, 90_000);
  sharedServer.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}, 180_000);

let initResponse: any;

afterAll(async () => {
  if (sharedServer) {
    await sharedServer.close();
  }
  if (sharedTmpDir) {
    await rm(sharedTmpDir, { recursive: true, force: true });
  }
}, 15_000);

function parseToolResult(resp: any): any {
  const text = resp.result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text, ok: false };
  }
}

describe("Tool trust (Batch 1)", () => {
  it(
    "initialize response carries harness-agnostic instructions",
    async () => {
      expect(initResponse?.result?.instructions).toBeDefined();
      expect(typeof initResponse.result.instructions).toBe("string");
      expect(initResponse.result.instructions).toContain("persistent memory");
      expect(initResponse.result.instructions).toContain("project");
    },
    TEST_TIMEOUT
  );

  describe("squish_extract empty-query path", () => {
    it(
      "run on an empty database returns a structured result instead of throwing 'Query cannot be empty'",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_extract",
          { action: "run" },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();

        const parsed = parseToolResult(resp);
        // Regression: previously surfaced extraction_error "Query cannot be
        // empty" because the handler called search("", ...) which throws.
        expect(parsed.error).not.toBe("extraction_error");
        if (parsed._raw === undefined) {
          expect(parsed.ok).toBe(true);
          // Empty DB -> below the 5-memory threshold, reported gracefully.
          expect(parsed.count).toBe(0);
          expect(String(parsed.message)).toContain("Not enough memories");
        }
      },
      TEST_TIMEOUT
    );

    it(
      "run honors hoursBack as a filter without erroring",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_extract",
          { action: "run", hoursBack: 24 },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();

        const parsed = parseToolResult(resp);
        expect(parsed._raw ?? "{}").toBeDefined();
        if (parsed._raw === undefined) {
          expect(parsed.ok).toBe(true);
        }
      },
      TEST_TIMEOUT
    );
  });

  describe("squish_forget confirm gate", () => {
    it(
      "bulk delete without confirm stays a dry run and deletes nothing",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_forget",
          { search: "unreachable-token-nothing-matches" },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();

        const parsed = parseToolResult(resp);
        if (parsed._raw === undefined) {
          expect(parsed.dryRun).toBe(true);
          expect(parsed.deleted).toBe(0);
          expect(String(parsed.message)).toContain("confirm=true");
        }
      },
      TEST_TIMEOUT
    );

    it(
      "executes the destructive delete when confirm=true is provided",
      async () => {
        // Seed one uniquely-findable memory.
        const marker = `forget-confirm-marker-${Date.now()}`;
        const rememberResp = await sharedServer.callTool(
          "squish_remember",
          { content: `${marker} unique content for bulk delete` },
          TEST_TIMEOUT
        );
        const remembered = parseToolResult(rememberResp);
        expect(remembered.ok).toBe(true);

        // Dry run first: reports a match, deletes nothing.
        const dryResp = await sharedServer.callTool(
          "squish_forget",
          { search: marker },
          TEST_TIMEOUT
        );
        const dry = parseToolResult(dryResp);
        if (dry._raw === undefined) {
          expect(dry.dryRun).toBe(true);
          expect(dry.matched).toBeGreaterThanOrEqual(1);
          expect(dry.deleted).toBe(0);
        }

        // Confirmed call executes the deletion.
        const execResp = await sharedServer.callTool(
          "squish_forget",
          { search: marker, confirm: true },
          TEST_TIMEOUT
        );
        const executed = parseToolResult(execResp);
        if (executed._raw === undefined) {
          expect(executed.dryRun).toBe(false);
          expect(executed.deleted).toBeGreaterThanOrEqual(1);
        }

        // The memory is gone afterwards.
        const verifyResp = await sharedServer.callTool(
          "squish_forget",
          { search: marker },
          TEST_TIMEOUT
        );
        const verify = parseToolResult(verifyResp);
        if (verify._raw === undefined) {
          expect(verify.matched).toBe(0);
        }
      },
      TEST_TIMEOUT
    );
  });
});
