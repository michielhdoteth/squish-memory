/**
 * Squish Plugin for OpenClaw
 * 
 * Provides persistent memory and auto-capture hooks.
 * 
 * Installation:
 * - Run: openclaw plugins install ./path/to/squish-memory
 * - Then: openclaw gateway restart
 * - Config: plugins.entries.squish-memory.enabled = true
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function getSquishCommand() {
  return process.platform === "win32" ? "squish.cmd" : "squish";
}

/**
 * Shape of the JSON the `squish` CLI subcommands used here print to stdout.
 * Only the fields this plugin reads are declared; each tool result keeps its
 * own fields non-optional because they are read without a fallback.
 */
type SquishJsonResult = {
  id: string;
  status?: string;
  missing?: string[];
  totalMemories?: number;
  memories?: Array<{ type?: string; summary?: string; content: string }>;
  durableMemories?: Array<{ content: string }>;
};

async function runSquishJson(args: string[], cwd?: string): Promise<SquishJsonResult> {
  const { stdout } = await execFileAsync(
    getSquishCommand(),
    args,
    {
      cwd: cwd || process.cwd(),
      env: { ...process.env, SQUISH_QUIET: "1" },
      maxBuffer: 1024 * 1024,
    }
  );

  return JSON.parse(stdout) as SquishJsonResult;
}

// Plugin entry point
const squishPlugin = definePluginEntry({
  id: "squish-memory",
  name: "Squish Memory",
  description: "Persistent memory for AI agents - remembers conversations, injects context, auto-captures tool results",
  kind: "memory",

  // Config schema
  configSchema: Type.Object({
    dataDir: Type.Optional(Type.String()),
    autoCapture: Type.Optional(Type.Boolean()),
    contextLimit: Type.Optional(Type.Number())
  }),

  // Register plugin capabilities
  register(api) {
    if (api.registrationMode !== "full") return;

    const config = api.pluginConfig || {};
    const autoCapture = config.autoCapture ?? true;
    const contextLimit = config.contextLimit ?? 5;

    // Register custom tools using TypeBox
    api.registerTool({
      name: "squish_remember",
      description: "Remember a memory for future context",
      parameters: Type.Object({
        content: Type.String({ description: "What to remember" }),
        type: Type.Optional(Type.String({ description: "Type: observation, fact, decision, preference, note, context" })),
        place: Type.Optional(Type.String({ description: "Place: inbox, wip, ref, sandbox, board, sparks, archive" }))
      }),
      async execute(_id, params) {
        const projectId = api.workingDirectory;
        const result = await runSquishJson([
          "remember",
          params.content,
          "--type",
          params.type || "observation",
          "--project",
          projectId,
          "--place",
          params.place || "wip"
        ], projectId);
        const id = result.id;

        return {
          content: [{ type: "text", text: `Memory saved (${id.slice(0, 8)})` }]
        };
      }
    });

    api.registerTool({
      name: "squish_recall",
      description: "Recall memories by search query",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(Type.Number({ description: "Max results" }))
      }),
      async execute(_id, params) {
        const projectId = api.workingDirectory;
        const limit = params.limit || 5;
        const result = await runSquishJson([
          "recall",
          params.query,
          "--limit",
          String(limit),
          "--project",
          projectId
        ], projectId);
        const memories = result.memories || [];
        const coverage = [
          `Recall status: ${result.status || (memories.length ? "partial" : "none")}`,
          ...(Array.isArray(result.missing) && result.missing.length ? [`Missing: ${result.missing.join(", ")}`] : []),
        ].join("\n");

        if (memories.length === 0) {
          return { content: [{ type: "text", text: `${coverage}\nNo memories found for that query` }] };
        }

        const text = `${coverage}\nMemories:\n` + memories.map(m =>
          `[${m.type}] ${m.summary || m.content.slice(0, 60)}`
        ).join("\n");

        return { content: [{ type: "text", text }] };
      }
    });

    api.registerTool({
      name: "squish_context",
      description: "Inject memory context into current session",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Number of memories to fetch" }))
      }),
      async execute(_id, params) {
        const projectId = api.workingDirectory;
        const limit = params.limit || 3;
        const result = await runSquishJson([
          "context",
          "--json",
          "--limit",
          String(limit),
          "--project",
          projectId
        ], projectId);
        const memories = result?.durableMemories || [];

        if (memories.length === 0) {
          return { content: [{ type: "text", text: "No context available" }] };
        }

        const text = memories.map(m => m.content).join("\n---\n");

        return { content: [{ type: "text", text }] };
      }
    });

    api.registerTool({
      name: "squish_stats",
      description: "Get memory statistics",
      parameters: Type.Object({}),
      async execute(_id, _params) {
        const projectId = api.workingDirectory;
        const result = await runSquishJson(["stats", "--json", "--project", projectId], projectId);
        const count = result.totalMemories ?? 0;
        return { content: [{ type: "text", text: `Total memories: ${count}` }] };
      }
    });

    // Auto-capture hook - runs on session idle
    if (autoCapture) {
      api.on("session_end", async (context) => {
        // Capture important messages before session ends
        const messages = context.messages || [];
        const important = messages
          .filter(m => m.role === "user" && (m.content?.length || 0) > 20)
          .slice(-10);

        if (important.length > 0) {
          const content = important
            .map(m => (m.content || "").slice(0, 100))
            .join(" | ");

          await runSquishJson([
            "remember",
            content,
            "--type",
            "context",
            "--project",
            context.workingDirectory,
            "--place",
            "inbox"
          ], context.workingDirectory).catch(() => null);
        }
      }, { priority: 50 });
    }

    // Session start hook - inject context
    api.on("session_start", async (context) => {
      const result = await runSquishJson([
        "context",
        "--json",
        "--limit",
        String(contextLimit),
        "--project",
        context.workingDirectory
      ], context.workingDirectory).catch(() => ({ durableMemories: [] }));
      const memories = result?.durableMemories || [];

      if (memories.length > 0) {
        return {
          messages: memories.map(m => ({
            role: "user" as const,
            content: `[Memory] ${m.content.slice(0, 200)}`
          }))
        };
      }
    }, { priority: 50 });

    api.logger.info("Squish Memory plugin registered");
  }
});

export default squishPlugin;
