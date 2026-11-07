/**
 * Regression guard: a failing `squish_recall` / `squish_forget` search must
 * return the typed errorResponse injected into the tool context.
 *
 * Both handlers used to call `sdkClient.search(...)` bare, so an underlying
 * `ProjectNotFoundError` reached the client as a one-line
 * "Failed to search memories" string with no `ok:false` envelope and nothing in
 * the server log. The handlers are exercised here through the real
 * `registerMemoryTools` with a stub context, so no MCP server is spawned.
 */

import { describe, test, expect, beforeAll } from "bun:test";

type ToolHandler = (input: unknown) => Promise<unknown>;

let registerMemoryTools: typeof import("../../mcp/tools/memory.js").registerMemoryTools;
let captured: Map<string, ToolHandler>;
let errorCalls: Array<{ code: string; message: string; detail?: string; remediation?: string }>;

interface CapturedResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function errorResponse(code: string, message: string, detail?: string, remediation?: string): CapturedResult {
  errorCalls.push({ code, message, detail, remediation });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: code, message, detail, remediation }, null, 2),
      },
    ],
    isError: true,
  };
}

function parse(result: unknown): Record<string, unknown> {
  const captured = result as CapturedResult;
  const text = captured.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("tool returned no text content");
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  registerMemoryTools = (await import("../../mcp/tools/memory.js")).registerMemoryTools;
});

/** Build a context whose sdkClient.search always throws `error`. */
function contextWithFailingSearch(error: Error) {
  captured = new Map();
  errorCalls = [];

  const sdkClient = {
    search: () => Promise.reject(error),
    getById: () => Promise.resolve(null),
    forget: () => Promise.resolve(true),
  };

  const ctx = {
    register: (
      _server: unknown,
      name: string,
      _definition: unknown,
      handler: ToolHandler
    ) => {
      captured.set(name, handler);
      return true;
    },
    server: {},
    sdkClient,
    resolveProjectPath: (projectArg?: string) => projectArg ?? "/squish-test/stub-scope",
    errorResponse,
    SERVER_VERSION: "test",
  };

  const count = registerMemoryTools(ctx as never);
  return { count, handlers: captured };
}

describe("memory tool error responses", () => {
  test("squish_recall returns the typed errorResponse when search throws", async () => {
    const { handlers } = contextWithFailingSearch(
      new Error("Project not found: /squish-test/stub-scope")
    );
    const recall = handlers.get("squish_recall");
    expect(recall).toBeDefined();

    const result = await recall!({ query: "anything" });
    const payload = parse(result);

    expect((result as CapturedResult).isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("search_failed");
    expect(payload.message).toBe("Memory search failed");
    expect(String(payload.detail)).toContain("Project not found: /squish-test/stub-scope");
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]!.code).toBe("search_failed");
  });

  test("squish_forget bulk search returns the typed errorResponse and deletes nothing", async () => {
    const { handlers } = contextWithFailingSearch(new Error("storage offline"));
    const forget = handlers.get("squish_forget");
    expect(forget).toBeDefined();

    const result = await forget!({ search: "bulk target", confirm: true });
    const payload = parse(result);

    expect((result as CapturedResult).isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("search_failed");
    expect(String(payload.detail)).toContain("storage offline");
    // A failed match must never look like a successful destructive run.
    expect(payload.deleted).toBeUndefined();
    expect(errorCalls[0]!.message).toBe("Bulk delete search failed; nothing was deleted");
  });
});