#!/usr/bin/env node

// Load .env file for config
import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../../../.env') });
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import express from "express";
import { timingSafeEqual } from "crypto";
import rateLimit from "express-rate-limit";
// Zod v4 classic schemas satisfy the v2 SDK's Standard Schema contract
// (v2 requires zod >=4.2; the v1 zod/v3 compat subpath is no longer supported)
import { z } from "zod";
import { config, detectProjectScope } from "../../../config.js";
import {
  isSchemaDriftError,
  probeSchemaHealth,
  type SchemaProbeResult,
} from "@squish/core-sdk";
// SDK client — replaces direct core imports for recall, search, remember, forget,
// listProjects, associations, scheduler, and graph operations
import { SquishClient } from "@squish/core-sdk";
// Tool-call tracing (in-memory ring buffer)
import { traceToolCall } from "./tracing.js";
// Tool registration modules (extracted from inline definitions)
import { registerMemoryTools } from "./tools/memory.js";
import { registerTeamTools } from "./tools/team.js";
import { registerSkillTools } from "./tools/skill.js";
// Additive capability tools
import {
  registerPlacesTools,
  registerSessionsTools,
  registerTierTools,
  registerMaintenanceTools,
  registerStalenessReportTools,
} from "./tools/extras.js";
import { registerDedupTools } from "./tools/dedup.js";
import { registerEditsTools } from "./tools/edits.js";

// CRITICAL: Redirect console.log to stderr AFTER all imports

// CRITICAL: Redirect console.log to stderr AFTER all imports
// MCP stdio requires stdout to contain ONLY valid JSON-RPC messages
// Must be after imports because ESM hoists imports above this assignment
console.log = console.error;
console.info = console.error;

const SERVER_NAME = "squish-memory";
const SERVER_VERSION = "2.1.0";

// Shown to agents at connection time (MCP initialize response).
// Harness-agnostic: this server is universal pluggable memory.
const SERVER_INSTRUCTIONS = `Squish is your persistent memory across all sessions and harnesses. Memory is project-scoped: what you save here is available next time you or any other agent works on this project.

Use squish_remember to store facts, decisions, preferences, and lessons worth keeping. Use squish_recall before starting work to surface prior context; search by topic, not by date. Use squish_sessions to review past sessions, and squish_skill or squish_extract when accumulated memories contain reusable procedures. Use squish_forget carefully: single deletes are immediate; bulk deletes are dry-run only until you pass confirm=true. Store proactively when you learn something durable; recall proactively when context would change your answer.`;

// Reference to the HTTP server (when running in http mode) so shutdown can close it
let httpServerRef: import('node:http').Server | null = null;

// Create shared SDK client — wraps core storage/embeddings for clean API access
const sdkClient = new SquishClient();

function parseArgs(): { mode: "stdio" | "http"; port: number; health: boolean } {
  const args = process.argv.slice(2);
  let mode: "stdio" | "http" = "stdio";
  let port = config.mcpServerPort || 8767;
  let health = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--http" || args[i] === "-h") {
      mode = "http";
    } else if (args[i] === "--stdio" || args[i] === "-s") {
      mode = "stdio";
    } else if (args[i] === "--port" || args[i] === "-p") {
      port = parseInt(args[i + 1], 10) || 8767;
      i++;
    } else if (args[i] === "--health" || args[i] === "--check") {
      health = true;
    }
  }

  if (process.env.SQUISH_MCP_MODE === "http" || process.env.SQUISH_MCP_HTTP === "true") {
    mode = "http";
  }

  return { mode, port, health };
}

function safeRegisterTool(
  server: McpServer,
  name: string,
  definition: any,
  handler: any
): boolean {
  try {
    server.registerTool(name, definition, async (input: any): Promise<any> => {
      const probe = await probeSchemaHealth();
      if (probe.status !== "ok") {
        return schemaProbeErrorResult(probe);
      }

      try {
        return await traceToolCall(name, () => handler(input));
      } catch (error) {
        if (isSchemaDriftError(error)) {
          return schemaProbeErrorResult(error.probe);
        }

        const probe = await probeSchemaHealth();
        if (probe.status !== "ok") {
          return schemaProbeErrorResult(probe);
        }

        throw error;
      }
    });
    console.error(`[MCP] Registered tool: ${name}`);
    return true;
  } catch (error) {
    console.error(`[MCP] Failed to register tool ${name}:`, error);
    return false;
  }
}

function schemaProbeErrorResult(probe: SchemaProbeResult) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: false,
        error: probe.status === "drifted" ? "schema_drift" : "database_unavailable",
        backend: probe.backend,
        detail: probe.detail,
        missingTables: probe.missingTables,
        remediation: probe.remediation,
      }, null, 2),
    }],
    isError: true,
  };
}

function toInputJsonSchema(schema: unknown) {
  try {
    return z.toJSONSchema(schema as any);
  } catch {
    return schema;
  }
}

function errorResponse(code: string, message: string, detail?: string, remediation?: string) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: false,
        error: code,
        message,
        ...(detail && { detail }),
        ...(remediation && { remediation }),
        version: SERVER_VERSION,
      }, null, 2),
    }],
    isError: true,
  };
}

/**
 * Resolve the effective project path for an MCP tool.
 * Priority: explicit project argument > auto-detected from env/cwd > null (global)
 */
function resolveProjectPath(projectArg?: string): string | undefined {
  if (projectArg) return projectArg;
  return detectProjectScope() ?? undefined;
}

function createSquishServer(): { server: McpServer; toolCount: number } {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  let toolCount = 0;

  console.error(`[MCP] Starting tool registration...`);

  // Register extracted tool modules
  const memoryCtx = {
    register: safeRegisterTool,
    server,
    sdkClient,
    resolveProjectPath,
    errorResponse,
    SERVER_VERSION,
  };
  toolCount += registerMemoryTools(memoryCtx);
  toolCount += registerTeamTools(memoryCtx);
  toolCount += registerSkillTools(memoryCtx);

  // Additive capability tools (thin wrappers over existing SDK methods)
  const extrasCtx = {
    register: safeRegisterTool,
    server,
    sdkClient,
    resolveProjectPath,
    errorResponse,
    SERVER_VERSION,
  };
  toolCount += registerPlacesTools(extrasCtx);
  toolCount += registerSessionsTools(extrasCtx);
  toolCount += registerTierTools(extrasCtx);
  toolCount += registerMaintenanceTools(extrasCtx);
  toolCount += registerDedupTools(extrasCtx);
  toolCount += registerEditsTools(extrasCtx);
  toolCount += registerStalenessReportTools(extrasCtx);

  console.error(`[MCP] Tool registration complete. Registered ${toolCount} tools.`);

  return { server, toolCount };
}

async function runStdio(): Promise<void> {
  console.error(`[MCP] Starting in STDIO mode (2026-07-28 protocol)...`);
  const probe = await probeSchemaHealth();
  if (probe.status !== "ok") {
    console.error(`[MCP] Degraded startup: ${probe.detail}`);
    if (probe.remediation) {
      console.error(`[MCP] Remediation: ${probe.remediation}`);
    }
  }

  await serveStdio(() => {
    const { server } = createSquishServer();
    return server;
  }, { legacy: 'serve' });
}

async function runHttp(port: number): Promise<void> {
  console.error(`[MCP] Starting in HTTP mode (2026-07-28 protocol) on port ${port}...`);
  const startupProbe = await probeSchemaHealth();
  if (startupProbe.status !== "ok") {
    console.error(`[MCP] Degraded startup: ${startupProbe.detail}`);
    if (startupProbe.remediation) {
      console.error(`[MCP] Remediation: ${startupProbe.remediation}`);
    }
  }

  // Create the MCP handler using the v2 factory pattern (per-request server instances)
  const mcpHandler = createMcpHandler(
    () => {
      const { server } = createSquishServer();
      return server;
    },
    { legacy: 'stateless' }
  );

  const nodeHandler = toNodeHandler(mcpHandler);

  const app = express();
  app.use(express.json());

  // CORS for web-based MCP clients (restrictive origins)
  const allowedOrigins = process.env.SQUISH_CORS_ORIGINS
    ? process.env.SQUISH_CORS_ORIGINS.split(',').map((s: string) => s.trim())
    : [`http://localhost:${port}`];

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, x-api-key, authorization');
    res.header('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Rate limiting for /mcp endpoint (60 requests per minute per IP)
  const mcpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });

  // API key auth for HTTP mode - MANDATORY for security (H-01)
  const MCP_API_KEY = process.env.SQUISH_MCP_API_KEY || '';
  if (!MCP_API_KEY) {
    console.error(`[MCP] FATAL: HTTP mode requires SQUISH_MCP_API_KEY to be set. Refusing to start without authentication.`);
    process.exit(1);
  }
  function checkMcpAuth(req: express.Request, res: express.Response): boolean {
    const provided = req.headers['x-api-key'] as string || req.headers['authorization']?.replace('Bearer ', '') || '';
    let isMatch = false;
    if (provided.length === MCP_API_KEY.length && provided.length > 0) {
      isMatch = timingSafeEqual(Buffer.from(provided), Buffer.from(MCP_API_KEY));
    }
    if (!isMatch) {
      res.status(401).json({ error: 'Unauthorized. Set SQUISH_MCP_API_KEY or provide x-api-key header.' });
      return false;
    }
    return true;
  }

  // Health check endpoint
  app.get("/health", (req, res) => {
    void probeSchemaHealth().then((probe) => {
      res.json({
        status: probe.status === "ok" ? "ok" : (probe.status === "drifted" ? "degraded" : "broken"),
        version: SERVER_VERSION,
      });
    }).catch(() => {
      res.status(500).json({
        status: "broken",
        version: SERVER_VERSION,
      });
    });
  });

  // Route all MCP requests through createMcpHandler via toNodeHandler
  app.all("/mcp", mcpLimiter, (req, res) => {
    if (!checkMcpAuth(req, res)) return;
    nodeHandler(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServerRef = app.listen(port, () => {
      console.error(`[MCP] HTTP server listening on port ${port}`);
      console.error(`[MCP] Streamable HTTP endpoint: http://localhost:${port}/mcp`);
      console.error(`[MCP] Health: http://localhost:${port}/health`);
      resolve();
    });
  });
}

async function runHealthCheck(): Promise<void> {
  console.error(`[MCP] Running health check...`);

  try {
    const { server, toolCount } = createSquishServer();
    const probe = await probeSchemaHealth();
    console.error(`[MCP] Health check passed. Server initialized with ${toolCount} tools.`);
    if (probe.status !== "ok") {
      console.error(`[MCP] Degraded: ${probe.detail}`);
      if (probe.remediation) {
        console.error(`[MCP] Remediation: ${probe.remediation}`);
      }
    }
    process.exit(probe.status === "unavailable" ? 1 : 0);
  } catch (error) {
    console.error(`[MCP] Health check failed:`, error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  try {
    console.error(`[${SERVER_NAME}] v${SERVER_VERSION} initializing...`);
    console.error(`[${SERVER_NAME}] Mode: local`);
    console.error(`[${SERVER_NAME}] Embeddings: ${config.embeddingsProvider}`);

    const { mode, port, health } = parseArgs();

    if (health) {
      await runHealthCheck();
      return;
    }

    // Initialize cron scheduler for scheduled jobs
    try {
      await sdkClient.initializeScheduler();
      console.error(`[${SERVER_NAME}] Cron scheduler initialized`);
    } catch (error) {
      console.error(`[${SERVER_NAME}] Warning: Failed to initialize scheduler:`, error);
    }

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`[${SERVER_NAME}] Shutting down gracefully...`);

      // Hard-exit safety timer in case keep-alive connections stall close
      const hardExitTimer = setTimeout(() => {
        console.error(`[${SERVER_NAME}] Graceful shutdown timed out, forcing exit...`);
        httpServerRef?.closeAllConnections?.();
        process.exit(0);
      }, 5000);
      hardExitTimer.unref();

      // Stop accepting new work
      if (httpServerRef) {
        try {
          await new Promise<void>((resolve) => httpServerRef!.close(() => resolve()));
          clearTimeout(hardExitTimer);
          console.error(`[${SERVER_NAME}] HTTP server closed`);
        } catch (error) {
          console.error(`[${SERVER_NAME}] Error closing HTTP server:`, error);
        }
      }

      // Close DB connections cleanly
      try {
        const { closeAllDbs } = await import("../../../db/index.js");
        await closeAllDbs();
        console.error(`[${SERVER_NAME}] Database connections closed`);
      } catch (error) {
        console.error(`[${SERVER_NAME}] Error closing database connections:`, error);
      }

      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    if (mode === "stdio") {
      await runStdio();
    } else {
      await runHttp(port);
    }
  } catch (error) {
    console.error(`[${SERVER_NAME}] Fatal error:`, error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] Fatal error:`, error);
  process.exit(1);
});
