#!/usr/bin/env node

// Load .env file for config
import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../../../.env') });
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
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
import { logger } from "../../../core/logger.js";
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

// Create server instance ONCE (not per-session)
const { server: SQUISH_SERVER, toolCount: SQUISH_TOOL_COUNT } = createSquishServer();
console.error(`[MCP] Server created with ${SQUISH_TOOL_COUNT} tools`);

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

async function runStdio(server: McpServer, toolCount: number): Promise<void> {
  console.error(`[MCP] Starting in STDIO mode...`);
  const probe = await probeSchemaHealth();
  if (probe.status !== "ok") {
    console.error(`[MCP] Degraded startup: ${probe.detail}`);
    if (probe.remediation) {
      console.error(`[MCP] Remediation: ${probe.remediation}`);
    }
  }
  const transport = new StdioServerTransport();

  transport.onclose = () => {
    console.error(`[MCP] STDIO transport closed`);
  };

  await server.connect(transport);
  console.error(`[MCP] Connected via stdio. ${toolCount} tools available.`);

  // Keep process alive - wait for stdin to close
  // SIGINT/SIGTERM are handled by main()'s shutdown function
  // Idle timeout: if no data arrives for 5 minutes, assume parent crashed
  // and resolve to avoid hanging forever with an open pipe.
  await new Promise<void>((resolve) => {
    const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    let idleTimer: ReturnType<typeof setTimeout>;

    const resetTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.info('Stdio idle timeout - no input for 5 minutes, shutting down');
        resolve();
      }, IDLE_TIMEOUT_MS);
    };

    process.stdin.on('data', () => {
      resetTimer();
    });

    process.stdin.on('close', () => {
      clearTimeout(idleTimer);
      resolve();
    });

    process.stdin.on('error', (error) => {
      clearTimeout(idleTimer);
      console.error(`[MCP] STDIO stdin error:`, error.message);
      resolve();
    });

    resetTimer();
  });
}

async function runHttp(server: McpServer, port: number): Promise<void> {
  console.error(`[MCP] Starting in Streamable HTTP mode on port ${port}...`);
  const startupProbe = await probeSchemaHealth();
  if (startupProbe.status !== "ok") {
    console.error(`[MCP] Degraded startup: ${startupProbe.detail}`);
    if (startupProbe.remediation) {
      console.error(`[MCP] Remediation: ${startupProbe.remediation}`);
    }
  }

  const app = express();
  app.use(express.json());

  // Store transports by session ID
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();
  const MAX_SESSIONS = 100;

  // Clean up stale sessions every 5 minutes
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, transport] of transports) {
      const lastActivity = (transport as any)._lastActivity;
      if (lastActivity && now - lastActivity > 30 * 60 * 1000) {
        console.error(`[MCP] Cleaning up stale session: ${sid}`);
        transport.close().catch(() => {});
        transports.delete(sid);
      }
    }
  }, 5 * 60 * 1000);

  // Clear interval on shutdown
  process.on('SIGTERM', () => clearInterval(cleanupInterval));
  process.on('SIGINT', () => clearInterval(cleanupInterval));

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

  // Helper to check if request is an initialization request
  function isInitializeRequest(body: any): boolean {
    return body?.method === 'initialize';
  }

  // Rate limiting for /mcp endpoint (60 requests per minute per IP)
  const mcpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });

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

  // Streamable HTTP POST endpoint
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  app.post("/mcp", mcpLimiter, async (req, res) => {
    if (!checkMcpAuth(req, res)) return;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const body = req.body;

    let transport: NodeStreamableHTTPServerTransport | undefined;
    let serverToUse: McpServer | undefined;

    // Validate session ID format before using as Map key
    if (sessionId && !UUID_REGEX.test(sessionId)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Invalid session ID format' },
        id: body?.id || null
      });
      return;
    }

    // Check if we have an existing transport for this session
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
      serverToUse = server;
    }

    // If no existing transport, create new one (only for initialize requests)
    if (!transport) {
      if (!isInitializeRequest(body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID and not an initialize request' },
          id: body?.id || null
        });
        return;
      }

      // Cap session count to prevent resource exhaustion
      if (transports.size >= MAX_SESSIONS) {
        console.error(`[MCP] Session limit reached (${MAX_SESSIONS}). Rejecting new session.`);
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Service Unavailable: Maximum session limit reached' },
          id: body?.id || null
        });
        return;
      }

      // Create NEW server instance for this session (required - can't reuse)
      const { server: newServer } = createSquishServer();
      serverToUse = newServer;

      // Create new transport with JSON response mode
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId: string) => {
          console.error(`[MCP] Session initialized: ${newSessionId}`);
          transports.set(newSessionId, transport!);
        }
      });

      // Connect the NEW session-specific server to this transport
      try {
        await serverToUse.connect(transport);
      } catch (connectError: any) {
        // Ignore "Already connected" errors - can happen if server was used before
        if (connectError.message?.includes('Already connected')) {
          console.error(`[MCP] Server already connected, creating fresh server...`);
          const { server: freshServer } = createSquishServer();
          serverToUse = freshServer;
          await serverToUse.connect(transport);
        } else {
          console.error(`[MCP] Connect error:`, connectError.message);
        }
      }

      // Set up onclose handler
      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid) {
          console.error(`[MCP] Session closed: ${sid}`);
          transports.delete(sid);
        }
      };

      transport.onerror = (error) => {
        console.error(`[MCP] Transport error:`, error);
      };
    }

    try {
      // Handle the request with the parsed body
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error(`[MCP] Error handling request:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // Streamable HTTP GET endpoint (for SSE)
  app.get("/mcp", mcpLimiter, async (req, res) => {
    if (!checkMcpAuth(req, res)) return;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !UUID_REGEX.test(sessionId) || !transports.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    const transport = transports.get(sessionId)!;

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(`[MCP] Error handling GET request:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // DELETE endpoint to close session
  app.delete("/mcp", mcpLimiter, async (req, res) => {
    if (!checkMcpAuth(req, res)) return;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !UUID_REGEX.test(sessionId) || !transports.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    const transport = transports.get(sessionId)!;

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(`[MCP] Error handling DELETE request:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
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
      await runStdio(SQUISH_SERVER, SQUISH_TOOL_COUNT);
    } else {
      await runHttp(SQUISH_SERVER, port);
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
