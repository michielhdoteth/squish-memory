/**
 * Project scope resolution regression tests.
 *
 * Root cause this locks down: `bin/squish-mcp.mjs` and `bin/squish.mjs` spawned
 * the runtime child with `cwd: rootDir`, throwing away the cwd the agent host
 * launched the wrapper with. `config.ts` `detectProjectRoot()` then fell back to
 * `process.cwd()` inside the child and resolved project scope to the package
 * install directory instead of the user's workspace.
 *
 * Two halves:
 *  1. static  - the wrappers must forward the launching cwd via buildRuntimeEnv.
 *  2. real     - spawn the real wrapper from a temp workspace and assert the
 *                scope reported by `squish_context { listProjects: true }` is
 *                that workspace and not the package root.
 *
 * The behavioural child gets SQUISH_DATA_DIR pointed at a temp dir, so no real
 * `.squish/squish.db` is ever opened.
 */

import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const packageRoot = join(import.meta.dir, "..", "..");
const mcpWrapperPath = join(packageRoot, "bin", "squish-mcp.mjs");
const cliWrapperPath = join(packageRoot, "bin", "squish.mjs");
const launcherPath = join(packageRoot, "bin", "runtime-launcher.mjs");

function readSource(path: string): string {
  return readFileSync(path, "utf-8");
}

/** Normalise a path the way config.ts detectProjectRoot() does before persisting it. */
function normalizeScope(value: string): string {
  const normalized = resolvePath(value).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return normalized;
}

interface McpClient {
  child: ChildProcess;
  request: (payload: unknown, timeoutMs: number) => Promise<any>;
  stderr: () => string;
  close: () => Promise<void>;
}

function spawnMcpWrapper(cwd: string, dataDir: string): McpClient {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, SQUISH_DATA_DIR: dataDir, SQUISH_QUIET: "1" };
  // Prove the wrapper supplies the scope itself: neither of the two variables
  // detectProjectRoot() consults is present in the launcher's environment.
  delete childEnv.SQUISH_WORKING_DIRECTORY;
  delete childEnv.INIT_CWD;

  const child = spawn("bun", ["run", mcpWrapperPath], {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const waiters: Array<{ id: number; resolve: (value: any) => void; reject: (error: Error) => void }> = [];

  child.stdout!.setEncoding("utf-8");
  child.stdout!.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf("\n");
      if (!line) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const waiterIndex = waiters.findIndex((waiter) => waiter.id === parsed?.id);
      if (waiterIndex !== -1) {
        const waiter = waiters[waiterIndex]!;
        waiters.splice(waiterIndex, 1);
        waiter.resolve(parsed);
      }
    }
  });

  child.stderr!.setEncoding("utf-8");
  child.stderr!.on("data", (chunk: string) => {
    stderrBuffer += chunk;
  });

  const client: McpClient = {
    child,
    stderr: () => stderrBuffer,
    request(payload, timeoutMs) {
      return new Promise((resolvePromise, rejectPromise) => {
        const id = (payload as { id: number }).id;
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.id === id);
          if (index !== -1) waiters.splice(index, 1);
          rejectPromise(
            new Error(`timed out after ${timeoutMs}ms waiting for id ${id}; stderr:\n${stderrBuffer.slice(-4000)}`)
          );
        }, timeoutMs);
        waiters.push({
          id,
          resolve: (value) => {
            clearTimeout(timer);
            resolvePromise(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            rejectPromise(error);
          },
        });
        child.stdin!.write(`${JSON.stringify(payload)}\n`);
      });
    },
    close() {
      return new Promise<void>((resolvePromise) => {
        try {
          child.stdin!.end();
        } catch {
          // stdin may already be closed
        }
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          resolvePromise();
        }, 5000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
        if (child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timer);
          resolvePromise();
        }
      });
    },
  };

  return client;
}

describe("project scope resolution (static)", () => {
  test("no wrapper pins the child cwd to the package root", () => {
    expect(readSource(mcpWrapperPath)).not.toContain("cwd: rootDir");
    expect(readSource(cliWrapperPath)).not.toContain("cwd: rootDir");
  });

  test("both wrappers forward the launching cwd through buildRuntimeEnv", () => {
    expect(readSource(mcpWrapperPath)).toContain("buildRuntimeEnv(rootDir)");
    expect(readSource(cliWrapperPath)).toContain("buildRuntimeEnv(rootDir)");
    expect(readSource(mcpWrapperPath)).toContain("buildRuntimeEnv,");
    expect(readSource(cliWrapperPath)).toContain("buildRuntimeEnv,");
  });

  test("runtime-launcher exports buildRuntimeEnv and sets SQUISH_WORKING_DIRECTORY", () => {
    const source = readSource(launcherPath);
    expect(source).toContain("export function buildRuntimeEnv(rootDir)");
    expect(source).toContain("env.SQUISH_WORKING_DIRECTORY = workingDir");
    // Only fills the gap when the operator did not set it.
    expect(source).toContain("if (!env.SQUISH_WORKING_DIRECTORY)");
  });
});

describe("project scope resolution (behaviour)", () => {
  test("buildRuntimeEnv fills the gap and respects an operator override", async () => {
    const { buildRuntimeEnv } = await import("../../bin/runtime-launcher.mjs");
    const originalWorkingDirectory = process.env.SQUISH_WORKING_DIRECTORY;
    try {
      delete process.env.SQUISH_WORKING_DIRECTORY;
      const inherited = buildRuntimeEnv(packageRoot);
      expect(normalizeScope(inherited.SQUISH_WORKING_DIRECTORY ?? "")).toBe(normalizeScope(process.cwd()));

      process.env.SQUISH_WORKING_DIRECTORY = join(packageRoot, "explicit-override");
      const overridden = buildRuntimeEnv(packageRoot);
      expect(overridden.SQUISH_WORKING_DIRECTORY).toBe(join(packageRoot, "explicit-override"));
    } finally {
      if (originalWorkingDirectory === undefined) delete process.env.SQUISH_WORKING_DIRECTORY;
      else process.env.SQUISH_WORKING_DIRECTORY = originalWorkingDirectory;
    }
  }, 15_000);

  test("detectProjectScope treats a blank override as unset and normalises the scope", async () => {
    const { detectProjectScope } = await import("../../config.js");
    const originalWorkingDirectory = process.env.SQUISH_WORKING_DIRECTORY;
    const originalInitCwd = process.env.INIT_CWD;
    try {
      // Blank env vars are the common accident (`SQUISH_WORKING_DIRECTORY=` in a
      // .env file); `??` used to accept them and collapse scope to empty.
      process.env.SQUISH_WORKING_DIRECTORY = "   ";
      delete process.env.INIT_CWD;
      expect(normalizeScope(detectProjectScope() ?? "")).toBe(normalizeScope(process.cwd()));

      // An explicit scope is normalised exactly like the `projects.path` row.
      process.env.SQUISH_WORKING_DIRECTORY = `  ${join(packageRoot, ".", "scope-normalisation")}  `;
      expect(detectProjectScope()).toBe(resolvePath(join(packageRoot, "scope-normalisation")));
    } finally {
      if (originalWorkingDirectory === undefined) delete process.env.SQUISH_WORKING_DIRECTORY;
      else process.env.SQUISH_WORKING_DIRECTORY = originalWorkingDirectory;
      if (originalInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = originalInitCwd;
    }
  }, 15_000);

  test("MCP server resolves scope to the launching workspace, not the package root", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "squish-scope-workspace-")));
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), "squish-scope-datadir-")));
    const client = spawnMcpWrapper(workspace, dataDir);

    try {
      await client.request(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "scope-resolution-test", version: "1.0.0" },
          },
        },
        30_000
      );
      client.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const response = await client.request(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "squish_context", arguments: { listProjects: true } },
        },
        30_000
      );

      expect(response.error).toBeUndefined();
      const payload = JSON.parse(response.result.content[0].text);
      expect(payload.ok).toBe(true);
      expect(normalizeScope(payload.currentProject.path)).toBe(normalizeScope(workspace));
      expect(normalizeScope(payload.currentProject.path)).not.toBe(normalizeScope(packageRoot));
    } finally {
      await client.close();
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }, 90_000);
});