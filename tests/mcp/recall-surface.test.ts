import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readText(pathParts: string[]) {
  return readFileSync(join(process.cwd(), ...pathParts), "utf8");
}

/** Read MCP source across all tool files (tools were refactored into separate modules) */
function readMcpSource(): string {
  const files = [
    ["mcp", "index.ts"],
    ["mcp", "tools", "memory.ts"],
    ["mcp", "tools", "extras.ts"],
    ["mcp", "tools", "skill.ts"],
    ["mcp", "tools", "team.ts"],
    ["mcp", "tools", "dedup.ts"],
    ["mcp", "tools", "edits.ts"],
  ];
  return files.map((f) => { try { return readText(f); } catch { return ""; } }).join("\n");
}

describe("MCP recall surface", () => {
  it("does not register the legacy dedicated search tool", () => {
    const source = readMcpSource();
    const legacyToolName = `"squish_${"search"}"`;

    expect(source).not.toContain(legacyToolName);
    expect(source).toContain('"squish_recall"');
  });

  it("exposes squish_recall as query-or-id recall", () => {
    const source = readMcpSource();

    expect(source).toContain('query: z.string().describe("Query text or memory ID to recall")');
    expect(source).toContain("const isUuid =");
    expect(source).toContain("await sdkClient.search(");
  });

  it("delegates mcp health to the real server instead of hardcoded success", () => {
    const wrapper = readText(["bin", "squish-mcp.mjs"]);
    const hardcodedSuccess = `Health check: ${"OK"}`;

    expect(wrapper).not.toContain(hardcodedSuccess);
    expect(wrapper).toContain("mcpArgs.push('--health')");
    expect(wrapper).toContain("const child = spawn(runtime.command, runtime.args");
  });
});
