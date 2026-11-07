/**
 * sql.js wasm asset resolution (risk R1 regression).
 *
 * `db/adapter.ts` resolves the sql.js wasm from three candidates. The only one
 * that ever matched was `<cwd>/node_modules/sql.js/dist/sql-wasm.wasm`, and it
 * only matched because the MCP/CLI wrappers pinned the child cwd to the package
 * root. ADR-002 removed that pin, so the cwd candidate now points at the agent
 * host's workspace and misses; startup then fails hard instead of degrading.
 *
 * The fix resolves the asset from the module's own location with
 * `createRequire(import.meta.url)`, the same technique runtime-launcher.mjs uses
 * for tsx. sql.js has no "./package.json" export, so the package entry point is
 * resolved instead and the wasm sibling taken from its directory.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const packageRoot = join(import.meta.dir, "..", "..");
const adapterPath = join(packageRoot, "db", "adapter.ts");

function readAdapterSource(): string {
  return readFileSync(adapterPath, "utf-8");
}

describe("sql.js wasm resolution", () => {
  test("adapter imports createRequire so resolution is module-relative, not cwd-relative", () => {
    const source = readAdapterSource();
    expect(source).toContain("import { createRequire } from 'node:module'");
    expect(source).toContain("createRequire(import.meta.url)");
  });

  test("the module-relative candidate is preferred ahead of the cwd candidate", () => {
    const source = readAdapterSource();
    const packageCandidate = source.indexOf("...(fromPackage ? [fromPackage] : [])");
    const cwdCandidate = source.indexOf("path.resolve(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm')");

    expect(packageCandidate).toBeGreaterThan(-1);
    expect(cwdCandidate).toBeGreaterThan(-1);
    expect(packageCandidate).toBeLessThan(cwdCandidate);
  });

  test("resolving sql.js from a module outside the package root yields an existing wasm asset", () => {
    // Stand in for db/adapter.ts: a module inside the package, so createRequire
    // walks up to the package's own node_modules regardless of process.cwd().
    const requireFromAdapter = createRequire(adapterPath);
    const entryPath = requireFromAdapter.resolve("sql.js");
    const wasmPath = join(dirname(entryPath), "sql-wasm.wasm");

    expect(resolve(wasmPath).startsWith(resolve(packageRoot))).toBe(true);
    expect(existsSync(wasmPath)).toBe(true);
  });
});