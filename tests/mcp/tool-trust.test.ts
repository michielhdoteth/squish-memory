/**
 * Tool trust regressions (Batch 1):
 *
 * - Automatic skill extraction is not exposed; Squish stores and recalls
 *   evidence-linked memories instead of promoting inferred SOPs.
 * - squish_forget bulk delete is dry-run only until confirm=true is passed;
 *   confirm=true must execute the destructive delete.
 * - The server advertises an `instructions` field at initialize time.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { verifyMemoryProvenance } from '../../core/acl/provenance.js';
import {
  isStrictMcpRouteEnabled,
  isStrictMcpToolEnabled,
  STRICT_REVIEWED_MCP_ACTIONS,
  STRICT_REVIEWED_MCP_TOOLS,
  STRICT_REVIEWED_MCP_NO_ACTION_ROUTES,
  STRICT_WITHHELD_MCP_ACTIONS,
  STRICT_WITHHELD_MCP_TOOLS,
  STRICT_WITHHELD_MCP_NO_ACTION_ROUTES,
} from '../../mcp/strict-tool-policy.js';

const TEST_TIMEOUT = 90_000;
const strictProvenanceKeys = generateKeyPairSync('ed25519');

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

async function spawnServer(tmpDir: string, trustPolicy?: "strict", enableMaintenanceTools = false): Promise<ServerHandle> {
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
  // Trust regressions exercise authorization and provenance, not embedding quality.
  // Prevent the MCP child from loading the default bundled model during tests.
  childEnv.SQUISH_EMBEDDINGS_PROVIDER = "none";
  if (enableMaintenanceTools) childEnv.SQUISH_ENABLE_MAINTENANCE_TOOLS = "true";
  if (trustPolicy) childEnv.SQUISH_TRUST_POLICY = trustPolicy;
  if (trustPolicy === 'strict') {
    childEnv.SQUISH_TRUSTED_CALLER_ID = 'strict-test-user';
    childEnv.SQUISH_PROVENANCE_PRIVATE_KEY = strictProvenanceKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    childEnv.SQUISH_PROVENANCE_KEY_ID = 'strict-test-key';
    childEnv.SQUISH_PROVENANCE_PUBLIC_KEY = strictProvenanceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

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

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  minLength?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

function sampleForSchema(schema: JsonSchema): unknown {
  if (Object.hasOwn(schema, 'default')) return schema.default;
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.anyOf?.length) return sampleForSchema(schema.anyOf[0]);
  if (schema.oneOf?.length) return sampleForSchema(schema.oneOf[0]);
  if (schema.type === 'object' || schema.properties) {
    const result: Record<string, unknown> = {};
    for (const key of schema.required ?? []) {
      const property = schema.properties?.[key];
      if (property) result[key] = sampleForSchema(property);
    }
    return result;
  }
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1;
  if (schema.type === 'string') return 'strict-route-probe'.padEnd(schema.minLength ?? 0, 'x');
  return 'strict-route-probe';
}

describe("Tool trust (Batch 1)", () => {
  it(
    "does not register automatic skill extraction",
    async () => {
      const id = sharedServer.nextId();
      sharedServer.send({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
      const response = await sharedServer.readLine((r: any) => r.id === id, TEST_TIMEOUT);
      const names = (response.result.tools as Array<{ name: string }>).map((tool) => tool.name);
      expect(names).not.toContain("squish_extract");
      expect(names).toContain("squish_remember");
    },
    TEST_TIMEOUT
  );

  it(
    "fails closed for raw external session history under strict trust",
    async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "squish-strict-session-"));
      let server: ServerHandle | undefined;
      try {
        server = await spawnServer(tmpDir, "strict", true);
        const id = server.nextId();
        server.send({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-strict-session", version: "1.0.0" },
          },
        });
        await server.readLine((r: any) => r.id === id, TEST_TIMEOUT);
        server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

        const registryId = server.nextId();
        server.send({ jsonrpc: "2.0", id: registryId, method: "tools/list", params: {} });
        const registry = await server.readLine((r: any) => r.id === registryId, TEST_TIMEOUT);
        const registeredNames = (registry.result.tools as Array<{ name: string }>).map((tool) => tool.name);
        const classifiedNames = new Set([...STRICT_REVIEWED_MCP_TOOLS, ...STRICT_WITHHELD_MCP_TOOLS]);
        expect([...classifiedNames].sort()).toEqual([...registeredNames].sort());
        expect(isStrictMcpToolEnabled('squish_future_unreviewed')).toBe(false);
        const toolsByName = new Map((registry.result.tools as Array<{ name: string; inputSchema: JsonSchema }>).map((tool) => [tool.name, tool]));
        for (const tool of registry.result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, { enum?: string[] }> } }>) {
          const actionValues = tool.inputSchema.properties?.action?.enum;
          if (actionValues) {
            const classifiedActions = new Set([
              ...(STRICT_REVIEWED_MCP_ACTIONS.get(tool.name) ?? []),
              ...(STRICT_WITHHELD_MCP_ACTIONS.get(tool.name) ?? []),
            ]);
            expect([...classifiedActions].sort()).toEqual([...actionValues].sort());
          } else {
            expect(STRICT_REVIEWED_MCP_NO_ACTION_ROUTES.has(tool.name) || STRICT_WITHHELD_MCP_NO_ACTION_ROUTES.has(tool.name)).toBe(true);
          }
        }
        expect(isStrictMcpRouteEnabled('squish_team', { action: 'create' })).toBe(true);
        expect(isStrictMcpRouteEnabled('squish_team', { action: 'future_action' })).toBe(false);
        expect(isStrictMcpRouteEnabled('squish_sessions', { action: 'recover' })).toBe(true);
        expect(isStrictMcpRouteEnabled('squish_sessions', { action: 'search' })).toBe(false);
        expect(isStrictMcpRouteEnabled('squish_edits', { action: 'history' })).toBe(true);
        expect(isStrictMcpRouteEnabled('squish_edits', { action: 'approve' })).toBe(false);
        expect(isStrictMcpRouteEnabled('squish_feedback', { targetType: 'memory' })).toBe(true);
        expect(isStrictMcpRouteEnabled('squish_feedback', { targetType: 'belief' })).toBe(false);
        expect(isStrictMcpRouteEnabled('squish_context', { listProjects: true })).toBe(false);
        expect(isStrictMcpRouteEnabled('squish_loadout', { action: 'remove_loadout', assetType: 'skill' })).toBe(false);
        expect(isStrictMcpRouteEnabled('squish_loadout', { action: 'remove_loadout', assetType: 'memory' })).toBe(true);

        const unauthenticated = parseToolResult(await server.callTool("squish_sessions", { action: "list" }, TEST_TIMEOUT));
        expect(unauthenticated.error).toBe("strict_route_unavailable");

        const spoofedCalls: Array<[string, Record<string, unknown>]> = [
          ['squish_recall', {
            query: 'must be rejected before storage access',
            project: join(tmpDir, 'strict-mismatched-recall-project'),
            user: 'untrusted-requested-caller',
          }],
          ['squish_context', {
            project: join(tmpDir, 'strict-mismatched-context-project'),
            user: 'untrusted-requested-caller',
          }],
          ['squish_places', {
            action: 'get', placeId: 'wip',
            project: join(tmpDir, 'strict-mismatched-places-project'),
            user: 'untrusted-requested-caller',
          }],
          ['squish_sessions', {
            action: 'recover', sessionId: 'untrusted-session',
            project: join(tmpDir, 'strict-mismatched-session-project'),
            user: 'untrusted-requested-caller',
          }],
          ['squish_forget', {
            memoryId: 'untrusted-memory-id',
            user: 'untrusted-requested-caller',
          }],
        ];
        const projectDb = new Database(join(tmpDir, 'squish.db'));
        const projectsBeforeSpoofedCall = (projectDb.query('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count;
        projectDb.close();
        for (const [toolName, args] of spoofedCalls) {
          const denied = parseToolResult(await server.callTool(toolName, args, TEST_TIMEOUT));
          expect(denied.error).toBe('trust_denied');
        }
        const verifyProjectDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const projectsAfterSpoofedCall = (verifyProjectDb.query('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count;
          expect(projectsAfterSpoofedCall).toBe(projectsBeforeSpoofedCall);
          const callerDenials = verifyProjectDb.query(
            "SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log WHERE asset_type = 'tool' AND reason = 'caller_mismatch'",
          ).all() as Array<{ actor_hash: string; resource_hash: string; decision: string; reason: string }>;
          const denialResources = new Set(callerDenials.map((entry) => entry.resource_hash));
          expect(denialResources).toEqual(new Set(spoofedCalls.map(([toolName]) => createHash('sha256').update(toolName).digest('hex'))));
          expect(callerDenials.every((entry) =>
            entry.actor_hash === createHash('sha256').update('strict-test-user').digest('hex') &&
            entry.decision === 'deny' && entry.reason === 'caller_mismatch'
          )).toBe(true);
        } finally {
          verifyProjectDb.close();
        }

        const authenticated = parseToolResult(await server.callTool(
          "squish_sessions",
          { action: "search", query: "prior session", user: "strict-test-user" },
          TEST_TIMEOUT,
        ));
        expect(authenticated.error).toBe("strict_route_unavailable");

        const withheldRoutes = [
          ...[...STRICT_WITHHELD_MCP_ACTIONS.entries()]
            .filter(([name]) => isStrictMcpToolEnabled(name))
            .flatMap(([name, actions]) => [...actions].map((action) => ({ name, action }))),
          { name: 'squish_feedback', selector: 'belief' },
          { name: 'squish_loadout', action: 'remove_loadout', selector: 'skill' },
          { name: 'squish_loadout', action: 'remove_loadout', selector: 'strategy' },
          { name: 'squish_context', selector: 'listProjects' },
        ];
        const projectsBeforeRouteDenialsDb = new Database(join(tmpDir, 'squish.db'));
        const projectsBeforeRouteDenials = (projectsBeforeRouteDenialsDb.query(
          'SELECT COUNT(*) AS count FROM projects',
        ).get() as { count: number }).count;
        projectsBeforeRouteDenialsDb.close();
        const routeAuditStartDb = new Database(join(tmpDir, 'squish.db'));
        const routeAuditStart = (routeAuditStartDb.query(
          "SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'tool' AND reason = 'strict_route'",
        ).get() as { count: number }).count;
        routeAuditStartDb.close();
        const expectedRouteResources: string[] = [];
        for (const route of withheldRoutes) {
          const tool = toolsByName.get(route.name);
          expect(tool).toBeDefined();
          const args = sampleForSchema(tool!.inputSchema) as Record<string, unknown>;
          if (route.action) args.action = route.action;
          if (route.selector === 'belief' || route.selector === 'skill' || route.selector === 'strategy') {
            if (route.name === 'squish_feedback') args.targetType = route.selector;
            else args.assetType = route.selector;
          }
          if (route.selector === 'listProjects') args.listProjects = true;
          const routeName = typeof args.action === 'string' ? args.action : 'default';
          const selector = typeof args.targetType === 'string'
            ? `:${args.targetType}`
            : typeof args.assetType === 'string' ? `:${args.assetType}` : '';
          expectedRouteResources.push(createHash('sha256').update(`${route.name}:${routeName}${selector}`).digest('hex'));
          const denied = parseToolResult(await server.callTool(route.name, args, TEST_TIMEOUT));
          expect(denied.error).toBe('strict_route_unavailable');
        }
        const routeDenialDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const projectsAfterRouteDenials = (routeDenialDb.query(
            'SELECT COUNT(*) AS count FROM projects',
          ).get() as { count: number }).count;
          expect(projectsAfterRouteDenials).toBe(projectsBeforeRouteDenials);
          const routeAudits = routeDenialDb.query(
            "SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log WHERE asset_type = 'tool' AND reason = 'strict_route' ORDER BY rowid",
          ).all() as Array<{ actor_hash: string; resource_hash: string; decision: string; reason: string }>;
          const newRouteAudits = routeAudits.slice(routeAuditStart);
          expect(newRouteAudits.map((entry) => entry.resource_hash)).toEqual(expectedRouteResources);
          expect(newRouteAudits.every((entry) =>
            entry.actor_hash === createHash('sha256').update('strict-test-user').digest('hex') &&
            entry.decision === 'deny' && entry.reason === 'strict_route'
          )).toBe(true);
        } finally {
          routeDenialDb.close();
        }

        const unreviewedTools: Array<[string, Record<string, unknown>]> = [
          ["squish_skill", { action: "list" }],
          ["squish_link", { action: "find", memoryId: "untrusted-id" }],
          ["squish_tier", { action: "stats" }],
          ["squish_stale_report", { action: "build" }],
          ["squish_dedup", { action: "list" }],
          ["squish_maintenance", { action: "run", dryRun: true }],
        ];
        for (const [toolName, args] of unreviewedTools) {
          const result = parseToolResult(await server.callTool(toolName, args, TEST_TIMEOUT));
          expect(result.error).toBe("strict_surface_unavailable");
        }
        const strictSurfaceAudit = new Database(join(tmpDir, 'squish.db'));
        try {
          const audits = strictSurfaceAudit.query("SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log WHERE asset_type = 'tool' AND reason = 'strict_surface'").all() as Array<{ actor_hash: string; resource_hash: string; decision: string; reason: string }>;
          expect(audits).toHaveLength(unreviewedTools.length);
          expect(audits).toContainEqual({
            actor_hash: createHash('sha256').update('strict-test-user').digest('hex'),
            resource_hash: createHash('sha256').update('squish_skill').digest('hex'),
            decision: 'deny',
            reason: 'strict_surface',
          });
        } finally {
          strictSurfaceAudit.close();
        }
        const withheldEditList = parseToolResult(await server.callTool("squish_edits", { action: "list" }, TEST_TIMEOUT));
        expect(withheldEditList.error).toBe("strict_route_unavailable");
        const withheldEditProposal = parseToolResult(await server.callTool("squish_edits", {
          action: "propose", memoryId: "untrusted-id", proposedContent: "untrusted", reason: "test",
        }, TEST_TIMEOUT));
        expect(withheldEditProposal.error).toBe("strict_route_unavailable");

        const forgedLoadoutRead = parseToolResult(await server.callTool('squish_loadout', {
          action: 'get_loadout', agentId: 'other-agent',
        }, TEST_TIMEOUT));
        expect(forgedLoadoutRead.error).toBe('strict_loadout_denied');
        const callerAuthoredAcl = parseToolResult(await server.callTool('squish_loadout', {
          action: 'set_visibility', assetType: 'memory', assetId: 'untrusted-id',
          ruleType: 'everyone', granteeType: 'everyone', granteeId: '*', permission: 'read',
        }, TEST_TIMEOUT));
        expect(callerAuthoredAcl.error).toBe('strict_route_unavailable');
        const nonMemoryLoadoutRemoval = parseToolResult(await server.callTool('squish_loadout', {
          action: 'remove_loadout', agentId: 'strict-test-user', assetType: 'skill', assetId: 'untrusted-skill',
        }, TEST_TIMEOUT));
        expect(nonMemoryLoadoutRemoval.error).toBe('strict_route_unavailable');
        const unauthorizedCompile = parseToolResult(await server.callTool('squish_compile', {
          action: 'stats', teamId: 'untrusted-team',
        }, TEST_TIMEOUT));
        expect(unauthorizedCompile.error).toBe('team_denied');

        const createdTeam = parseToolResult(await server.callTool(
          'squish_team', { action: 'create', name: 'Strict Team' }, TEST_TIMEOUT,
        ));
        expect(createdTeam.ok).toBe(true);
        expect(typeof createdTeam.team.id).toBe('string');

        const remembered = parseToolResult(await server.callTool('squish_remember', {
          content: 'Strict owner memory may be loaded by its authenticated agent.',
          type: 'fact',
        }, TEST_TIMEOUT));
        expect(remembered.ok).toBe(true);

        const recoverySessionId = 'strict-recovery-poison-test';
        const recoveryMemory = parseToolResult(await server.callTool('squish_remember', {
          content: 'Strict recovery evidence contains the verified deployment decision.',
          type: 'fact',
          tags: [`squish_session:${recoverySessionId}`, 'private'],
        }, TEST_TIMEOUT));
        expect(recoveryMemory.ok).toBe(true);
        const neighboringRecoveryMemory = parseToolResult(await server.callTool('squish_remember', {
          content: 'Neighboring session evidence must not cross the exact session boundary.',
          type: 'fact',
          tags: [`squish_session:${recoverySessionId}-neighbor`, 'private'],
        }, TEST_TIMEOUT));
        expect(neighboringRecoveryMemory.ok).toBe(true);
        const validRecovery = parseToolResult(await server.callTool('squish_sessions', {
          action: 'recover', sessionId: recoverySessionId, query: 'weather station in the desert', user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(validRecovery.evidence?.map((entry: { id: string }) => entry.id)).toEqual([recoveryMemory.id]);
        const recoveryPoisonDb = new Database(join(tmpDir, 'squish.db'));
        try {
          recoveryPoisonDb.query('UPDATE memories SET content = ? WHERE id = ?')
            .run('TAMPERED strict recovery evidence must stay hidden', recoveryMemory.id);
        } finally {
          recoveryPoisonDb.close();
        }
        const poisonedRecovery = parseToolResult(await server.callTool('squish_sessions', {
          action: 'recover', sessionId: recoverySessionId, query: 'weather station in the desert', user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(JSON.stringify(poisonedRecovery)).not.toContain('TAMPERED strict recovery evidence');
        const restoreRecoveryDb = new Database(join(tmpDir, 'squish.db'));
        try {
          restoreRecoveryDb.query('UPDATE memories SET content = ? WHERE id = ?')
            .run('Strict recovery evidence contains the verified deployment decision.', recoveryMemory.id);
        } finally {
          restoreRecoveryDb.close();
        }

        const hiddenPlaceMemoryIds = Array.from(
          { length: 26 },
          (_, index) => `strict-unowned-place-memory-${index + 1}`,
        );
        const placeDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const insertHiddenMemory = placeDb.query("INSERT INTO memories (id, type, content) VALUES (?, 'fact', ?)");
          for (const id of hiddenPlaceMemoryIds) {
            insertHiddenMemory.run(id, 'This unowned place memory must remain private.');
          }
          const now = Date.now();
          const insertPlaceEdge = placeDb.query(`INSERT INTO knowledge_edges
            (id, from_id, from_kind, to_id, to_kind, edge_type, valid_from, recorded_at, created_at)
            VALUES (?, ?, 'knowledge', 'wip', 'place', 'placed_in', ?, ?, ?)`);
          insertPlaceEdge.run('strict-owner-place-edge', remembered.id, now, now, Math.floor(now / 1000));
          hiddenPlaceMemoryIds.forEach((id, index) => {
            insertPlaceEdge.run(`strict-hidden-place-edge-${index}`, id, now, now, Math.floor(now / 1000) + index + 1);
          });
        } finally {
          placeDb.close();
        }
        const strictPlaceRead = parseToolResult(await server.callTool('squish_places', {
          action: 'get', placeId: 'wip', limit: 1, user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(strictPlaceRead).not.toHaveProperty('memories');
        expect(JSON.stringify(strictPlaceRead)).not.toContain(remembered.id);
        for (const id of hiddenPlaceMemoryIds) expect(JSON.stringify(strictPlaceRead)).not.toContain(id);

        const lessonShaped = parseToolResult(await server.callTool('squish_remember', {
          content: 'Strict failure lesson: the parser failed because an unsigned learning row cannot be trusted.',
        }, TEST_TIMEOUT));
        expect(lessonShaped.ok).toBe(true);
        const strictDbCheck = new Database(join(tmpDir, 'squish.db'));
        try {
          const lessonRow = strictDbCheck.query('SELECT user_id, type, metadata FROM memories WHERE id = ?').get(lessonShaped.id) as { user_id: string; type: string; metadata: string };
          expect(lessonRow.user_id).toBeTruthy();
          expect(lessonRow.type).toBe('context');
          expect(JSON.parse(lessonRow.metadata).__squishProvenance?.version).toBe(3);
          const learningRow = strictDbCheck.query('SELECT COUNT(*) AS count FROM learnings').get() as { count: number };
          expect(learningRow.count).toBe(0);
        } finally {
          strictDbCheck.close();
        }

        const ownerIdRead = parseToolResult(await server.callTool('squish_recall', {
          query: remembered.id, user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(ownerIdRead.memories?.[0]?.content).toBe('Strict owner memory may be loaded by its authenticated agent.');

        const ownerCorrection = parseToolResult(await server.callTool('squish_edits', {
          action: 'correct', memoryId: remembered.id,
          proposedContent: 'Strict owner memory was corrected by its authenticated agent.',
          reason: 'Correct a verified private memory through the strict owner path.',
        }, TEST_TIMEOUT));
        expect(ownerCorrection.ok).toBe(true);
        expect(ownerCorrection.snapshotId).toBeTruthy();
        const correctedOwnerRead = parseToolResult(await server.callTool('squish_recall', {
          query: remembered.id, user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(correctedOwnerRead.memories?.[0]?.content).toBe('Strict owner memory was corrected by its authenticated agent.');
        const ownerCorrectionHistory = parseToolResult(await server.callTool('squish_edits', {
          action: 'history', memoryId: remembered.id,
        }, TEST_TIMEOUT));
        expect(ownerCorrectionHistory).toHaveProperty('entries');
        expect(ownerCorrectionHistory.complete).toBe(true);
        expect(ownerCorrectionHistory.entries).toHaveLength(1);
        expect(ownerCorrectionHistory.entries[0]).toMatchObject({
          priorContent: 'Strict owner memory may be loaded by its authenticated agent.',
          correctedContent: 'Strict owner memory was corrected by its authenticated agent.',
          reason: 'Correct a verified private memory through the strict owner path.',
        });

        const correctionHistoryPoisonDb = new Database(join(tmpDir, 'squish.db'));
        let correctionSnapshot!: { id: string; content: string };
        try {
          correctionSnapshot = correctionHistoryPoisonDb.query(`SELECT id, content FROM memory_snapshots
            WHERE memory_id = ? AND snapshot_type = 'correction' ORDER BY created_at ASC LIMIT 1`)
            .get(remembered.id) as { id: string; content: string };
          correctionHistoryPoisonDb.query('UPDATE memory_snapshots SET content = ? WHERE id = ?')
            .run('TAMPERED strict correction history must stay hidden', correctionSnapshot.id);
        } finally {
          correctionHistoryPoisonDb.close();
        }
        const poisonedCorrectionHistory = parseToolResult(await server.callTool('squish_edits', {
          action: 'history', memoryId: remembered.id,
        }, TEST_TIMEOUT));
        expect(poisonedCorrectionHistory.error).toBe('edit_error');
        expect(JSON.stringify(poisonedCorrectionHistory)).not.toContain('TAMPERED strict correction history');
        const restoreCorrectionSnapshot = new Database(join(tmpDir, 'squish.db'));
        try {
          restoreCorrectionSnapshot.query('UPDATE memory_snapshots SET content = ? WHERE id = ?')
            .run(correctionSnapshot.content, correctionSnapshot.id);
        } finally {
          restoreCorrectionSnapshot.close();
        }

        const correctionSourcePoisonDb = new Database(join(tmpDir, 'squish.db'));
        try {
          correctionSourcePoisonDb.query('UPDATE memories SET content = ? WHERE id = ?')
            .run('TAMPERED correction source must not be re-signed', remembered.id);
        } finally {
          correctionSourcePoisonDb.close();
        }
        const poisonedCorrection = parseToolResult(await server.callTool('squish_edits', {
          action: 'correct', memoryId: remembered.id,
          proposedContent: 'Untrusted replacement must not be signed.',
          reason: 'Attempt correction after source tampering.',
        }, TEST_TIMEOUT));
        expect(poisonedCorrection.ok).not.toBe(true);
        expect(JSON.stringify(poisonedCorrection)).not.toContain('Untrusted replacement must not be signed.');
        const restoreCorrectionSourceDb = new Database(join(tmpDir, 'squish.db'));
        try {
          restoreCorrectionSourceDb.query('UPDATE memories SET content = ? WHERE id = ?')
            .run('Strict owner memory was corrected by its authenticated agent.', remembered.id);
          const correctionSnapshots = restoreCorrectionSourceDb.query(
            "SELECT COUNT(*) AS count FROM memory_snapshots WHERE memory_id = ? AND snapshot_type = 'correction'",
          ).get(remembered.id) as { count: number };
          expect(correctionSnapshots.count).toBe(1);
        } finally {
          restoreCorrectionSourceDb.close();
        }

        const placePoisonDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const now = Date.now();
          placePoisonDb.query(`INSERT INTO places (id, project_id, name, place_type)
            SELECT 'strict-test-archive-place', project_id, 'Archive', 'archive'
            FROM memories WHERE id = ?
            AND NOT EXISTS (SELECT 1 FROM places WHERE place_type = 'archive')`).run(remembered.id);
          const archivePlace = placePoisonDb.query("SELECT id FROM places WHERE place_type = 'archive' LIMIT 1")
            .get() as { id: string } | undefined;
          expect(archivePlace).toBeTruthy();
          placePoisonDb.query(`INSERT INTO knowledge_edges
            (id, from_id, from_kind, to_id, to_kind, edge_type, valid_from, recorded_at)
            VALUES ('strict-poisoned-place-context', ?, 'knowledge', ?, 'place', 'placed_in', ?, ?)`)
            .run(remembered.id, archivePlace!.id, now, now);
        } finally {
          placePoisonDb.close();
        }
        const placePoisonedContext = parseToolResult(await server.callTool('squish_context', {
          user: 'strict-test-user', limit: 50,
        }, TEST_TIMEOUT));
        expect(JSON.stringify(placePoisonedContext)).toContain('Strict owner memory was corrected by its authenticated agent.');
        expect(JSON.stringify(placePoisonedContext)).not.toContain('Archive');
        const strictBootstrap = parseToolResult(await server.callTool('squish_context', {
          action: 'session-start', user: 'strict-test-user', limit: 10,
        }, TEST_TIMEOUT));
        expect(strictBootstrap.ok).toBe(true);
        expect(strictBootstrap.totalTokens).toBeLessThanOrEqual(strictBootstrap.ceilingTokens);
        expect(strictBootstrap.block).toContain('Strict owner memory was corrected by its authenticated agent.');
        expect(strictBootstrap.block).not.toContain('Archive');
        const forgedStrictBootstrap = parseToolResult(await server.callTool('squish_context', {
          action: 'session-start', user: 'another-agent', limit: 10,
        }, TEST_TIMEOUT));
        expect(forgedStrictBootstrap.error).toBe('trust_denied');

        const ownerFeedback = parseToolResult(await server.callTool('squish_feedback', {
          targetType: 'memory', id: remembered.id, signal: 'used',
        }, TEST_TIMEOUT));
        expect(ownerFeedback.applied).toBe(true);

        const feedbackAuditDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const event = feedbackAuditDb.query("SELECT decision, reason FROM trust_audit_log WHERE asset_type = 'memory' AND reason = 'memory_feedback_used' ORDER BY created_at DESC LIMIT 1").get() as { decision: string; reason: string };
          expect(event.decision).toBe('allow');
          expect(event.reason).toBe('memory_feedback_used');
        } finally {
          feedbackAuditDb.close();
        }

        const feedbackPoisonDb = new Database(join(tmpDir, 'squish.db'));
        try {
          feedbackPoisonDb.query('UPDATE memories SET content = ? WHERE id = ?')
            .run('TAMPERED feedback target must not be mutated', remembered.id);
        } finally {
          feedbackPoisonDb.close();
        }
        const poisonedFeedback = parseToolResult(await server.callTool('squish_feedback', {
          targetType: 'memory', id: remembered.id, signal: 'contradict',
        }, TEST_TIMEOUT));
        expect(poisonedFeedback.error).toBe('feedback_denied');
        expect(JSON.stringify(poisonedFeedback)).not.toContain('TAMPERED feedback target');
        const restoreFeedbackTargetDb = new Database(join(tmpDir, 'squish.db'));
        try {
          restoreFeedbackTargetDb.query('UPDATE memories SET content = ? WHERE id = ?')
            .run('Strict owner memory was corrected by its authenticated agent.', remembered.id);
        } finally {
          restoreFeedbackTargetDb.close();
        }
        const feedbackPoisonAuditDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const event = feedbackPoisonAuditDb.query(
            "SELECT decision, reason, resource_hash FROM trust_audit_log WHERE asset_type = 'memory' AND reason = 'invalid_signature' ORDER BY rowid DESC LIMIT 1",
          ).get() as { decision: string; reason: string; resource_hash: string };
          expect(event).toEqual({
            decision: 'deny', reason: 'invalid_signature',
            resource_hash: createHash('sha256').update(remembered.id).digest('hex'),
          });
        } finally {
          feedbackPoisonAuditDb.close();
        }

        const forgedFeedback = parseToolResult(await server.callTool('squish_feedback', {
          targetType: 'memory', id: 'another-principals-private-memory', signal: 'contradict',
        }, TEST_TIMEOUT));
        expect(forgedFeedback.error).toBe('feedback_denied');
        const unsupportedBeliefFeedback = parseToolResult(await server.callTool('squish_feedback', {
          targetType: 'belief', id: 'untrusted-belief', signal: 'contradict',
        }, TEST_TIMEOUT));
        expect(unsupportedBeliefFeedback.error).toBe('strict_route_unavailable');

        const routeAuditDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const routeAudits = routeAuditDb.query(
            "SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log WHERE asset_type = 'tool' AND reason = 'strict_route'",
          ).all() as Array<{ actor_hash: string; resource_hash: string; decision: string; reason: string }>;
          const expectedRouteHashes = [
            'squish_sessions:list', 'squish_sessions:search',
            'squish_edits:list', 'squish_edits:propose',
            'squish_loadout:set_visibility:memory',
            'squish_loadout:remove_loadout:skill', 'squish_feedback:default:belief',
          ].map((route) => createHash('sha256').update(route).digest('hex'));
          const observedRouteHashes = new Set(routeAudits.map((entry) => entry.resource_hash));
          for (const expectedHash of expectedRouteHashes) expect(observedRouteHashes.has(expectedHash)).toBe(true);
          expect(routeAudits.every((entry) =>
            entry.actor_hash === createHash('sha256').update('strict-test-user').digest('hex') &&
            entry.decision === 'deny' && entry.reason === 'strict_route'
          )).toBe(true);
        } finally {
          routeAuditDb.close();
        }

        const loadoutAuditFailureDb = new Database(join(tmpDir, 'squish.db'));
        try {
          loadoutAuditFailureDb.exec(`
            CREATE TRIGGER fail_loadout_audit BEFORE INSERT ON trust_audit_log
            WHEN NEW.asset_type = 'loadout' AND NEW.reason = 'loadout_change'
            BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;
          `);
        } finally {
          loadoutAuditFailureDb.close();
        }
        const failedAttach = parseToolResult(await server.callTool('squish_loadout', {
          action: 'add_loadout', agentId: 'strict-test-user', assetType: 'memory', assetId: remembered.id,
        }, TEST_TIMEOUT));
        expect(failedAttach.error).toBe('loadout_error');
        const failedAttachCheck = new Database(join(tmpDir, 'squish.db'));
        try {
          const row = failedAttachCheck.query(
            'SELECT COUNT(*) AS count FROM agent_loadouts WHERE agent_id = ? AND asset_type = ? AND asset_id = ?',
          ).get('strict-test-user', 'memory', remembered.id) as { count: number };
          expect(row.count).toBe(0);
          failedAttachCheck.exec('DROP TRIGGER fail_loadout_audit');
        } finally {
          failedAttachCheck.close();
        }

        const addOwnLoadout = parseToolResult(await server.callTool('squish_loadout', {
          action: 'add_loadout', agentId: 'strict-test-user', assetType: 'memory', assetId: remembered.id,
        }, TEST_TIMEOUT));
        expect(addOwnLoadout.ok).toBe(true);

        const compiled = parseToolResult(await server.callTool('squish_compile', {
          action: 'run', teamId: createdTeam.team.id, minImportance: 0, minAccessCount: 0, batchSize: 1,
        }, TEST_TIMEOUT));
        expect(compiled.ok).toBe(true);
        expect(compiled.sourceMemoryIds).toContain(remembered.id);
        expect(compiled.teamMemoryIds).toHaveLength(1);

        const compilerRaceSource = parseToolResult(await server.callTool('squish_remember', {
          content: 'A durable personal source that must remain unchanged during compiler promotion.', type: 'fact',
        }, TEST_TIMEOUT));
        expect(compilerRaceSource.ok).toBe(true);
        const compilerSourceSetup = new Database(join(tmpDir, 'squish.db'));
        try {
          compilerSourceSetup.query('UPDATE memories SET importance_score = 100, access_count = 100 WHERE id = ?')
            .run(compilerRaceSource.id);
          compilerSourceSetup.exec(`CREATE TRIGGER mutate_compiler_source_before_projection BEFORE INSERT ON knowledge
            WHEN json_extract(NEW.metadata, '$.promotedFrom') = '${compilerRaceSource.id}'
            BEGIN UPDATE memories SET content = 'concurrent compiler source tamper' WHERE id = '${compilerRaceSource.id}'; END;`);
        } finally {
          compilerSourceSetup.close();
        }
        const rejectedCompilerRace = parseToolResult(await server.callTool('squish_compile', {
          action: 'run', teamId: createdTeam.team.id, minImportance: 0, minAccessCount: 100, batchSize: 1,
        }, TEST_TIMEOUT));
        expect(rejectedCompilerRace.ok).toBe(true);
        expect(rejectedCompilerRace.promoted).toBe(0);
        expect(rejectedCompilerRace.errors.some((error: string) => error.includes(compilerRaceSource.id))).toBe(true);
        const compilerRaceCheck = new Database(join(tmpDir, 'squish.db'));
        try {
          const source = compilerRaceCheck.query('SELECT content FROM memories WHERE id = ?').get(compilerRaceSource.id) as { content: string };
          expect(source.content).toBe('A durable personal source that must remain unchanged during compiler promotion.');
          const promoted = compilerRaceCheck.query(`SELECT COUNT(*) AS count FROM memories
            WHERE team_id = ? AND json_extract(metadata, '$.promotionSourceId') = ?`)
            .get(createdTeam.team.id, compilerRaceSource.id) as { count: number };
          expect(promoted.count).toBe(0);
          const auditCount = compilerRaceCheck.query(`SELECT COUNT(*) AS count FROM team_security_audit
            WHERE action = 'promote_memory' AND decision = 'allow' AND target_hash = ?`)
            .get(createHash('sha256').update(compilerRaceSource.id).digest('hex')) as { count: number };
          expect(auditCount.count).toBe(0);
          compilerRaceCheck.exec('DROP TRIGGER mutate_compiler_source_before_projection');
        } finally {
          compilerRaceCheck.close();
        }

        const ownLoadout = parseToolResult(await server.callTool('squish_loadout', {
          action: 'get_loadout', agentId: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(ownLoadout.loadout.map((entry: { assetId: string }) => entry.assetId)).toContain(remembered.id);

        const poisonLoadoutSourceDb = new Database(join(tmpDir, 'squish.db'));
        try {
          poisonLoadoutSourceDb.query('UPDATE memories SET content = ? WHERE id = ?')
            .run('TAMPERED loadout source must be withheld', remembered.id);
        } finally {
          poisonLoadoutSourceDb.close();
        }
        const poisonedLoadout = parseToolResult(await server.callTool('squish_loadout', {
          action: 'get_loadout', agentId: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(poisonedLoadout.loadout.map((entry: { assetId: string }) => entry.assetId)).not.toContain(remembered.id);
        expect(JSON.stringify(poisonedLoadout)).not.toContain('TAMPERED loadout source');
        const restoreLoadoutSourceDb = new Database(join(tmpDir, 'squish.db'));
        try {
          restoreLoadoutSourceDb.query('UPDATE memories SET content = ? WHERE id = ?')
            .run('Strict owner memory may be loaded by its authenticated agent.', remembered.id);
        } finally {
          restoreLoadoutSourceDb.close();
        }

        const loadoutAuditDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const audit = loadoutAuditDb.query("SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log WHERE asset_type = 'loadout' AND reason = 'loadout_change' ORDER BY created_at DESC LIMIT 1").get() as { actor_hash: string; resource_hash: string; decision: string; reason: string };
          expect(audit.decision).toBe('allow');
          expect(audit.reason).toBe('loadout_change');
          expect(audit.actor_hash).not.toBe('strict-test-user');
          expect(audit.resource_hash).not.toBe(remembered.id);
        } finally {
          loadoutAuditDb.close();
        }

        const removeAuditFailureDb = new Database(join(tmpDir, 'squish.db'));
        try {
          removeAuditFailureDb.exec(`
            CREATE TRIGGER fail_loadout_audit BEFORE INSERT ON trust_audit_log
            WHEN NEW.asset_type = 'loadout' AND NEW.reason = 'loadout_change'
            BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;
          `);
        } finally {
          removeAuditFailureDb.close();
        }
        const failedDetach = parseToolResult(await server.callTool('squish_loadout', {
          action: 'remove_loadout', agentId: 'strict-test-user', assetType: 'memory', assetId: remembered.id,
        }, TEST_TIMEOUT));
        expect(failedDetach.error).toBe('loadout_error');
        const failedDetachCheck = new Database(join(tmpDir, 'squish.db'));
        try {
          const row = failedDetachCheck.query(
            'SELECT COUNT(*) AS count FROM agent_loadouts WHERE agent_id = ? AND asset_type = ? AND asset_id = ?',
          ).get('strict-test-user', 'memory', remembered.id) as { count: number };
          expect(row.count).toBe(1);
          failedDetachCheck.exec('DROP TRIGGER fail_loadout_audit');
        } finally {
          failedDetachCheck.close();
        }

        const removeOwnLoadout = parseToolResult(await server.callTool('squish_loadout', {
          action: 'remove_loadout', agentId: 'strict-test-user', assetType: 'memory', assetId: remembered.id,
        }, TEST_TIMEOUT));
        expect(removeOwnLoadout.removed).toBe(true);
        const afterRemoval = parseToolResult(await server.callTool('squish_loadout', {
          action: 'get_loadout', agentId: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(afterRemoval.loadout.map((entry: { assetId: string }) => entry.assetId)).not.toContain(remembered.id);
        const noOpDetach = parseToolResult(await server.callTool('squish_loadout', {
          action: 'remove_loadout', agentId: 'strict-test-user', assetType: 'memory', assetId: remembered.id,
        }, TEST_TIMEOUT));
        expect(noOpDetach.removed).toBe(false);
        const noOpDetachAuditDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const changes = noOpDetachAuditDb.query(
            "SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'loadout' AND reason = 'loadout_change' AND resource_hash = ?",
          ).get(createHash('sha256').update(remembered.id).digest('hex')) as { count: number };
          expect(changes.count).toBe(2);
        } finally {
          noOpDetachAuditDb.close();
        }

        const promotionTeam = parseToolResult(await server.callTool('squish_team', {
          action: 'create', name: 'Strict Promotion Proof Team',
        }, TEST_TIMEOUT));
        expect(promotionTeam.ok).toBe(true);
        const promotionSource = parseToolResult(await server.callTool('squish_remember', {
          content: 'A verified private source for team promotion lineage.', type: 'fact',
        }, TEST_TIMEOUT));
        expect(promotionSource.ok).toBe(true);
        const promotionResult = parseToolResult(await server.callTool('squish_team', {
          action: 'promote_memory', teamId: promotionTeam.team.id, memoryId: promotionSource.id,
        }, TEST_TIMEOUT));
        expect(promotionResult.ok).toBe(true);
        const promotionDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const promotedRow = promotionDb.query(`SELECT id, project_id, user_id, team_id, type, content, metadata
            FROM memories WHERE team_id = ? AND json_extract(metadata, '$.promotionSourceId') = ? LIMIT 1`)
            .get(promotionTeam.team.id, promotionSource.id) as {
              id: string; project_id: string | null; user_id: string; team_id: string; type: string; content: string; metadata: string;
            } | undefined;
          expect(promotedRow).toBeTruthy();
          const promotedMetadata = JSON.parse(promotedRow!.metadata) as Record<string, unknown>;
          expect(promotedMetadata.promotionSourceId).toBe(promotionSource.id);
          expect(verifyMemoryProvenance({
            content: promotedRow!.content, projectId: promotedRow!.project_id, type: promotedRow!.type,
            ownerId: promotedRow!.user_id, teamId: promotedRow!.team_id, sourceMemoryId: promotedRow!.id,
            metadata: promotedMetadata,
          }, {
            SQUISH_PROVENANCE_KEY_ID: 'strict-test-key',
            SQUISH_PROVENANCE_PUBLIC_KEY: strictProvenanceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          } as NodeJS.ProcessEnv)).toBe(true);
        } finally {
          promotionDb.close();
        }

        const poisonedPromotionSource = parseToolResult(await server.callTool('squish_remember', {
          content: 'A source that must not be promoted after its signed content changes.', type: 'fact',
        }, TEST_TIMEOUT));
        expect(poisonedPromotionSource.ok).toBe(true);
        const poisonPromotionDb = new Database(join(tmpDir, 'squish.db'));
        try {
          poisonPromotionDb.query('UPDATE memories SET content = ? WHERE id = ?')
            .run('TAMPERED promotion source must stay private', poisonedPromotionSource.id);
        } finally {
          poisonPromotionDb.close();
        }
        const deniedPoisonedPromotion = parseToolResult(await server.callTool('squish_team', {
          action: 'promote_memory', teamId: promotionTeam.team.id, memoryId: poisonedPromotionSource.id,
        }, TEST_TIMEOUT));
        expect(deniedPoisonedPromotion.error).toBe('team_denied');
        const poisonedPromotionCheck = new Database(join(tmpDir, 'squish.db'));
        try {
          const promotedTamperedSource = poisonedPromotionCheck.query(
            "SELECT COUNT(*) AS count FROM memories WHERE json_extract(metadata, '$.promotionSourceId') = ?",
          ).get(poisonedPromotionSource.id) as { count: number };
          expect(promotedTamperedSource.count).toBe(0);
        } finally {
          poisonedPromotionCheck.close();
        }

        const strictFilePath = join(tmpDir, 'strict-source.txt');
        const strictFileContent = 'Signed strict document evidence: the release gate passed.';
        await writeFile(strictFilePath, strictFileContent, 'utf8');
        const strictIngest = parseToolResult(await server.callTool('squish_remember', {
          filePath: strictFilePath, type: 'fact',
        }, TEST_TIMEOUT));
        expect(strictIngest.ok).toBe(true);
        expect(strictIngest.memoryId).toBeTruthy();
        const ingestedDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const ingestedRow = ingestedDb.query('SELECT id, project_id, type, content, metadata, user_id, team_id FROM memories WHERE id = ?')
            .get(strictIngest.memoryId) as { id: string; project_id: string | null; type: string; content: string; metadata: string; user_id: string; team_id: string | null };
          const ingestedMetadata = JSON.parse(ingestedRow.metadata) as Record<string, unknown>;
          const sourceHash = createHash('sha256').update(strictFileContent).digest('hex');
          expect(ingestedRow.content).toContain(strictFileContent);
          expect(ingestedRow.user_id).toBeTruthy();
          expect(ingestedMetadata.sourceId).toBe(`sha256:${sourceHash}`);
          expect(ingestedMetadata.mediaPath).toBeUndefined();
          expect(verifyMemoryProvenance({ content: ingestedRow.content, projectId: ingestedRow.project_id,
            type: ingestedRow.type, ownerId: ingestedRow.user_id, teamId: ingestedRow.team_id,
            sourceMemoryId: ingestedRow.id, metadata: ingestedMetadata }, {
            SQUISH_PROVENANCE_KEY_ID: 'strict-test-key',
            SQUISH_PROVENANCE_PUBLIC_KEY: strictProvenanceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          } as NodeJS.ProcessEnv)).toBe(true);
          const projection = ingestedDb.query("SELECT project_id, knowledge_type, content, metadata FROM knowledge WHERE knowledge_kind = 'memory' AND json_extract(metadata, '$.sourceMemoryId') = ?")
            .get(ingestedRow.id) as { project_id: string | null; knowledge_type: string; content: string; metadata: string };
          const projectionMetadata = JSON.parse(projection.metadata) as Record<string, unknown>;
          expect(projectionMetadata.sourceId).toBe(`sha256:${sourceHash}`);
          expect(verifyMemoryProvenance({ content: projection.content, projectId: projection.project_id,
            type: projection.knowledge_type, ownerId: ingestedRow.user_id, teamId: ingestedRow.team_id,
            sourceMemoryId: ingestedRow.id, metadata: projectionMetadata }, {
            SQUISH_PROVENANCE_KEY_ID: 'strict-test-key',
            SQUISH_PROVENANCE_PUBLIC_KEY: strictProvenanceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          } as NodeJS.ProcessEnv)).toBe(true);
        } finally {
          ingestedDb.close();
        }

        const loadoutRemovalAuditDb = new Database(join(tmpDir, 'squish.db'));
        try {
          const changes = loadoutRemovalAuditDb.query("SELECT COUNT(*) AS count FROM trust_audit_log WHERE asset_type = 'loadout' AND reason = 'loadout_change' AND resource_hash = ?").get(createHash('sha256').update(remembered.id).digest('hex')) as { count: number };
          expect(changes.count).toBe(2);
        } finally {
          loadoutRemovalAuditDb.close();
        }

        const strictDb = new Database(join(tmpDir, 'squish.db'));
        try {
          strictDb.query("UPDATE knowledge SET content = ? WHERE id = (SELECT id FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') = ? LIMIT 1)")
            .run('TAMPERED strict projection must never be returned', remembered.id);
        } finally {
          strictDb.close();
        }
        const poisonedProjection = parseToolResult(await server.callTool('squish_recall', {
          query: 'TAMPERED strict projection', user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(JSON.stringify(poisonedProjection.memories)).not.toContain('TAMPERED strict projection');
        const projectionContext = parseToolResult(await server.callTool('squish_context', {
          user: 'strict-test-user', limit: 50,
        }, TEST_TIMEOUT));
        expect(JSON.stringify(projectionContext)).not.toContain('TAMPERED strict projection');

        const sourceDb = new Database(join(tmpDir, 'squish.db'));
        try {
          sourceDb.query('UPDATE memories SET content = ? WHERE id = ?')
            .run('TAMPERED strict owner memory must never be returned', remembered.id);
        } finally {
          sourceDb.close();
        }
        const poisonedSearch = parseToolResult(await server.callTool('squish_recall', {
          query: 'TAMPERED strict owner memory', user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(JSON.stringify(poisonedSearch.memories)).not.toContain('TAMPERED strict owner memory');
        const poisonedIdRead = parseToolResult(await server.callTool('squish_recall', {
          query: remembered.id, user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(JSON.stringify(poisonedIdRead)).not.toContain('TAMPERED strict owner memory');
        const poisonedDelete = parseToolResult(await server.callTool('squish_forget', {
          memoryId: remembered.id, user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(poisonedDelete.error).toBe('not_found');
        const poisonedDeleteCheck = new Database(join(tmpDir, 'squish.db'));
        try {
          expect(poisonedDeleteCheck.query('SELECT id FROM memories WHERE id = ?').get(remembered.id))
            .toBeDefined();
          expect(poisonedDeleteCheck.query(`SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log
            WHERE asset_type = 'memory' AND reason = 'invalid_signature' AND resource_hash = ? ORDER BY rowid DESC LIMIT 1`)
            .get(createHash('sha256').update(remembered.id).digest('hex'))).toEqual({
              actor_hash: createHash('sha256').update('strict-test-user').digest('hex'),
              resource_hash: createHash('sha256').update(remembered.id).digest('hex'),
              decision: 'deny',
              reason: 'invalid_signature',
            });
        } finally {
          poisonedDeleteCheck.close();
        }
        const failForgetAuditDb = new Database(join(tmpDir, 'squish.db'));
        try {
          failForgetAuditDb.exec(`CREATE TRIGGER fail_invalid_signature_audit BEFORE INSERT ON trust_audit_log
            WHEN NEW.asset_type = 'memory' AND NEW.reason = 'invalid_signature'
            BEGIN SELECT RAISE(ABORT, 'injected trust audit failure'); END;`);
        } finally {
          failForgetAuditDb.close();
        }
        const auditFailureDelete = parseToolResult(await server.callTool('squish_forget', {
          memoryId: remembered.id, user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(auditFailureDelete.error).toBe('not_found');
        const failForgetAuditCheck = new Database(join(tmpDir, 'squish.db'));
        try {
          expect(failForgetAuditCheck.query('SELECT id FROM memories WHERE id = ?').get(remembered.id))
            .toBeDefined();
          failForgetAuditCheck.exec('DROP TRIGGER fail_invalid_signature_audit');
        } finally {
          failForgetAuditCheck.close();
        }
        const poisonedContext = parseToolResult(await server.callTool('squish_context', {
          user: 'strict-test-user', limit: 50,
        }, TEST_TIMEOUT));
        expect(JSON.stringify(poisonedContext)).not.toContain('TAMPERED strict owner memory');

        const deletable = parseToolResult(await server.callTool('squish_remember', {
          content: 'Signed owner memory for successful audited deletion.', type: 'fact',
        }, TEST_TIMEOUT));
        expect(deletable.ok).toBe(true);
        const successfulDelete = parseToolResult(await server.callTool('squish_forget', {
          memoryId: deletable.id, user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(successfulDelete.ok).toBe(true);
        const deleteAuditDb = new Database(join(tmpDir, 'squish.db'));
        try {
          expect(deleteAuditDb.query('SELECT id FROM memories WHERE id = ?').get(deletable.id)).toBeNull();
          expect(deleteAuditDb.query(`SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log
            WHERE asset_type = 'memory' AND reason = 'memory_delete' AND resource_hash = ? ORDER BY rowid DESC LIMIT 1`)
            .get(createHash('sha256').update(deletable.id).digest('hex'))).toEqual({
              actor_hash: createHash('sha256').update('strict-test-user').digest('hex'),
              resource_hash: createHash('sha256').update(deletable.id).digest('hex'),
              decision: 'allow',
              reason: 'memory_delete',
            });
        } finally {
          deleteAuditDb.close();
        }

        const auditFailureTarget = parseToolResult(await server.callTool('squish_remember', {
          content: 'Signed owner memory retained if delete audit fails.', type: 'fact',
        }, TEST_TIMEOUT));
        expect(auditFailureTarget.ok).toBe(true);
        const failDeleteAllowAuditDb = new Database(join(tmpDir, 'squish.db'));
        try {
          failDeleteAllowAuditDb.exec(`CREATE TRIGGER fail_memory_delete_audit BEFORE INSERT ON trust_audit_log
            WHEN NEW.asset_type = 'memory' AND NEW.reason = 'memory_delete'
            BEGIN SELECT RAISE(ABORT, 'injected delete audit failure'); END;`);
        } finally {
          failDeleteAllowAuditDb.close();
        }
        const failedDeleteAudit = parseToolResult(await server.callTool('squish_forget', {
          memoryId: auditFailureTarget.id, user: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(failedDeleteAudit.error).toBe('not_found');
        const failedDeleteCheck = new Database(join(tmpDir, 'squish.db'));
        try {
          expect(failedDeleteCheck.query('SELECT id FROM memories WHERE id = ?').get(auditFailureTarget.id)).toBeDefined();
          failedDeleteCheck.exec('DROP TRIGGER fail_memory_delete_audit');
        } finally {
          failedDeleteCheck.close();
        }

        const listedTeams = parseToolResult(await server.callTool('squish_team', { action: 'list' }, TEST_TIMEOUT));
        expect(listedTeams.teams.map((team: { id: string }) => team.id)).toContain(createdTeam.team.id);

        const memberInvite = parseToolResult(await server.callTool('squish_team', {
          action: 'invite', teamId: createdTeam.team.id, email: 'member@example.invalid',
        }, TEST_TIMEOUT));
        expect(memberInvite.ok).toBe(true);
        const ownerInvite = parseToolResult(await server.callTool('squish_team', {
          action: 'invite', teamId: createdTeam.team.id, email: 'owner@example.invalid', role: 'owner',
        }, TEST_TIMEOUT));
        expect(ownerInvite.error).toBe('team_denied');

        const removeOwner = parseToolResult(await server.callTool('squish_team', {
          action: 'remove_member', teamId: createdTeam.team.id, userId: 'strict-test-user',
        }, TEST_TIMEOUT));
        expect(removeOwner.error).toBe('team_denied');

        const nonMember = parseToolResult(await server.callTool(
          'squish_team', { action: 'members', teamId: 'not-a-team-member' }, TEST_TIMEOUT,
        ));
        expect(nonMember.error).toBe('team_denied');

        const driftDb = new Database(join(tmpDir, 'squish.db'));
        try {
          driftDb.exec('DROP TABLE memory_feedback');
        } finally {
          driftDb.close();
        }
        const withheldDuringSchemaDrift = parseToolResult(await server.callTool(
          'squish_skill', { action: 'list' }, TEST_TIMEOUT,
        ));
        expect(withheldDuringSchemaDrift.error).toBe('strict_surface_unavailable');
        expect(JSON.stringify(withheldDuringSchemaDrift)).not.toContain('memory_feedback');
        expect(JSON.stringify(withheldDuringSchemaDrift)).not.toContain('schema_drift');
        const driftDenialAudit = new Database(join(tmpDir, 'squish.db'));
        try {
          const denial = driftDenialAudit.query(
            "SELECT decision, reason, resource_hash FROM trust_audit_log WHERE asset_type = 'tool' AND reason = 'strict_surface' ORDER BY created_at DESC LIMIT 1",
          ).get() as { decision: string; reason: string; resource_hash: string };
          expect(denial).toEqual({
            decision: 'deny',
            reason: 'strict_surface',
            resource_hash: createHash('sha256').update('squish_skill').digest('hex'),
          });
        } finally {
          driftDenialAudit.close();
        }
      } finally {
        if (server) await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT * 2
  );

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
