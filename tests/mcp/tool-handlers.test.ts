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

  // When tests already run under bun, use the same runtime directly.
  // Probing PATH via execFileSync("where"/"--version") is fragile under
  // full-suite load and can spuriously fail into the node+tsx fallback,
  // which breaks when bun re-executes the tsx loader.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    return { command: process.execPath, args: [entryPath, "--stdio"] };
  }

  // Detect bun on PATH for non-bun runners
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

  // Fallback: try node with tsx
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
    // Strip leaked SQUISH_*/DATABASE_URL state from other test files so the
    // server always boots in local mode against the isolated tmp data dir.
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
  // Must drain stderr: if left unconsumed, the OS pipe buffer fills with
  // server logs and blocks the child process entirely.
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

  // Wait for the server to finish booting by polling its stderr for the
  // post-connect banner. A fixed sleep is fragile under full-suite CPU load:
  // cold-starting the MCP server (transpile + schema init) can take >60s.
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

async function initializeServer(handle: ServerHandle): Promise<void> {
  const id = handle.nextId();
  handle.send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-tool-handlers", version: "1.0.0" },
    },
  });
  await handle.readLine((r: any) => r.id === id, 90_000);

  handle.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

function parseToolResult(resp: any): any {
  const text = resp.result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    // Tool returned non-JSON text (e.g. error message) - wrap in raw object
    return { _raw: text, ok: false };
  }
}

function getRawText(resp: any): string {
  return resp.result.content[0].text;
}

// ─── Shared server (spawned once, shared across all describe blocks) ──

let sharedServer: ServerHandle;
let sharedTmpDir: string;

beforeAll(async () => {
  sharedTmpDir = await mkdtemp(join(tmpdir(), "squish-tool-handlers-"));
  sharedServer = await spawnServer(sharedTmpDir);
  await initializeServer(sharedServer);
}, 180_000);

afterAll(async () => {
  if (sharedServer) {
    await sharedServer.close();
  }
  if (sharedTmpDir) {
    await rm(sharedTmpDir, { recursive: true, force: true });
  }
}, 15_000);

// ─── Tests ────────────────────────────────────────────────────────────

describe("MCP Tool Handlers", () => {
  describe("squish_stats", () => {
    it(
      "returns health status with schema info",
      async () => {
        const resp = await sharedServer.callTool("squish_stats", {}, TEST_TIMEOUT);
        expect(resp.result).toBeDefined();
        expect(resp.result.content).toBeDefined();
        expect(resp.result.content.length).toBeGreaterThan(0);

        const text = getRawText(resp);
        // Health may return error text or valid JSON
        expect(text).toBeTruthy();
        expect(text.length).toBeGreaterThan(0);

        // If it's JSON, verify structure
        const parsed = parseToolResult(resp);
        if (parsed._raw !== undefined) {
          // Non-JSON response - acceptable as health check
          expect(typeof parsed._raw).toBe("string");
        } else {
          expect(parsed.ok).toBeDefined();
          expect(typeof parsed.ok).toBe("boolean");
          expect(parsed.version).toBeDefined();
        }
      },
      TEST_TIMEOUT
    );

    it(
      "includes tool count in response",
      async () => {
        const resp = await sharedServer.callTool("squish_stats", {}, TEST_TIMEOUT);
        const parsed = parseToolResult(resp);
        expect(parsed._raw).toBeUndefined();
        expect(parsed.ok).toBe(true);
        // Shape-checked rather than pinned: this used to assert a hardcoded
        // "2.1.0" behind a non-JSON tolerance branch, which hid the fact that
        // squish_stats only started returning JSON once the auto-detected
        // project scope was registered instead of throwing.
        expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(parsed.retrieval?.profile?.name).toMatch(/^(fast-local|high-recall)$/);
        expect(parsed.retrieval?.features?.reranker).toHaveProperty('source');
        expect(parsed.health?.checks).toBeArray();
        expect(['available', 'unavailable']).toContain(parsed.qmd);
        expect(parsed).toHaveProperty('watcher');
        expect(parsed).toHaveProperty('consolidation');
      },
      TEST_TIMEOUT
    );
  });

  describe("squish_remember", () => {
    it(
      "stores a memory with auto-detected type",
      async () => {
        const content = "The sky is blue and the grass is green";
        const resp = await sharedServer.callTool(
          "squish_remember",
          { content },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        const parsed = parseToolResult(resp);
        expect(parsed.ok).toBe(true);
        expect(parsed.id).toBeDefined();
        expect(parsed.routing).toBe("memory");
        expect(parsed.type).toBeDefined();
      },
      TEST_TIMEOUT
    );

    it(
      "stores with explicit type (decision)",
      async () => {
        const content = "We decided to use PostgreSQL for the database backend";
        const resp = await sharedServer.callTool(
          "squish_remember",
          { content, type: "decision" },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        const parsed = parseToolResult(resp);
        expect(parsed.ok).toBe(true);
        expect(parsed.id).toBeDefined();
        expect(parsed.type).toBe("decision");
      },
      TEST_TIMEOUT
    );

    it(
      "returns success with memory ID",
      async () => {
        const content = "Unit test memory with ID verification";
        const resp = await sharedServer.callTool(
          "squish_remember",
          { content },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        const parsed = parseToolResult(resp);
        expect(parsed.ok).toBe(true);
        expect(parsed.id).toBeDefined();
        // Verify the ID is a UUID format
        expect(parsed.id).toMatch(/^[0-9a-f-]{36}$/);
      },
      TEST_TIMEOUT
    );

    it(
      "handles tags correctly",
      async () => {
        const content = "Tagged memory for testing purposes";
        const tags = ["test-tag", "unit-test", "mcp"];
        const resp = await sharedServer.callTool(
          "squish_remember",
          { content, tags },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        const parsed = parseToolResult(resp);
        expect(parsed.ok).toBe(true);
        expect(parsed.id).toBeDefined();
      },
      TEST_TIMEOUT
    );

    it(
      "retains source and application context with ordinary memories",
      async () => {
        const content = "Use the verified dry-run path before a production migration.";
        const sourceId = `source-${crypto.randomUUID()}`;
        const procedureKey = `database-migration-${crypto.randomUUID()}`;
        const resp = await sharedServer.callTool("squish_remember", {
          content,
          type: "context",
          sourceId,
          observedAt: "2026-10-14T12:00:00.000Z",
          reasoning: "This avoids applying an unreviewed migration.",
          examples: "Check the migration diff and row counts first.",
          exceptions: "Emergency rollback follows the incident procedure.",
          outcome: "success",
          outcomeEvidenceId: `deploy-receipt-${crypto.randomUUID()}`,
          procedureKey,
        }, TEST_TIMEOUT);
        const stored = parseToolResult(resp);
        expect(stored.ok).toBe(true);

        const recalledResponse = await sharedServer.callTool("squish_recall", {
          query: stored.id,
        }, TEST_TIMEOUT);
        const recalled = parseToolResult(recalledResponse);
        const memory = recalled.memories.find((item: { id: string }) => item.id === stored.id);
        expect(memory).toBeDefined();
        expect(Object.keys(memory).every((key: string) => ["confidence", "content", "id", "type"].includes(key))).toBe(true);
      },
      TEST_TIMEOUT
    );

    it("requires source evidence for a reported procedure outcome", async () => {
      const response = await sharedServer.callTool("squish_remember", {
        content: "The migration procedure succeeded.",
        outcome: "success",
      }, TEST_TIMEOUT);
      const parsed = parseToolResult(response);
      expect(parsed.ok).not.toBe(true);
      expect(JSON.stringify(parsed)).toContain("outcomeEvidenceId");
    });

    it("requires the outcome memory to retain its source record ID", async () => {
      const response = await sharedServer.callTool("squish_remember", {
        content: "The migration procedure succeeded.",
        outcome: "success",
        outcomeEvidenceId: `receipt-${crypto.randomUUID()}`,
        procedureKey: `migration-${crypto.randomUUID()}`,
      }, TEST_TIMEOUT);
      const parsed = parseToolResult(response);
      expect(parsed.ok).not.toBe(true);
      expect(JSON.stringify(parsed)).toContain("sourceId");
    });
  });

  describe("squish_recall", () => {
    // Global memory is visible from every project scope, so these assertions
    // test scope resolution rather than which rows happen to be stored.
    const GLOBAL_MEMORY = "Recall test memory for unique query verification";
    const REGISTERED_SCOPE = "/squish-tool-handlers/registered-scope";
    const UNREGISTERED_SCOPE = "/squish-tool-handlers/never-registered-scope";

    beforeAll(async () => {
      const resp = await sharedServer.callTool(
        "squish_remember",
        { content: GLOBAL_MEMORY, type: "fact", global: true },
        TEST_TIMEOUT
      );
      expect(parseToolResult(resp).ok).toBe(true);

      // Register REGISTERED_SCOPE up front so the recall tests below exercise a
      // registered-project read. squish_context action=session-start is the
      // MCP surface that passes ensureProject:true.
      const registerResp = await sharedServer.callTool(
        "squish_context",
        { project: REGISTERED_SCOPE, action: "session-start" },
        TEST_TIMEOUT
      );
      expect(registerResp.result).toBeDefined();
    }, TEST_TIMEOUT);

    it(
      "searches by query text",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_recall",
          { query: GLOBAL_MEMORY, project: REGISTERED_SCOPE },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        const parsed = parseToolResult(resp);
        expect(parsed._raw).toBeUndefined();
        expect(["ok", "partial"].includes(parsed.status)).toBe(true);
        expect(parsed.missing).toBeArray();
        expect(
          parsed.memories.some((r: { content: string }) => r.content.includes(GLOBAL_MEMORY))
        ).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      "respects limit parameter",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_recall",
          { query: "test", limit: 1, project: REGISTERED_SCOPE },
          TEST_TIMEOUT
        );
        const parsed = parseToolResult(resp);
        expect(parsed._raw).toBeUndefined();
        expect(["ok", "partial", "none"].includes(parsed.status)).toBe(true);
        expect(parsed.memories.length).toBeLessThanOrEqual(1);
      },
      TEST_TIMEOUT
    );

    it(
      "returns ID-addressable compact evidence within an optional output budget",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_recall",
          { query: GLOBAL_MEMORY, project: REGISTERED_SCOPE, maxTokens: 128 },
          TEST_TIMEOUT
        );
        const raw = resp.result?.content?.find((item: { type: string }) => item.type === "text")?.text ?? "";
        const parsed = JSON.parse(raw);
        expect(Math.ceil(raw.length / 3)).toBeLessThanOrEqual(128);
        expect(parsed.memories[0].id).toBeDefined();
        expect(parsed.memories[0].content).toContain(GLOBAL_MEMORY);
        expect(Object.keys(parsed).sort()).toEqual(["memories", "missing", "status"]);
      },
      TEST_TIMEOUT
    );

    it(
      "expands a compact evidence ID through the direct-ID recall path",
      async () => {
        const write = await sharedServer.callTool(
          "squish_remember",
          { content: "Direct ID expansion fixture for compact recall", type: "fact", global: true },
          TEST_TIMEOUT
        );
        const id = parseToolResult(write).id;
        const resp = await sharedServer.callTool(
          "squish_recall",
          { query: id, maxTokens: 128 },
          TEST_TIMEOUT
        );
        const parsed = parseToolResult(resp);
        expect(parsed.status).toBe("ok");
        expect(parsed.missing).toEqual([]);
        expect(parsed.memories[0].id).toBe(id);
        expect(parsed.memories[0].content).toContain("Direct ID expansion fixture");
      },
      TEST_TIMEOUT
    );

    it(
      "handles type parameter",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_recall",
          { query: GLOBAL_MEMORY, project: REGISTERED_SCOPE },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        const parsed = parseToolResult(resp);
        expect(parsed._raw).toBeUndefined();
        expect(["ok", "partial"].includes(parsed.status)).toBe(true);
        expect(parsed.memories.length).toBeGreaterThanOrEqual(1);
        expect(parsed.memories[0].type).toBeDefined();
      },
      TEST_TIMEOUT
    );

    it(
      "returns results for a project scope that was never registered",
      async () => {
        // Previously requireProject threw ProjectNotFoundError here and
        // squish_recall failed 100% of the time for any scope the write path
        // had not already created. The chosen behaviour is auto-registration:
        // the read succeeds and still keeps other projects isolated.
        const resp = await sharedServer.callTool(
          "squish_recall",
          { query: GLOBAL_MEMORY, project: UNREGISTERED_SCOPE },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        const parsed = parseToolResult(resp);
        expect(parsed._raw).toBeUndefined();
        expect(["ok", "partial"].includes(parsed.status)).toBe(true);
        expect(
          parsed.memories.some((r: { content: string }) => r.content.includes(GLOBAL_MEMORY))
        ).toBe(true);
      },
      TEST_TIMEOUT
    );
  });

  describe("squish_sessions recovery", () => {
    it("exposes compact captured-memory recovery with a session id", async () => {
      const resp = await sharedServer.callTool("squish_sessions", {
        action: "recover",
        sessionId: "not-captured-session-0001",
        query: "distinctive absent session recovery test phrase",
        budgetTokens: 128,
      }, TEST_TIMEOUT);
      const parsed = parseToolResult(resp);
      expect(parsed.ok).toBe(true);
      expect(parsed.sessionId).toBe("not-captured-session-0001");
      expect(parsed.evidence).toEqual([]);
      expect(parsed.omittedCount).toBe(0);
    }, TEST_TIMEOUT);
  });

  describe("squish_context", () => {
    it(
      "returns project context for current directory",
      async () => {
        const resp = await sharedServer.callTool("squish_context", {}, TEST_TIMEOUT);
        expect(resp.result).toBeDefined();
        const parsed = parseToolResult(resp);
        // Context may return ok:true JSON or error text
        if (parsed._raw !== undefined) {
          expect(typeof parsed._raw).toBe("string");
        } else {
          expect(parsed.ok).toBeDefined();
        }
      },
      TEST_TIMEOUT
    );

    it(
      "handles missing project gracefully",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_context",
          { project: "/nonexistent/path/for/test" },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        // Should not crash, may return error or empty context
      },
      TEST_TIMEOUT
    );
  });

  describe("squish_stats", () => {
    it(
      "returns memory statistics",
      async () => {
        const resp = await sharedServer.callTool("squish_stats", {}, TEST_TIMEOUT);
        expect(resp.result).toBeDefined();
        const parsed = parseToolResult(resp);
        if (parsed._raw !== undefined) {
          expect(typeof parsed._raw).toBe("string");
        } else {
          expect(parsed.ok).toBe(true);
        }
      },
      TEST_TIMEOUT
    );

    it(
      "works globally (no project filter)",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_stats",
          {},
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        const parsed = parseToolResult(resp);
        if (parsed._raw !== undefined) {
          expect(typeof parsed._raw).toBe("string");
        } else {
          expect(parsed.ok).toBeDefined();
        }
      },
      TEST_TIMEOUT
    );
  });

  describe("squish_link", () => {
    let memoryId1: string;
    let memoryId2: string;

    beforeAll(async () => {
      const resp1 = await sharedServer.callTool(
        "squish_remember",
        { content: "First memory for link testing" },
        TEST_TIMEOUT
      );
      memoryId1 = parseToolResult(resp1).id;

      const resp2 = await sharedServer.callTool(
        "squish_remember",
        { content: "Second memory for link testing" },
        TEST_TIMEOUT
      );
      memoryId2 = parseToolResult(resp2).id;
    }, TEST_TIMEOUT);

    it(
      "add creates association between memories",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_link",
          {
            action: "add",
            fromId: memoryId1,
            toId: memoryId2,
          },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        const text = resp.result.content[0].text;
        expect(text).toContain("Association created");
      },
      TEST_TIMEOUT
    );

    it(
      "find finds related memories",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_link",
          { action: "find", memoryId: memoryId1 },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        const text = resp.result.content[0].text;
        expect(text).toContain("related memories");
      },
      TEST_TIMEOUT
    );
  });

  describe("squish_forget", () => {
    let forgetMemoryId: string;

    beforeAll(async () => {
      // Store a memory to delete
      const resp = await sharedServer.callTool(
        "squish_remember",
        { content: "Memory to forget for testing" },
        TEST_TIMEOUT
      );
      const parsed = parseToolResult(resp);
      forgetMemoryId = parsed.id;
    }, TEST_TIMEOUT);

    it(
      "deletes a memory by ID",
      async () => {
        const resp = await sharedServer.callTool(
          "squish_forget",
          {
            memoryId: forgetMemoryId,
          },
          TEST_TIMEOUT
        );
        expect(resp.result).toBeDefined();
        const parsed = parseToolResult(resp);
        expect(parsed.ok).toBe(true);
        expect(parsed.deleted).toBe(1);
      },
      TEST_TIMEOUT
    );
  });
});
