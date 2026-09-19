import { readFileSync } from "node:fs";

const files = [
  "mcp/index.ts",
  "mcp/tools/extras.ts",
  "mcp/tools/dedup.ts",
  "mcp/tools/edits.ts",
  "mcp/tools/memory.ts",
  "mcp/tools/skill.ts",
  "mcp/tools/team.ts",
];

let src = "";
for (const f of files) {
  try { src += readFileSync(f, "utf8") + "\n"; } catch {}
}

// Match: register(\n server,\n "tool_name"
const re = /register\(\s*\n?\s*server\s*,\s*\n?\s*"(\w+)"/g;
let m;
const tools = [];
while ((m = re.exec(src)) !== null) {
  tools.push(m[1]);
}
console.log("Tool count:", tools.length);
tools.forEach((t) => console.log(" ", t));
