/**
 * Shared contract for the MCP tool modules.
 *
 * History: every `mcp/tools/*.ts` re-declared `ToolCtx` and `jsonResult`
 * byte-for-byte, so a wire-format change meant editing six files and missing
 * one was invisible. One module now owns both. `mcp/tools/memory.ts` still
 * carries its own copies because the file is under active operator edits; it
 * converts with the same import when that lands.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { SquishRuntime } from "../../core/runtime/squish-runtime.js";

/** Everything a tool-registration function needs from the server bootstrap. */
export interface ToolCtx {
  register: (server: McpServer, name: string, definition: any, handler: any) => boolean;
  server: McpServer;
  sdkClient: SquishRuntime;
  resolveProjectPath: (projectArg?: string) => string | undefined;
  errorResponse: (code: string, message: string, detail?: string, remediation?: string) => any;
  SERVER_VERSION: string;
}

/**
 * The version advertised on the wire. It lived in `mcp/index.ts` and again in
 * `mcp/tools/memory.ts`, so a release bump had to remember both places; one
 * declaration, imported wherever the version is stamped into a response.
 */
export const SERVER_VERSION = "2.2.0";

/** Tool result carrying a JSON payload, optionally stamped with a version. */
export function jsonResult(payload: unknown, version?: string) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(version ? { ...(payload as Record<string, unknown>), version } : payload, null, 2),
    }],
  };
}
