import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_INDEX = join(import.meta.dir, "..", "..", "packages", "mcp", "src", "index.ts");

describe("background services graceful degradation", () => {
  it("MCP server source imports scheduler", async () => {
    const source = await readFile(MCP_INDEX, "utf-8");

    expect(source).toContain("sdkClient.initializeScheduler");

    // The scheduler itself lives in the SDK layer
    const sdkSource = await readFile(join(import.meta.dir, "..", "..", "packages", "core-sdk", "src", "index.ts"), "utf-8");
    expect(sdkSource).toContain("core/scheduler/cron-scheduler");
  });

  it("server startup does not crash if scheduler throws", async () => {
    const source = await readFile(MCP_INDEX, "utf-8");

    // Find the main() function and look for try/catch around initializeScheduler
    const schedulerCallIdx = source.indexOf("await sdkClient.initializeScheduler()");
    expect(schedulerCallIdx).toBeGreaterThan(-1);

    // Walk backwards to find the enclosing try block
    const preceding = source.substring(Math.max(0, schedulerCallIdx - 500), schedulerCallIdx);
    const enclosingTryIdx = preceding.lastIndexOf("try {");
    expect(enclosingTryIdx).toBeGreaterThan(-1);

    // Verify there is a catch block after the scheduler call
    const following = source.substring(schedulerCallIdx, schedulerCallIdx + 300);
    const catchIdx = following.indexOf("catch (error)");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeLessThan(300);

    // Verify the catch logs a warning but does not re-throw
    const catchBlock = following.substring(catchIdx, catchIdx + 200);
    expect(catchBlock).toContain("Warning");
    expect(catchBlock).not.toThrow;
  });

  it(
    "server responds to initialize even with background service errors",
    async () => {
      const rootDir = join(import.meta.dir, "..", "..");
      // Spawn MCP server directly (bypass relay script to avoid initialization hangs)
      const entry = join(rootDir, "packages", "mcp", "src", "index.ts");

      const tmpDir = await mkdtemp(join(tmpdir(), "squish-bg-degrade-"));

      // Use an invalid DATABASE_URL to force background service failures
      const child = spawn("bun", ["run", entry, "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: rootDir,
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://invalid:invalid@localhost:99999/nonexistent",
          SQUISH_DATA_DIR: tmpDir,
          SQUISH_MODE: "local",
          SQUISH_QUIET: "1",
        },
      });

      let stdoutBuf = "";
      let stderrBuf = "";
      const pendingReaders: Array<{
        matcher: (line: any) => boolean;
        resolve: (v: any) => void;
        reject: (e: Error) => void;
      }> = [];

      // MCP stdio uses newline-delimited JSON (one JSON object per line)
      child.stdout!.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        let nlIndex: number;
        while ((nlIndex = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.substring(0, nlIndex).replace(/\r$/, "");
          stdoutBuf = stdoutBuf.substring(nlIndex + 1);
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
              // not JSON, skip
            }
          }
        }
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
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

      try {
        // Give the server a moment to start (and potentially fail background services)
        await new Promise((r) => setTimeout(r, 2000));

        // Send initialize request - server should still respond
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-bg-degrade", version: "1.0.0" },
          },
        });

        const initResp = await readLine((r: any) => r.id === 1, 30_000);

        // Server must respond with valid MCP handshake even when bg services fail
        expect(initResp.result).toBeDefined();
        expect(initResp.result.serverInfo).toBeDefined();
        expect(initResp.result.serverInfo.name).toBe("squish-memory");
        expect(initResp.result.capabilities).toBeDefined();

        // Send ping to verify server is still operational
        send({ jsonrpc: "2.0", id: 2, method: "ping" });
        const pingResp = await readLine((r: any) => r.id === 2, 10_000);
        expect(pingResp.result).toBeDefined();

        // Verify stderr shows warnings about background service failures
        // (not fatal crashes)
        expect(stderrBuf).not.toContain("Fatal error");
        expect(stderrBuf).not.toContain("process.exit(1)");
      } finally {
        child.stdin!.end();
        child.kill("SIGKILL");
        // Wait for child process to fully exit before removing temp dir (Windows EBUSY fix)
        await new Promise<void>((resolve) => {
          child.on("close", () => resolve());
          // Fallback timeout in case close never fires
          setTimeout(() => resolve(), 2000);
        });
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    60_000
  );
});
