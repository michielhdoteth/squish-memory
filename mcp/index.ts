#!/usr/bin/env node

// Load .env file for config
import dotenv from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
// ESM-safe __dirname: bun shims it, node/tsx does not
const esmDirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(esmDirname, '../.env'), quiet: true });
import { createMcpHandler, McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import express from "express";
import { timingSafeEqual } from "crypto";
import rateLimit from "express-rate-limit";
// Zod v4 classic schemas satisfy the v2 SDK's Standard Schema contract
// (v2 requires zod >=4.2; the v1 zod/v3 compat subpath is no longer supported)
import { z } from "zod";
import { config, detectProjectScope } from "../config.js";
import { ensureProjectScope } from "../core/projects.js";
import {
  isSchemaDriftError,
  probeSchemaHealth,
  type SchemaProbeResult,
  SquishRuntime,
} from "../core/runtime/squish-runtime.js";
// Tool-call tracing (in-memory ring buffer)
import { traceToolCall } from "./tracing.js";
import { isStrictTrustPolicy, resolveTrustedCallerId } from "../core/acl/trust-policy.js";
import { getRequestPrincipal, withRequestPrincipal } from "../core/acl/request-principal.js";
import { writeTrustAudit } from "../core/acl/trust-audit.js";
import { isStrictMcpRouteEnabled, isStrictMcpToolEnabled } from "./strict-tool-policy.js";
import { SERVER_VERSION } from "./tools/shared.js";
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

// These tools expose or mutate specialized stores without yet threading the
// strict caller, ACL, and provenance contract through every code path.
// Shown to agents at connection time (MCP initialize response).
// Harness-agnostic: this server is universal pluggable memory.
const SERVER_INSTRUCTIONS = `Squish is the shared persistent memory database for connected agents and harnesses. Memories may be global or project-scoped. Use squish_remember({global:true}) for durable context that should be shared across projects and agents. Default writes are project-scoped; use them for project-specific details. Project-scoped recall includes global memories plus that project's memories, while memories from other projects stay isolated.

Recall on demand when prior context could change your answer. Use squish_recall with a topic query; the active project is applied automatically, and global memories are included. Save durable cross-project preferences, operating context, decisions, and lessons without a project; save repository-specific details in that project's scope. Use squish_sessions to review prior agent sessions, and squish_skill only for explicitly managed procedures. Squish does not infer or activate procedures from accumulated memories. Use squish_forget carefully: single deletes are immediate; bulk deletes are dry-run only until you pass confirm=true.`;

// Reference to the HTTP server (when running in http mode) so shutdown can close it
let httpServerRef: import('node:http').Server | null = null;

// Create shared SDK client — wraps core storage/embeddings for clean API access
const sdkClient = new SquishRuntime();

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

/**
 * Read an explicit project reference out of a tool's input.
 * Tool schemas spell the field either `project` or `projectId`. The truthiness
 * rule mirrors resolveProjectPath exactly so the scope registered here is the
 * scope the handler will hand to search().
 */
function extractProjectArg(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["project", "projectId"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Read only the optional caller assertion; target user IDs are not actors. */
function extractRequestedCallerId(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>).user;
  return typeof value === "string" ? value : undefined;
}

/**
 * Register the scope this tool call will read and write under, BEFORE the
 * handler runs. Read paths call requireProject(), which throws
 * ProjectNotFoundError for a path that has no `projects` row yet, while write
 * paths self-heal. Without this, recall and bulk forget failed on every call in
 * a working directory that had never been written to.
 *
 * Never fails the tool: a registration error is logged and the handler still
 * runs, so this adds no new failure mode.
 */
async function ensureToolProjectScope(name: string, input: unknown): Promise<void> {
  if (name === 'squish_sessions' && input && typeof input === 'object'
    && (input as { action?: unknown }).action === 'capture') return;
  const projectArg = extractProjectArg(input);
  try {
    await ensureProjectScope(projectArg);
  } catch (error) {
    console.error(`[MCP] Could not register project scope ${projectArg ?? "(auto-detected)"}:`, error);
  }
}

function safeRegisterTool(
  server: McpServer,
  name: string,
  definition: any,
  handler: any
): boolean {
  try {
    server.registerTool(name, definition, async (input: any, context: ServerContext): Promise<any> => {
      return withRequestPrincipal(context.http?.authInfo?.clientId, async () => {
      if (isStrictTrustPolicy() && !isStrictMcpToolEnabled(name)) {
        try {
          await writeTrustAudit({
            actorId: getRequestPrincipal() ?? process.env.SQUISH_TRUSTED_CALLER_ID ?? 'unbound',
            resourceId: name,
            assetType: 'tool',
            decision: 'deny',
            reason: 'strict_surface',
          });
        } catch {
          console.error(`[MCP] Could not persist strict denial audit for ${name}`);
        }
        return errorResponse(
          "strict_surface_unavailable",
          `${name} is withheld under strict trust until its caller identity, ACL, and provenance gates are verified.`,
        );
      }

      if (isStrictTrustPolicy() && !isStrictMcpRouteEnabled(name, input)) {
        const route = input && typeof input === 'object' && typeof input.action === 'string'
          ? input.action
          : 'default';
        const selector = input && typeof input === 'object' && typeof input.targetType === 'string'
          ? `:${input.targetType}`
          : input && typeof input === 'object' && typeof input.assetType === 'string'
            ? `:${input.assetType}`
            : '';
        try {
          await writeTrustAudit({
            actorId: getRequestPrincipal() ?? process.env.SQUISH_TRUSTED_CALLER_ID ?? 'unbound',
            resourceId: `${name}:${route}${selector}`,
            assetType: 'tool',
            decision: 'deny',
            reason: 'strict_route',
          });
        } catch {
          console.error(`[MCP] Could not persist strict route denial audit for ${name}`);
        }
        return errorResponse(
          'strict_route_unavailable',
          `${name} action is withheld under strict trust until its route contract is reviewed.`,
        );
      }

      if (isStrictTrustPolicy()) {
        try {
          // Bind or validate identity before schema probing and project-scope
          // registration. Both touch persistent storage, and a forged caller
          // must not cause side effects before the route rejects it.
          resolveTrustedCallerId(extractRequestedCallerId(input));
        } catch (error) {
          try {
            await writeTrustAudit({
              actorId: getRequestPrincipal() ?? process.env.SQUISH_TRUSTED_CALLER_ID ?? 'unbound',
              resourceId: name,
              assetType: 'tool',
              decision: 'deny',
              reason: 'caller_mismatch',
            });
          } catch {
            console.error(`[MCP] Could not persist strict caller denial audit for ${name}`);
          }
          return errorResponse(
            'trust_denied',
            `${name} requires an authenticated caller matching the server-bound principal.`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      const probe = await probeSchemaHealth();
      if (probe.status !== "ok") {
        return schemaProbeErrorResult(probe);
      }

      await ensureToolProjectScope(name, input);

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

        console.error(`[MCP] Tool ${name} failed:`, error);
        throw error;
      }
      });
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

  const serving = serveStdio(() => {
    const { server } = createSquishServer();
    return server;
  }, { legacy: 'serve' });

  // Start scheduled maintenance only after the stdio transport is listening.
  // Scheduler catch-up may scan a large local memory store, so it must not
  // hold the MCP initialize handshake open while that work runs.
  void sdkClient.initializeScheduler()
    .then(() => console.error(`[${SERVER_NAME}] Cron scheduler initialized`))
    .catch((error) => {
      console.error(`[${SERVER_NAME}] Warning: Failed to initialize scheduler:`, error);
    });
  await serving;
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
  const MCP_API_KEYS_JSON = process.env.SQUISH_MCP_API_KEYS_JSON || '';
  let apiKeysByPrincipal: Record<string, string> = {};
  if (MCP_API_KEYS_JSON) {
    try {
      const parsed: unknown = JSON.parse(MCP_API_KEYS_JSON);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object mapping API keys to principal IDs');
      apiKeysByPrincipal = Object.fromEntries(Object.entries(parsed).map(([token, principal]) => {
        if (!token || typeof principal !== 'string' || !principal.trim()) throw new Error('each API key must map to a non-empty principal ID');
        return [token, principal.trim()];
      }));
    } catch (error) {
      console.error(`[MCP] FATAL: Invalid SQUISH_MCP_API_KEYS_JSON: ${error instanceof Error ? error.message : 'invalid value'}`);
      process.exit(1);
    }
  }
  if (!MCP_API_KEY && Object.keys(apiKeysByPrincipal).length === 0) {
    console.error(`[MCP] FATAL: HTTP mode requires SQUISH_MCP_API_KEY or SQUISH_MCP_API_KEYS_JSON. Refusing to start without authentication.`);
    process.exit(1);
  }
  function checkMcpAuth(req: express.Request, res: express.Response): string | null {
    const provided = req.headers['x-api-key'] as string || req.headers['authorization']?.replace('Bearer ', '') || '';
    let principalId: string | null = null;
    if (Object.keys(apiKeysByPrincipal).length > 0) {
      for (const [token, principal] of Object.entries(apiKeysByPrincipal)) {
        const matches = provided.length === token.length && provided.length > 0
          && timingSafeEqual(Buffer.from(provided), Buffer.from(token));
        if (matches) principalId = principal;
      }
    } else {
      const matches = provided.length === MCP_API_KEY.length && provided.length > 0
        && timingSafeEqual(Buffer.from(provided), Buffer.from(MCP_API_KEY));
      if (matches) principalId = process.env.SQUISH_TRUSTED_CALLER_ID?.trim() || 'single-key-client';
    }
    if (!principalId) {
      res.status(401).json({ error: 'Unauthorized. Set SQUISH_MCP_API_KEY or provide x-api-key header.' });
      return null;
    }
    (req as express.Request & { auth?: { token: string; clientId: string; scopes: string[] } }).auth = {
      token: provided,
      clientId: principalId,
      scopes: [],
    };
    return principalId;
  }

  // Health check endpoint
  app.get("/health", (req, res) => {
    void probeSchemaHealth().then((probe) => {
      res.json({
        status: probe.status === "ok" ? "ok" : (probe.status === "drifted" ? "degraded" : "broken"),
        server: SERVER_NAME,
        version: SERVER_VERSION,
      });
    }).catch(() => {
      res.status(500).json({
        status: "broken",
        server: SERVER_NAME,
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

      // Release the local model session before exiting. In WebGPU mode the
      // transformer runtime owns GPU resources that process.exit would skip.
      try {
        await sdkClient.close();
        console.error(`[${SERVER_NAME}] Embedding provider closed`);
      } catch (error) {
        console.error(`[${SERVER_NAME}] Error closing embedding provider:`, error);
      }

      // Close DB connections cleanly
      try {
        const { closeAllDbs } = await import("../db/index.js");
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
      // HTTP mode has no stdio initialize handshake to protect. Keep its
      // existing startup ordering and report scheduler failures gracefully.
      try {
        await sdkClient.initializeScheduler();
        console.error(`[${SERVER_NAME}] Cron scheduler initialized`);
      } catch (error) {
        console.error(`[${SERVER_NAME}] Warning: Failed to initialize scheduler:`, error);
      }
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
