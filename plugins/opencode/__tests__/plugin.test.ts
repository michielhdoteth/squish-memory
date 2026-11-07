/**
 * Tests for the Squish OpenCode plugin (v1.5.5).
 *
 * The plugin folder is copied verbatim to ~/.config/opencode/plugins/ at
 * install time, so it has no test-time deps beyond zod. We do NOT import
 * the plugin file directly (it has top-level module state — `currentSessionID`).
 * Instead we:
 *
 *   1. Read the plugin file as text and assert structural invariants
 *      (no `squish sessions ...` shell-outs, presence of SDK calls, etc).
 *   2. Use the Bun bundler to typecheck the file end-to-end.
 *   3. Verify the default export shape and the 9 tool descriptions by
 *      dynamically importing the bundled output.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { build } from "bun";
// Type-only import: erased at runtime, so the plugin module (which carries
// top-level state) is still never executed here. The event shape is imported
// rather than re-declared so the fakes below cannot drift from what the
// plugin's `event` hook actually accepts.
import type { OpencodeEvent } from "../index";

const PLUGIN_DIR = resolve(import.meta.dir, "..");
const PLUGIN_INDEX = resolve(PLUGIN_DIR, "index.ts");
const BUILD_DIR = "C:\\Users\\michi\\AppData\\Local\\Temp\\squish-plugin-build2";

let source = "";
let builtPath = "";

async function removeFixtureDirectory(path: string, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
      if ((code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
}

beforeAll(async () => {
  source = await readFile(PLUGIN_INDEX, "utf8");

  const result = await build({
    entrypoints: [PLUGIN_INDEX],
    outdir: BUILD_DIR,
    target: "bun",
    format: "esm",
  });
  if (!result.success) {
    throw new Error("bun build failed: " + result.logs.join("\n"));
  }
  builtPath = resolve(BUILD_DIR, "index.js");
});

describe("plugin module shape", () => {
  it("has a default export { id: 'squish-memory', server: <plugin fn> }", async () => {
    const mod = (await import(builtPath)) as { default: { id: string; server: unknown } };
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("squish-memory");
    expect(typeof mod.default.server).toBe("function");
  });

  it("exposes all 9 LLM-invokable tools", async () => {
    const mod = (await import(builtPath)) as {
      default: {
        id: string;
        server: (input: unknown, opts?: unknown) => Promise<{
          tool: Record<string, { description: string }>;
          event: (input: { event: OpencodeEvent }) => Promise<void>;
        }>;
      };
    };

    // Build a minimal fake OpenCode SDK client for the plugin factory.
    const fakeClient = makeFakeClient();
    const hooks = await mod.default.server(
      { client: fakeClient, directory: "C:/repo", worktree: "C:/repo" },
      { autoCapture: true },
    );

    expect(hooks.tool).toBeDefined();
    const toolNames = Object.keys(hooks.tool).sort();
    // 9 tools: 4 legacy memory primitives + 5 session tools.
    // (squish_session_inject was removed in v1.5.5 - the agent has
    //  bash + code-exec and can call `squish sessions search` directly.)
    expect(toolNames).toEqual([
      "squish_context",
      "squish_recall",
      "squish_remember",
      "squish_session_capture",
      "squish_session_list",
      "squish_session_related",
      "squish_session_search",
      "squish_session_show",
      "squish_stats",
    ]);

    for (const name of toolNames) {
      expect(hooks.tool[name].description).toBeTruthy();
      expect(hooks.tool[name].description.length).toBeGreaterThan(20);
    }
  });

  it("the 4 legacy squish_* tools each have a description", async () => {
    const mod = (await import(builtPath)) as {
      default: {
        id: string;
        server: (input: unknown, opts?: unknown) => Promise<{
          tool: Record<string, { description: string }>;
          event: (input: { event: OpencodeEvent }) => Promise<void>;
        }>;
      };
    };

    const fakeClient = makeFakeClient();
    const hooks = await mod.default.server(
      { client: fakeClient, directory: "C:/repo", worktree: "C:/repo" },
      { autoCapture: true },
    );

    const legacyNames = ["squish_remember", "squish_recall", "squish_context", "squish_stats"];
    for (const name of legacyNames) {
      expect(hooks.tool[name]).toBeDefined();
      expect(hooks.tool[name].description).toBeTruthy();
      expect(hooks.tool[name].description.length).toBeGreaterThan(20);
    }
  });

  it("returns an event hook that handles the required event types", async () => {
    const mod = (await import(builtPath)) as {
      default: {
        id: string;
        server: (input: unknown, opts?: unknown) => Promise<{
          event: (input: { event: OpencodeEvent }) => Promise<void>;
        }>;
      };
    };

    const fakeClient = makeFakeClient();
    const hooks = await mod.default.server(
      { client: fakeClient, directory: "C:/repo", worktree: "C:/repo" },
      { autoCapture: true },
    );
    expect(typeof hooks.event).toBe("function");

    // Fire each required event type. The hook must not throw.
    const eventTypes = [
      "session.created",
      "session.diff",
      "file.edited",
      "session.idle",
      "session.error",
      "command.executed",
    ];
    for (const type of eventTypes) {
      const event = makeFakeEvent(type);
      await expect(hooks.event({ event })).resolves.toBeUndefined();
    }
  });

  it("injects project-scoped context by default while auto-capture remains off", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "squish-opencode-defaults-"));
    const cliArgsPath = join(tempDir, "cli-args.jsonl");
    const rememberSentinelPath = join(tempDir, "unexpected-remember.txt");
    const cliScriptPath = join(tempDir, "fake-squish.cjs");
    const previousPath = process.env.PATH;
    const client = makeFakeClient();
    const promptCalls: Array<{ path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }> = [];
    client.session.prompt = async (input) => {
      promptCalls.push(input as typeof promptCalls[number]);
      return { ok: true };
    };

    await writeFile(
      cliScriptPath,
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const args = process.argv.slice(2);',
        'fs.appendFileSync(path.join(__dirname, "cli-args.jsonl"), JSON.stringify(args) + "\\n");',
        'if (args[0] === "remember") fs.writeFileSync(path.join(__dirname, "unexpected-remember.txt"), "unexpected memory write");',
        'process.stdout.write(JSON.stringify({ block: "fixture context", totalTokens: 12, ceilingTokens: 2000 }));',
        "",
      ].join("\n"),
      "utf8",
    );

    if (process.platform === "win32") {
      await writeFile(
        join(tempDir, "squish.cmd"),
        ["@echo off", `"${process.execPath}" "${cliScriptPath}" %*`, ""].join("\r\n"),
        "utf8",
      );
    } else {
      const cliPath = join(tempDir, "squish");
      await writeFile(
        cliPath,
        `#!/bin/sh\nexec "${process.execPath}" "${cliScriptPath}" "$@"\n`,
        { encoding: "utf8", mode: 0o755 },
      );
    }

    process.env.PATH = `${tempDir}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;

    try {
      const mod = (await import(builtPath)) as {
        default: {
          server: (input: unknown, opts?: unknown) => Promise<{
            event: (input: { event: OpencodeEvent }) => Promise<void>;
          }>;
        };
      };
      const hooks = await mod.default.server({
        client,
        directory: tempDir,
        worktree: tempDir,
      });
      await hooks.event({ event: makeFakeEvent("session.created") });
      await hooks.event({ event: { type: "session.created", sessionID: "legacy-sess-2" } });

      let invocations: string[][] = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const rows = await readFile(cliArgsPath, "utf8");
          invocations = rows.trim().split("\n").map((row) => JSON.parse(row) as string[]);
        } catch {
          // Context injection is intentionally fire-and-forget.
        }
        if (invocations.length >= 2 && promptCalls.length >= 2) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }

      expect(invocations).toEqual([
        ["context", "--session-start", "--project", tempDir, "--json"],
        ["context", "--session-start", "--project", tempDir, "--json"],
      ]);
      expect(promptCalls.map((call) => call.path.id).sort()).toEqual(["legacy-sess-2", "sess-1"]);
      expect(promptCalls[0]).toMatchObject({
        path: { id: "sess-1" },
        body: { parts: [{ type: "text", text: expect.stringContaining("fixture context") }] },
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      await expect(readFile(rememberSentinelPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("writes a Windows session.created capture through the squish.cmd shim", async () => {
    if (process.platform !== "win32") return;
    const tempDir = await mkdtemp(join(tmpdir(), "squish-opencode-writeback-"));
    const dataDir = join(tempDir, "squish-data");
    const cliCompletedPath = join(tempDir, "cli-completed.txt");
    const previousPath = process.env.PATH;
    const previousDataDir = process.env.SQUISH_DATA_DIR;
    const cliPath = resolve(PLUGIN_DIR, "../../bin/squish.mjs");
    await writeFile(
      join(tempDir, "squish.cmd"),
      [
        "@echo off",
        `"${process.execPath}" "${cliPath}" %*`,
        `echo done> "${cliCompletedPath}"`,
        "",
      ].join("\r\n"),
      "utf8",
    );
    process.env.PATH = `${tempDir};${previousPath ?? ""}`;
    process.env.SQUISH_DATA_DIR = dataDir;

    try {
      const mod = (await import(builtPath)) as {
        default: {
          server: (input: unknown, opts?: unknown) => Promise<{
            event: (input: { event: OpencodeEvent }) => Promise<void>;
          }>;
        };
      };
      const hooks = await mod.default.server(
        { client: makeFakeClient(), directory: tempDir, worktree: tempDir },
        { autoCapture: true, autoInjectContext: false },
      );
      await hooks.event({ event: makeFakeEvent("session.created") });

      let storedMemory: { content: string; tags: string | null; metadata: string | null } | undefined;
      let cliCompleted = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        let database: Database | undefined;
        try {
          database = new Database(join(dataDir, "squish.db"), { readonly: true });
          storedMemory = database.query(
            "SELECT content, tags, metadata FROM memories WHERE content = ? AND tags LIKE ? ORDER BY created_at DESC LIMIT 1",
          ).get("(session started)", "%squish_session:sess-1%") as typeof storedMemory;
        } catch {
          // The event hook intentionally does not await its child process.
        } finally {
          database?.close();
        }
        try {
          cliCompleted = (await readFile(cliCompletedPath, "utf8")).trim() === "done";
        } catch {
          // Context capture runs asynchronously; wait for the command shim to return.
        }
        if (storedMemory && cliCompleted) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      expect(storedMemory).toBeDefined();
      expect(cliCompleted).toBe(true);
      if (storedMemory) {
        const tags = JSON.parse(storedMemory.tags ?? "[]") as string[];
        expect(tags).toContain("squish_chunk:summary");
        expect(tags).toContain("squish_session:sess-1");
        expect(tags).toContain("agent:opencode");
        expect(JSON.parse(storedMemory.metadata ?? "{}")).toMatchObject({ source: "opencode-plugin" });
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
      else process.env.SQUISH_DATA_DIR = previousDataDir;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      await removeFixtureDirectory(tempDir);
    }
  });
});

describe("plugin file structural invariants", () => {
  it("does NOT shell out to `squish sessions list|show|search|related|inject`", () => {
    // The plugin must not invoke the human-facing `squish sessions ...` CLI.
    // It SHOULD call `squish remember` and `squish recall` for chunk persistence.
    const banned = [
      '"sessions", "list"',
      '"sessions", "show"',
      '"sessions", "search"',
      '"sessions", "related"',
      '"sessions", "inject"',
    ];
    for (const needle of banned) {
      expect(source).not.toContain(needle);
    }
  });

  it("uses OpenCode SDK for session discovery", () => {
    expect(source).toContain("input.client.session.list");
    expect(source).toContain("input.client.session.get");
    expect(source).toContain("input.client.session.messages");
  });

  it("uses OpenCode SDK for prompt injection", () => {
    expect(source).toContain("input.client.session.prompt");
  });

  it("calls `squish remember` for chunk persistence", () => {
    expect(source).toMatch(/remember/);
  });

  it("calls `squish recall` for chunk search", () => {
    expect(source).toMatch(/recall/);
  });

  it("vendors the `tool()` helper and does not import @opencode-ai/plugin", () => {
    expect(source).not.toMatch(/from\s+["']@opencode-ai\/plugin["']/);
    expect(source).toMatch(/function\s+tool\b/);
  });

  it("vendors the `tool.schema` alias (same as @opencode-ai/plugin)", () => {
    expect(source).toContain("tool.schema");
  });
});

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

type FakeSdk = {
  list: () => Promise<unknown[]>;
  get: (input: { path: { id: string } }) => Promise<unknown>;
  messages: (input: { path: { id: string } }) => Promise<unknown>;
  diff: (input: { path: { id: string } }) => Promise<unknown>;
  prompt: (input: unknown) => Promise<unknown>;
};

function makeFakeClient(): {
  app: { log: (i: unknown) => Promise<unknown> };
  session: FakeSdk;
  vcs: { get: (i: { directory: string }) => Promise<{ branch?: string } | undefined> };
} {
  return {
    app: { log: async () => null },
    session: {
      list: async () => [],
      get: async () => ({ id: "fake", title: "fake" }),
      messages: async () => [],
      diff: async () => ({ files: [] }),
      prompt: async () => ({ ok: true }),
    },
    vcs: { get: async () => ({ branch: "main" }) },
  };
}

function makeFakeEvent(type: string): OpencodeEvent {
  switch (type) {
    case "session.created":
      return { type, id: "event-1", properties: { info: { id: "sess-1" } } };
    case "session.diff":
      return { type, sessionID: "sess-1", diff: { files: ["src/foo.ts"] } };
    case "file.edited":
      return { type, file: "src/bar.ts" };
    case "session.idle":
      return { type, sessionID: "sess-1" };
    case "session.error":
      return { type, sessionID: "sess-1", error: { message: "boom" } };
    case "command.executed":
      return { type, arguments: "npm test" };
    default:
      return { type };
  }
}
