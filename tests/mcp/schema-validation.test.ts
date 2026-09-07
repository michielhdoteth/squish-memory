import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers – extract tool registrations from MCP server source
// ---------------------------------------------------------------------------

const MCP_SRC = join(process.cwd(), "packages", "mcp", "src", "index.ts");
const MCP_EXTRAS_SRC = join(process.cwd(), "packages", "mcp", "src", "tools", "extras.ts");
const MCP_DEDUP_SRC = join(process.cwd(), "packages", "mcp", "src", "tools", "dedup.ts");

function readSource(): string {
  // Tool definitions live in index.ts (core tools), tools/extras.ts
  // (places, sessions, tier, maintenance) and tools/dedup.ts (dedup workflow)
  return (
    readFileSync(MCP_SRC, "utf8") +
    "\n" +
    readFileSync(MCP_EXTRAS_SRC, "utf8") +
    "\n" +
    readFileSync(MCP_DEDUP_SRC, "utf8")
  );
}

interface ToolInfo {
  name: string;
  description: string;
  inputSchemaZod: string; // raw Zod schema source for evaluation
}

/**
 * Extract tool registrations from the MCP server source code.
 * Parses each `safeRegisterTool(server, "name", { ... }, handler)` call
 * to extract the tool name, description, and inputSchema Zod definition.
 */
function extractTools(source: string): ToolInfo[] {
  const tools: ToolInfo[] = [];

  // Split by safeRegisterTool calls (extras.ts uses a `register` alias)
  const blocks = source.split(/(?:safeRegisterTool|register)\(\s*server\s*,/);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];

    // Extract tool name: first quoted string after the split
    const nameMatch = block.match(/^\s*"(\w+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    // Extract description from description: "..."
    const descMatch = block.match(/description:\s*"((?:[^"\\]|\.)*)"/);
    const description = descMatch?.[1] ?? "";

    // Extract inputSchema – find the opening { after "inputSchema:"
    const inputSchemaIdx = block.indexOf("inputSchema:");
    if (inputSchemaIdx === -1) continue;

    // Find the opening brace of the inputSchema object
    const afterKey = block.slice(inputSchemaIdx + "inputSchema:".length);
    const braceStart = afterKey.indexOf("{");
    if (braceStart === -1) continue;

    // Match balanced braces to find the closing }
    let depth = 0;
    let end = -1;
    for (let j = braceStart; j < afterKey.length; j++) {
      if (afterKey[j] === "{") depth++;
      else if (afterKey[j] === "}") {
        depth--;
        if (depth === 0) { end = j + 1; break; }
      }
    }
    if (end === -1) continue;

    const raw = afterKey.slice(braceStart, end);
    // Strip outer braces so evalZodSchema can wrap in its own { }
    const inputSchemaZod = raw.slice(1, -1);
    tools.push({ name, description, inputSchemaZod });
  }

  return tools;
}

/**
 * Evaluate a Zod schema string in a context where `z` is available.
 * Returns the Zod schema object.
 */
function evalZodSchema(schemaSource: string): any {
  const { z } = require("zod/v3");
  // eslint-disable-next-line no-new-func
  const fn = new Function("z", `return { ${schemaSource} };`);
  const fields = fn(z);
  return z.object(fields);
}

// ---------------------------------------------------------------------------
// 1. All tool input schemas are valid JSON Schema
// ---------------------------------------------------------------------------
describe("MCP schema validation", () => {
  it("all tool input schemas are valid JSON Schema", async () => {
    const { zodToJsonSchema } = await import("zod-to-json-schema");
    const source = readSource();
    const tools = extractTools(source);

    expect(tools.length).toBe(17);

    const validPropertyTypes = new Set([
      "string", "number", "boolean", "object", "array", "integer",
    ]);

    for (const tool of tools) {
      const schemaObj = evalZodSchema(tool.inputSchemaZod);
      const jsonSchema = zodToJsonSchema(schemaObj);

      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toBeTypeOf("object");

      if (jsonSchema.required !== undefined) {
        expect(Array.isArray(jsonSchema.required)).toBe(true);
      }

      for (const [_key, prop] of Object.entries(jsonSchema.properties!)) {
        const p = prop as any;
        expect(p).toBeDefined();
        // Valid JSON Schema property: has a direct type, uses anyOf/oneOf (unions),
        // or is unconstrained (e.g. z.any() produces just { description: "..." })
        const hasDirectType = validPropertyTypes.has(p.type);
        const hasUnion = Array.isArray(p.anyOf) || Array.isArray(p.oneOf);
        const isUnconstrained = p.description !== undefined && !p.type && !p.anyOf && !p.oneOf;
        expect(hasDirectType || hasUnion || isUnconstrained).toBe(true);
      }
    }
  });

  // -----------------------------------------------------------------------
  // 2. Each tool has a non-empty description
  // -----------------------------------------------------------------------
  it("each tool has a non-empty description", () => {
    const source = readSource();
    const tools = extractTools(source);

    expect(tools.length).toBe(17);

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  // -----------------------------------------------------------------------
  // 3. Each tool name matches expected set
  // -----------------------------------------------------------------------
  it("each tool name matches expected set", () => {
    const source = readSource();
    const tools = extractTools(source);

    const expected = new Set([
      "squish_remember",
      "squish_recall",
      "squish_forget",
      "squish_link",
      "squish_context",
      "squish_stats",
      "squish_inspect",
      "squish_skill",
      "squish_loadout",
      "squish_extract",
      "squish_places",
      "squish_sessions",
      "squish_tier",
      "squish_maintenance",
      "squish_dedup",
      "squish_feedback",
    ]);

    const actual = new Set(tools.map((t) => t.name));

    expect(actual.size).toBe(expected.size);

    for (const name of expected) {
      expect(actual.has(name)).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // 4. Zod v3 produces valid JSON Schema (regression: Zod v4 crash fix)
  // -----------------------------------------------------------------------
  it("Zod v3 produces valid JSON Schema", async () => {
    // This is the critical regression test. Zod v4 classic schemas expose
    // `_zod.def` which crashes `z4mini.toJSONSchema()` used internally by
    // MCP SDK 1.29.0. Importing from "zod/v3" gives v3-compatible schemas
    // that work correctly with zod-to-json-schema.
    const { z } = await import("zod/v3");
    const { zodToJsonSchema } = await import("zod-to-json-schema");

    // Schema 1: query + optional limit
    const schema1 = z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    });
    const json1 = zodToJsonSchema(schema1);
    expect(json1.type).toBe("object");
    expect(json1.properties?.query).toBeDefined();
    expect(json1.properties?.limit).toBeDefined();
    expect(json1.required).toContain("query");

    // Schema 2: enum + required string
    const schema2 = z.object({
      action: z.enum(["add", "list", "remove"]),
      user: z.string(),
    });
    const json2 = zodToJsonSchema(schema2);
    expect(json2.type).toBe("object");
    expect(json2.properties?.action).toBeDefined();
    expect(json2.properties?.user).toBeDefined();
    expect(json2.required).toContain("action");
    expect(json2.required).toContain("user");

    // Schema 3: string + optional array
    const schema3 = z.object({
      content: z.string(),
      tags: z.array(z.string()).optional(),
    });
    const json3 = zodToJsonSchema(schema3);
    expect(json3.type).toBe("object");
    expect(json3.properties?.content).toBeDefined();
    expect(json3.properties?.tags).toBeDefined();
    expect(json3.required).toContain("content");
  });

  // -----------------------------------------------------------------------
  // 5. Zod v3 schemas do NOT have _zod.def (v4 signature)
  // -----------------------------------------------------------------------
  it("Zod v3 schemas do not have _zod.def (v4 signature)", async () => {
    const { z } = await import("zod/v3");

    const schema = z.object({ foo: z.string() });

    // Zod v4 schemas have `_zod` (internal), v3 schemas have `_def`
    expect((schema as any)._zod).toBeUndefined();
    expect((schema as any)._def).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 6. Required fields are declared in inputSchema
  // -----------------------------------------------------------------------
  it("required fields are declared in inputSchema", async () => {
    const { zodToJsonSchema } = await import("zod-to-json-schema");
    const source = readSource();
    const tools = extractTools(source);

    expect(tools.length).toBe(17);

    for (const tool of tools) {
      const schemaObj = evalZodSchema(tool.inputSchemaZod);
      const jsonSchema = zodToJsonSchema(schemaObj);

      if (jsonSchema.required && Array.isArray(jsonSchema.required)) {
        for (const field of jsonSchema.required) {
          expect(jsonSchema.properties).toHaveProperty(field);
        }
      }
    }
  });
});
