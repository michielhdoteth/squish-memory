/**
 * Squish Memory plugin for OpenCode (v1.5.5)
 *
 * ---------------------------------------------------------------------------
 * INSTALL
 * ---------------------------------------------------------------------------
 * Run `squish install --clients=opencode` (or `--all`). The plugin folder is
 * copied to `~/.config/opencode/plugins/squish-memory/`, and `index.ts` is
 * loaded directly by Bun at OpenCode startup (no compile step).
 *
 * ---------------------------------------------------------------------------
 * ARCHITECTURE (v1.5.5 - chunk-based, SDK-driven)
 * ---------------------------------------------------------------------------
 * - Session discovery goes through OpenCode's SDK directly
 *   (`input.client.session.list/get/messages/diff`). The plugin does NOT
 *   shell out to `squish sessions list/show/...` for discovery.
 * - Chunks (decisions, file edits, errors, commands, summaries) are stored
 *   as Squish MEMORIES via `squish remember ... --tag squish_chunk:<type>
 *   --tag squish_session:<id> --tag agent:opencode`.
 * - Chunk SEARCH goes through `squish recall ...`, which is Squish's
 *   canonical memory search. The plugin post-filters recall results to
 *   entries with tags starting with `squish_chunk:` so users only see
 *   chunk-shaped results, not raw memories.
 * - Context INJECTION is built inline (session content -> markdown block)
 *   and pushed into the target session via `input.client.session.prompt(...)`.
 *
 * The `squish sessions ...` CLI subcommands remain for HUMANS running the
 * CLI directly; the plugin uses `squish remember` and `squish recall` for
 * its persistence and search needs.
 *
 * We do NOT import from `@opencode-ai/plugin`. The plugin folder is copied
 * verbatim to ~/.config/opencode/plugins/ and we cannot rely on OpenCode's
 * runtime to fetch npm deps for us. Instead we vendor the tiny `tool()`
 * helper below.
 */

import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Vendored OpenCode plugin types + tool() helper
// ---------------------------------------------------------------------------
//
// These mirror the surface area of `@opencode-ai/plugin` that we actually
// touch. Keeping this local means the plugin file has zero npm dependencies
// beyond zod (which is bundled with the squish install).

export type ToolResult =
  | string
  | {
      title?: string;
      output: string;
      metadata?: Record<string, unknown>;
      attachments?: Array<{
        type: "file";
        mime: string;
        url: string;
        filename?: string;
      }>;
    };

export type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
  ask(input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

type ToolDefinition<S extends z.ZodRawShape> = {
  description: string;
  args: S;
  execute(
    args: z.infer<z.ZodObject<S>>,
    context: ToolContext,
  ): Promise<ToolResult>;
};

export function tool<S extends z.ZodRawShape>(def: ToolDefinition<S>) {
  return def;
}
// The real @opencode-ai/plugin also re-exports zod as `tool.schema`. We
// expose the same alias to keep the surface area familiar.
(tool as unknown as { schema: typeof z }).schema = z;

// Minimal shape of the OpenCode SDK client methods we actually call. We do
// NOT type the whole client; the rest is `any` so we can pass the real one
// through without dragging in @opencode-ai/sdk as a build-time dep.
export type OpencodeSession = {
  id: string;
  title?: string;
  projectID?: string;
  directory?: string;
  parentID?: string;
  summary?: { additions?: number; deletions?: number; files?: number };
  createdAt?: number | string;
  updatedAt?: number | string;
  time?: { created?: number; updated?: number };
};

export type OpencodeMessage = {
  id: string;
  role?: "user" | "assistant" | "system" | "tool";
  sessionID?: string;
  content?: string | Array<{ type: string; text?: string }>;
  text?: string;
  // SDK may return a nested `parts` shape as well.
  parts?: Array<{ type: string; text?: string }>;
};

export type OpencodeSessionDiff = {
  files?: string[];
  additions?: number;
  deletions?: number;
};

export type PluginClient = {
  app: {
    log(input: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
        extra?: Record<string, unknown>;
      };
    }): Promise<unknown>;
  };
  session: {
    list(): Promise<OpencodeSession[]>;
    get(input: { path: { id: string } }): Promise<OpencodeSession>;
    messages(input: { path: { id: string } }): Promise<OpencodeMessage[]>;
    diff(input: { path: { id: string } }): Promise<OpencodeSessionDiff>;
    prompt(input: {
      path: { id: string };
      body: { parts: Array<{ type: "text"; text: string }> };
    }): Promise<unknown>;
  };
  vcs: {
    get(input: { directory: string }): Promise<{ branch?: string } | undefined>;
  };
};

export type PluginInput = {
  client: PluginClient;
  project?: { id?: string; name?: string; worktree?: string };
  directory: string;
  worktree: string;
  serverUrl?: string;
  $?: unknown;
};

export type PluginOptions = {
  autoCapture?: boolean;
  autoInjectContext?: boolean;
  contextLimit?: number;
};

/**
 * The event object OpenCode hands the `event` hook. Only the fields the
 * switch in `eventHook` reads are declared; the index signature keeps event
 * shapes this plugin does not handle assignable.
 */
export type OpencodeEvent = {
  type: string;
  sessionID?: string;
  title?: string;
  file?: string;
  diff?: { files?: unknown } | null;
  arguments?: unknown;
  error?: { message?: string };
  properties?: { info?: { id?: string } };
  [k: string]: unknown;
};

export type Hooks = {
  tool?: Record<string, ToolDefinition<z.ZodRawShape>>;
  event?: (input: { event: OpencodeEvent }) => void | Promise<void>;
  // Named event hooks are also supported by OpenCode but the catch-all
  // `event` hook above is simpler and we use it exclusively.
  [k: string]: unknown;
};

export type Plugin = (
  input: PluginInput,
  options?: PluginOptions,
) => Promise<Hooks>;

// `PluginModule` is the shape OpenCode expects from a plugin file's default
// export. `server` is the factory function we just defined.
export type PluginModule = {
  id: string;
  server: Plugin;
};

// ---------------------------------------------------------------------------
// CLI shim
// ---------------------------------------------------------------------------
//
// The plugin shells out to `squish remember` and `squish recall` for chunk
// persistence and search. It does NOT shell out to `squish sessions ...` -
// those CLI subcommands are for humans, and the plugin uses OpenCode's
// SDK for session discovery instead.

const execFileAsync = promisify(execFile);

function squishBin(): string {
  return process.platform === "win32" ? "squish.cmd" : "squish";
}

async function runSquishJson(
  args: string[],
  cwd: string,
): Promise<unknown> {
  let executable = squishBin();
  let executableArgs = args;
  if (process.platform === "win32") {
    // Windows cannot execute .cmd files directly through CreateProcess. Carry
    // the command and argv as base64 JSON, then invoke the shim through
    // PowerShell with an argument array so user content is never shell-parsed.
    const payload = Buffer.from(JSON.stringify({ command: executable, args }), "utf16le").toString("base64");
    const script = `$payload = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; & $payload.command @($payload.args); if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
    executable = "powershell.exe";
    executableArgs = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  }

  const { stdout } = await execFileAsync(executable, executableArgs, {
    cwd,
    env: { ...process.env, SQUISH_QUIET: "1" },
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

async function runSquishJsonSafe(
  args: string[],
  cwd: string,
  log: PluginClient["app"]["log"] | undefined,
  context: Record<string, unknown> = {},
): Promise<unknown | null> {
  try {
    return await runSquishJson(args, cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (log) {
      try {
        await log({
          body: {
            service: "squish-memory",
            level: "warn",
            message: `squish ${args.join(" ")} failed: ${message}`,
            extra: context,
          },
        });
      } catch {
        // logging is best-effort
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Current-session tracking
// ---------------------------------------------------------------------------
//
// `file.edited` events do not include the originating session id, so we
// remember the most-recently-created session id in module scope. This is
// good enough for an MVP: a multi-session tab in the same OpenCode run is
// not a use case we need to solve here.

let currentSessionID: string | null = null;
let currentSessionTitle: string = "";
let currentSessionCreated: string = ""; // ISO timestamp

// ---------------------------------------------------------------------------
// Chunk shape
// ---------------------------------------------------------------------------

export type ChunkType = "summary" | "decision" | "command" | "file" | "error" | "todo";

export type Chunk = {
  type: ChunkType;
  content: string;
  session_id: string;
  session_title: string;
  files: string[];
  timestamp: string; // ISO 8601
  source_event?: string;
};

// Map chunk type to the underlying Squish memory `type` we use for storage.
// Chunks ride on the existing `remember` memory types; we just tag them
// with `squish_chunk:<chunk_type>` so search can filter by chunk kind.
const CHUNK_TO_MEMORY_TYPE: Record<ChunkType, string> = {
  summary: "note",
  decision: "decision",
  command: "observation",
  file: "observation",
  error: "observation",
  todo: "task",
};

const MAX_CHUNK_CONTENT = 500;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "\u2026";
}

// ---------------------------------------------------------------------------
// captureChunk - the only place we write to Squish memory from the plugin
// ---------------------------------------------------------------------------
//
// Chunks are stored as memories with rich tags so they are discoverable
// via `squish recall ...` and post-filterable by tag prefix.
//   squish_chunk:<type>          - the chunk kind
//   squish_session:<id>          - the OpenCode session this chunk came from
//   squish_session_title:<title> - human-readable session title
//   agent:opencode               - which plugin captured it
//   file:<path>                  - for file/command chunks, one per file
//   project:<repo>               - the repo the chunk belongs to
//
// Always fire-and-forget; never throws.

async function captureChunk(
  chunk: {
    type: ChunkType;
    content: string;
    session_id: string;
    session_title: string;
    project: string;
    repo_path: string;
    branch: string;
    agent_session_id: string;
    files?: string[];
    timestamp?: string;
    source_event?: string;
  },
  sessionDir: string,
  log: PluginClient["app"]["log"] | undefined,
): Promise<void> {
  try {
    const memoryType = CHUNK_TO_MEMORY_TYPE[chunk.type];
    const content = truncate(chunk.content.trim(), MAX_CHUNK_CONTENT);
    if (!content) return;

    const tags: string[] = [
      `squish_chunk:${chunk.type}`,
      `squish_session:${chunk.session_id}`,
      "agent:opencode",
    ];
    if (chunk.session_title) {
      tags.push(`squish_session_title:${chunk.session_title}`);
    }
    if (chunk.project) {
      tags.push(`project:${chunk.project}`);
    }
    if (chunk.branch) {
      tags.push(`branch:${chunk.branch}`);
    }
    if (chunk.timestamp) {
      tags.push(`captured_at:${chunk.timestamp}`);
    }
    if (chunk.source_event) {
      tags.push(`source_event:${chunk.source_event}`);
    }
    if (chunk.files) {
      for (const f of chunk.files.slice(0, 20)) {
        if (typeof f === "string" && f.length > 0) {
          tags.push(`file:${f}`);
        }
      }
    }

    const args: string[] = [
      "remember",
      content,
      "--type",
      memoryType,
      "--tags",
      tags.join(","),
      "--project",
      chunk.repo_path || chunk.project || "",
      "--source",
      "opencode-plugin",
    ];

    await runSquishJsonSafe(args, sessionDir, log, {
      chunk_type: chunk.type,
      session_id: chunk.session_id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (log) {
      try {
        await log({
          body: {
            service: "squish-memory",
            level: "warn",
            message: `captureChunk threw: ${message}`,
            extra: { chunk_type: chunk.type },
          },
        });
      } catch {
        // logging is best-effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inline chunker heuristics
// ---------------------------------------------------------------------------
//
// Used by `squish_session_show` and `squish_session_related` to extract
// chunk-shaped facts from a session's full message history. Intentionally
// simple and self-contained - the plugin cannot import from the CLI's
// `core/sessions/chunker.ts` (the plugin folder is copied to a location
// where that import path is not guaranteed to resolve).

const DECISION_RE =
  /^(decision:|let'?s|we'?ll|we will|i'?ll|decided|chose|picked|going with|going to|chose to|picked to)\b/i;
const DECISION_LINE_RE = /\b(decided|chose|picked|going with|going to)\b/i;

const FILE_PATH_RE = /(?:^|[\s'"`])([a-zA-Z]:[\\/][^\s'"`,;)]+|\.{0,2}[\\/][^\s'"`,;)]+|(?:[a-zA-Z0-9_.-]+[\\/])+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|rb|php|css|scss|html|yml|yaml|toml|sql|sh|bash))\b/g;

const ERROR_RE = /\b(error|exception|failed|traceback|cannot|undefined is not)\b/i;
const COMMAND_RE = /^\s*(?:[$>]\s*)?([a-zA-Z][a-zA-Z0-9_./-]*\s+.+)$/;

function extractTextFromMessage(m: OpencodeMessage): string {
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p) => p && (p.type === "text" || p.type === "output"))
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("\n");
  }
  if (Array.isArray(m.parts)) {
    return m.parts
      .filter((p) => p && (p.type === "text" || p.type === "output"))
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("\n");
  }
  return "";
}

function extractFilePaths(text: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(FILE_PATH_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const candidate = (m[1] ?? m[0]).trim();
    if (candidate.length > 1 && candidate.length < 300) {
      out.add(candidate);
    }
  }
  return [...out];
}

function pickLine(s: string, re: RegExp): string | null {
  for (const line of s.split(/\r?\n/)) {
    if (re.test(line)) return line.trim();
  }
  return null;
}

export function chunkSession(
  sessionId: string,
  sessionTitle: string,
  messages: OpencodeMessage[],
  diff: OpencodeSessionDiff | null,
  ts: string,
): Chunk[] {
  const out: Chunk[] = [];
  const seen = new Set<string>();
  const push = (c: Chunk) => {
    const key = `${c.type}:${c.content}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  // Summary: first user message (or assistant if no user).
  const firstUser = messages.find((m) => m.role === "user");
  const firstAssistant = messages.find((m) => m.role === "assistant");
  const summarySource = firstUser ?? firstAssistant;
  if (summarySource) {
    const text = extractTextFromMessage(summarySource);
    const summary = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    if (summary) {
      push({
        type: "summary",
        content: summary,
        session_id: sessionId,
        session_title: sessionTitle,
        files: [],
        timestamp: ts,
      });
    }
  }

  // Decisions: scan assistant messages for decision-shaped lines.
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const text = extractTextFromMessage(m);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (DECISION_RE.test(trimmed) || DECISION_LINE_RE.test(trimmed)) {
        push({
          type: "decision",
          content: trimmed,
          session_id: sessionId,
          session_title: sessionTitle,
          files: [],
          timestamp: ts,
        });
      }
    }
  }

  // Errors: scan all messages for error-shaped lines.
  for (const m of messages) {
    const text = extractTextFromMessage(m);
    if (!text) continue;
    const errLine = pickLine(text, ERROR_RE);
    if (errLine && errLine.length > 0) {
      push({
        type: "error",
        content: errLine,
        session_id: sessionId,
        session_title: sessionTitle,
        files: [],
        timestamp: ts,
      });
    }
  }

  // Commands: scan for shell-shaped lines in tool or assistant messages.
  for (const m of messages) {
    if (!(m.role === "assistant" || m.role === "tool")) continue;
    const text = extractTextFromMessage(m);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (COMMAND_RE.test(trimmed) && !trimmed.startsWith("```")) {
        push({
          type: "command",
          content: trimmed,
          session_id: sessionId,
          session_title: sessionTitle,
          files: [],
          timestamp: ts,
        });
      }
    }
  }

  // Files: prefer the diff.files list, then sweep messages for path-like text.
  const fileSet = new Set<string>();
  if (diff && Array.isArray(diff.files)) {
    for (const f of diff.files) {
      if (typeof f === "string" && f.length > 0) fileSet.add(f);
    }
  }
  for (const m of messages) {
    const text = extractTextFromMessage(m);
    if (!text) continue;
    for (const f of extractFilePaths(text)) fileSet.add(f);
  }
  for (const f of fileSet) {
    push({
      type: "file",
      content: `Edited: ${f}`,
      session_id: sessionId,
      session_title: sessionTitle,
      files: [f],
      timestamp: ts,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Recall result post-filtering
// ---------------------------------------------------------------------------
//
// `squish recall` returns a heterogeneous mix of memory types. The plugin
// only cares about chunk-shaped memories (those with a `squish_chunk:*` tag)
// because that's the contract the auto-capture hooks and explicit-capture
// tool write.

type RawRecallResult = {
  id?: string;
  type?: string;
  content?: string;
  tags?: string[];
  similarity?: number;
  createdAt?: string | number;
};

type ChunkRecallHit = {
  id: string;
  type: ChunkType;
  content: string;
  session_id: string;
  session_title: string;
  similarity: number;
  tags: string[];
  createdAt?: string | number;
};

function classifyChunkType(tags: string[]): ChunkType | null {
  for (const t of tags) {
    if (t.startsWith("squish_chunk:")) {
      const v = t.slice("squish_chunk:".length) as ChunkType;
      if (
        v === "summary" ||
        v === "decision" ||
        v === "command" ||
        v === "file" ||
        v === "error" ||
        v === "todo"
      ) {
        return v;
      }
    }
  }
  return null;
}

function extractTagValue(tags: string[], prefix: string): string {
  for (const t of tags) {
    if (t.startsWith(prefix)) return t.slice(prefix.length);
  }
  return "";
}

function filterToChunks(raw: unknown, chunkType?: string, limit = 8): ChunkRecallHit[] {
  const list = Array.isArray(raw) ? (raw as RawRecallResult[]) : [];
  const wantType = chunkType && chunkType.length > 0 ? chunkType : null;
  const hits: ChunkRecallHit[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [];
    const ctype = classifyChunkType(tags);
    if (!ctype) continue;
    if (wantType && ctype !== wantType) continue;
    hits.push({
      id: typeof r.id === "string" ? r.id : "",
      type: ctype,
      content: typeof r.content === "string" ? r.content : "",
      session_id: extractTagValue(tags, "squish_session:"),
      session_title: extractTagValue(tags, "squish_session_title:"),
      similarity: typeof r.similarity === "number" ? r.similarity : 0,
      tags,
      createdAt: r.createdAt,
    });
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Tool result formatting
// ---------------------------------------------------------------------------

function ok(payload: unknown): ToolResult {
  return {
    title: "squish",
    output: JSON.stringify(payload, null, 2),
    metadata: { squish: true },
  };
}

function err(message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    title: "squish error",
    output: JSON.stringify({ ok: false, error: message, ...(extra ?? {}) }, null, 2),
    metadata: { squish: true, error: true },
  };
}

// ---------------------------------------------------------------------------
// Project / branch helpers
// ---------------------------------------------------------------------------

async function getBranch(
  input: PluginInput,
  directory: string,
): Promise<string> {
  try {
    const vcs = await input.client.vcs.get({ directory });
    return vcs?.branch ?? "";
  } catch {
    return "";
  }
}

function deriveProjectName(directory: string): string {
  if (!directory) return "unknown";
  const parts = directory.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "unknown";
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Auto-inject context on session start
// ---------------------------------------------------------------------------
//
// On every new OpenCode session we ask Squish for the relevant context
// (pinned memories, recent project memories, sibling projects) and push a
// compact markdown block back into the session as a user-text prompt part.
// This is the "auto-inject context" behavior the legacy plugin had.
//
// The function is fire-and-forget and never throws out to the event hook.

async function injectContextOnStart(
  input: PluginInput,
  sessionId: string,
  cwd: string,
  log: (
    level: "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ) => void,
): Promise<void> {
  try {
    // Batch 7: call the CANONICAL bootstrap composer via the CLI
    // (`squish context --session-start`). The MCP `squish_context`
    // action=session-start shares this code path; plugins must not roll
    // their own context assembly.
    const out = await runSquishJsonSafe(
      ["context", "--session-start", "--project", cwd, "--json"],
      cwd,
      input.client.app.log,
      { event: "session.created", session_id: sessionId, phase: "auto-inject" },
    );
    if (out === null || out === undefined) {
      log("warn", "auto-inject: squish context returned no data", { session_id: sessionId });
      return;
    }

    const payload = out as { block?: string; totalTokens?: number; ceilingTokens?: number };
    const block = typeof payload.block === "string" ? payload.block : "";
    if (!block.trim()) {
      log("info", "auto-inject: empty bootstrap block, skipping prompt push", {
        session_id: sessionId,
      });
      return;
    }

    const text =
      `# Auto-injected context\n\n` +
      `Session bootstrap from squish (~${payload.totalTokens ?? "?"}/${payload.ceilingTokens ?? 2000} tokens):\n\n` +
      block;

    try {
      await input.client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text }] },
      });
      log("info", "auto-inject: bootstrap block pushed into session", {
        session_id: sessionId,
        byte_count: text.length,
        tokens: payload.totalTokens ?? null,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log("error", "auto-inject: session.prompt failed", {
        session_id: sessionId,
        error: message,
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("warn", "auto-inject: unexpected error", {
      session_id: sessionId,
      error: message,
    });
  }
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

const SquishPlugin: Plugin = async (input, options) => {
  const cfg = options ?? {};
  // Pilot default: autoCapture OFF. The pilot is "show the round trip works",
  // which means explicit capture (CLI or squish_session_capture tool) is the
  // source of truth. Users can opt back in by passing `autoCapture: true` in
  // the plugin options / opencode.json `squish-memory` block.
  const autoCapture = cfg.autoCapture ?? false;
  const autoInjectContext = cfg.autoInjectContext ?? true;

  const log = (
    level: "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ) => {
    // Fire-and-forget. Never throw.
    input.client.app
      .log({ body: { service: "squish-memory", level, message, extra } })
      .catch(() => {});
  };

  // ---------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------

  const sessionList = tool({
    description:
      "List recent OpenCode sessions visible to this plugin. Use when the user asks what past coding sessions exist or wants to pick one to load.",
    args: {
      limit: z.number().int().min(1).max(200).optional()
        .describe("Max sessions to return (default 50)."),
      status: z.enum(["active", "completed", "errored"]).optional()
        .describe("Optional status filter; OpenCode does not surface status, so this is currently a hint only."),
    },
    async execute(args, ctx) {
      let sessions: OpencodeSession[] = [];
      try {
        const all = await input.client.session.list();
        sessions = Array.isArray(all) ? all : [];
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log("warn", "session.list via SDK failed", { error: message });
        return err(
          "OpenCode SDK session.list failed. Fall back to running `squish sessions list` from the CLI.",
          { error: message },
        );
      }
      const limit = args.limit ?? 50;
      const sliced = sessions.slice(0, limit);
      return ok({
        ok: true,
        source: "opencode-sdk",
        count: sliced.length,
        sessions: sliced.map((s) => ({
          id: s.id,
          title: s.title ?? "",
          createdAt: s.createdAt ?? s.time?.created ?? null,
          updatedAt: s.updatedAt ?? s.time?.updated ?? null,
          directory: s.directory ?? null,
        })),
      });
    },
  });

  const sessionShow = tool({
    description:
      "Show the chunked view of a single OpenCode session: summary, decisions, commands, file edits, and errors. Use when the user wants to see what happened in a prior session.",
    args: {
      id: z.string().min(1).describe("OpenCode session id to load."),
    },
    async execute(args, ctx) {
      let session: OpencodeSession | null = null;
      let messages: OpencodeMessage[] = [];
      let diff: OpencodeSessionDiff | null = null;
      try {
        session = await input.client.session.get({ path: { id: args.id } });
        messages = await input.client.session.messages({ path: { id: args.id } });
        try {
          diff = await input.client.session.diff({ path: { id: args.id } });
        } catch {
          diff = null;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log("warn", "session.get/messages failed", { id: args.id, error: message });
        return err(`OpenCode SDK session load failed for ${args.id}: ${message}`);
      }
      if (!session) {
        return err(`Session not found: ${args.id}`);
      }
      const title = session.title ?? "";
      const ts = nowIso();
      const chunks = chunkSession(args.id, title, messages, diff, ts);
      return ok({
        ok: true,
        id: args.id,
        title,
        chunk_count: chunks.length,
        chunks,
      });
    },
  });

  const sessionSearch = tool({
    description:
      "Free-text search across captured Squish chunks. Returns the 3-10 most relevant chunks (decisions, summaries, file edits, errors) with similarity scores. Use when the user wants to find prior context on a topic.",
    args: {
      query: z.string().min(1).describe("Free-text search query."),
      chunk_type: z.enum(["summary", "decision", "command", "file", "error", "todo"])
        .optional()
        .describe("Restrict to one chunk type."),
      project: z.string().optional()
        .describe("Project path or name to scope the search to. Defaults to the current working directory."),
      limit: z.number().int().min(3).max(10).optional()
        .describe("Max chunks to return (default 8, max 10)."),
    },
    async execute(args, ctx) {
      const project = args.project ?? ctx.directory;
      const limit = args.limit ?? 8;
      const recallArgs = ["recall", args.query, "--project", project];
      if (args.chunk_type) recallArgs.push("--type", CHUNK_TO_MEMORY_TYPE[args.chunk_type]);
      const out = await runSquishJsonSafe(
        recallArgs,
        ctx.directory,
        input.client.app.log,
        { tool: "search", query: args.query, project },
      );
      if (out === null) {
        return err("squish recall failed");
      }
      // `squish recall` returns the compact { status, memories, missing } contract.
      const list: unknown = Array.isArray(out)
        ? out
        : (out as { memories?: unknown[] }).memories ?? out;
      const coverage = !Array.isArray(out) ? out as { status?: string; missing?: string[] } : {};
      const hits = filterToChunks(list, args.chunk_type, limit);
      return ok({
        ok: true,
        query: args.query,
        status: coverage.status,
        missing: coverage.missing ?? [],
        chunk_type: args.chunk_type ?? null,
        count: hits.length,
        chunks: hits,
      });
    },
  });

  const sessionCapture = tool({
    description:
      "Capture an explicit summary chunk into Squish memory for the current work. Use when the user wants to save a milestone, decision, or takeaway so it can be searched for later.",
    args: {
      summary: z.string().min(1).describe("Human-readable summary / takeaway to capture."),
      id: z.string().optional()
        .describe("Session id. Defaults to the current OpenCode session id."),
      title: z.string().optional().describe("Short human-readable title."),
      files: z.array(z.string().min(1)).optional()
        .describe("Optional file paths this chunk is associated with."),
      tags: z.array(z.string().min(1)).optional()
        .describe("Optional extra tags (e.g. ['refactor','auth'])."),
      project: z.string().optional()
        .describe("Project name. Defaults to the basename of the current working directory."),
    },
    async execute(args, ctx) {
      const sessionId = args.id ?? ctx.sessionID;
      const title = args.title ?? currentSessionTitle ?? "";
      const project = args.project ?? deriveProjectName(ctx.directory);
      const branch = await getBranch(input, ctx.directory);
      const ts = nowIso();

      // Build the rich tag list.
      const tags: string[] = [
        `squish_chunk:summary`,
        `squish_session:${sessionId}`,
        "agent:opencode",
      ];
      if (title) tags.push(`squish_session_title:${title}`);
      if (project) tags.push(`project:${project}`);
      if (branch) tags.push(`branch:${branch}`);
      if (ts) tags.push(`captured_at:${ts}`);
      if (args.files) {
        for (const f of args.files.slice(0, 20)) {
          tags.push(`file:${f}`);
        }
      }
      if (args.tags) {
        for (const t of args.tags) tags.push(t);
      }

      const rememberArgs = [
        "remember",
        args.summary,
        "--type",
        "note",
        "--tags",
        tags.join(","),
        "--project",
        ctx.directory,
        "--source",
        "opencode-plugin",
      ];
      const out = await runSquishJsonSafe(
        rememberArgs,
        ctx.directory,
        input.client.app.log,
        { tool: "capture", session_id: sessionId },
      );
      if (out === null) return err("squish remember failed");
      const saved = out as { ok?: boolean; id?: string; error?: string };
      if (saved.ok === false) {
        return err(saved.error ?? "squish remember returned not-ok");
      }
      return ok({
        ok: true,
        id: saved.id ?? null,
        session_id: sessionId,
        title,
        project,
        branch,
        captured_at: ts,
      });
    },
  });

  const sessionRelated = tool({
    description:
      "Find past OpenCode sessions related to the current work (by overlapping files or directory). For each related session, returns the top matching chunks. Use when starting work to surface prior decisions.",
    args: {
      files: z.array(z.string().min(1)).optional()
        .describe("File paths that anchor the search (e.g. files the user just opened)."),
      limit: z.number().int().min(1).max(20).optional()
        .describe("Max sessions to return (default 5)."),
      chunks_per_session: z.number().int().min(1).max(10).optional()
        .describe("Max chunks per session (default 3)."),
    },
    async execute(args, ctx) {
      const limit = args.limit ?? 5;
      const perSession = args.chunks_per_session ?? 3;
      let all: OpencodeSession[] = [];
      try {
        all = await input.client.session.list();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log("warn", "session.list failed for related", { error: message });
        return err(`OpenCode SDK session.list failed: ${message}`);
      }
      if (!Array.isArray(all) || all.length === 0) {
        return ok({ ok: true, count: 0, sessions: [] });
      }
      const anchorFiles = new Set((args.files ?? []).map((f) => f.toLowerCase()));
      const currentDir = (ctx.directory ?? "").toLowerCase();

      type Scored = { session: OpencodeSession; score: number; topChunks: Chunk[] };
      const scored: Scored[] = [];
      for (const s of all) {
        const sessionId = s.id;
        if (!sessionId) continue;
        let messages: OpencodeMessage[] = [];
        let diff: OpencodeSessionDiff | null = null;
        try {
          messages = await input.client.session.messages({ path: { id: sessionId } });
          try {
            diff = await input.client.session.diff({ path: { id: sessionId } });
          } catch {
            diff = null;
          }
        } catch (e) {
          // Skip sessions we can't read.
          continue;
        }
        const chunks = chunkSession(sessionId, s.title ?? "", messages, diff, nowIso());
        const chunkFiles = new Set<string>();
        for (const c of chunks) {
          for (const f of c.files) chunkFiles.add(f.toLowerCase());
        }
        let score = 0;
        // +1 per matching anchor file (case-insensitive).
        for (const f of chunkFiles) {
          if (anchorFiles.has(f)) score += 2;
        }
        // +0.5 if session's directory shares a prefix with current dir.
        const sdir = (s.directory ?? "").toLowerCase();
        if (currentDir && sdir && sdir === currentDir) score += 1;
        // +1 if session touched ANY file at all (light signal).
        if (chunkFiles.size > 0) score += 1;
        if (score === 0) continue;
        // Pick top-N chunks by file overlap with anchors, then by summary presence.
        const ranked = chunks
          .map((c) => {
            let local = 0;
            for (const f of c.files) {
              if (anchorFiles.has(f.toLowerCase())) local += 2;
            }
            if (c.type === "summary") local += 1;
            return { c, local };
          })
          .sort((a, b) => b.local - a.local)
          .slice(0, perSession)
          .map((x) => x.c);
        scored.push({ session: s, score, topChunks: ranked });
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, limit);
      return ok({
        ok: true,
        count: top.length,
        anchor_files: [...anchorFiles],
        sessions: top.map((t) => ({
          id: t.session.id,
          title: t.session.title ?? "",
          score: t.score,
          createdAt: t.session.createdAt ?? t.session.time?.created ?? null,
          chunks: t.topChunks,
        })),
      });
    },
  });

  // ---------------------------------------------------------------------
  // Legacy direct-CLI tools
  // ---------------------------------------------------------------------
  //
  // These four tools wrap the canonical `squish` CLI subcommands directly.
  // They existed in the legacy plugin and are restored here alongside the
  // session_* tools so the LLM can call them when it wants the underlying
  // memory primitives (remember/recall/context/stats) without going
  // through the OpenCode SDK layer.

  const squishRemember = tool({
    description:
      "Store a free-form memory into Squish. Use when the user wants to save a fact, observation, decision, task, or note that should be searchable later. Wraps `squish remember`.",
    args: {
      content: z.string().min(1).describe("The memory content to store."),
      type: z.enum(["observation", "note", "decision", "task", "context", "profile"])
        .optional()
        .describe("Memory type. Defaults to 'note'."),
      tags: z.array(z.string().min(1)).optional()
        .describe("Optional tags to attach to the memory."),
      project: z.string().optional()
        .describe("Project path. Defaults to the current OpenCode working directory."),
      source: z.string().optional()
        .describe("Source identifier. Defaults to 'opencode-plugin'."),
    },
    async execute(args, ctx) {
      const type = args.type ?? "note";
      const project = args.project ?? ctx.directory;
      const source = args.source ?? "opencode-plugin";
      const cliArgs: string[] = [
        "remember",
        args.content,
        "--type",
        type,
        "--project",
        project,
        "--source",
        source,
        "--json",
      ];
      if (args.tags && args.tags.length > 0) {
        cliArgs.push("--tags", args.tags.join(","));
      }
      const out = await runSquishJsonSafe(
        cliArgs,
        ctx.directory,
        input.client.app.log,
        { tool: "remember", project },
      );
      if (out === null) return err("squish remember failed");
      return ok(out);
    },
  });

  const squishRecall = tool({
    description:
      "Free-text search across all Squish memories (not just chunks). Returns matching memories with similarity scores. Use when the user wants to look something up that may live outside captured session chunks. Wraps `squish recall`.",
    args: {
      query: z.string().min(1).describe("Free-text search query."),
      project: z.string().optional()
        .describe("Project path to scope to. Defaults to the current working directory."),
      limit: z.number().int().min(1).max(50).optional()
        .describe("Max results to return (default 10, max 50)."),
    },
    async execute(args, ctx) {
      const project = args.project ?? ctx.directory;
      const limit = args.limit ?? 10;
      const out = await runSquishJsonSafe(
        ["recall", args.query, "--project", project, "--limit", String(limit), "--json"],
        ctx.directory,
        input.client.app.log,
        { tool: "recall", query: args.query, project },
      );
      if (out === null) return err("squish recall failed");
      // `squish recall` returns the compact { status, memories, missing } contract.
      const list: unknown = Array.isArray(out)
        ? out
        : (out as { memories?: unknown[] }).memories ?? out;
      const coverage = !Array.isArray(out) ? out as { status?: string; missing?: string[] } : {};
      const results = Array.isArray(list) ? list : [];
      return ok({
        ok: true,
        query: args.query,
        status: coverage.status,
        missing: coverage.missing ?? [],
        count: results.length,
        results,
      });
    },
  });

  const squishContext = tool({
    description:
      "Load the current project's Squish context: pinned memories, recent durable memories, sibling projects, and (optionally) per-tier counts. Use at the start of a task to see what Squish already knows about this repo. Wraps `squish context`.",
    args: {
      project: z.string().optional()
        .describe("Project path. Defaults to the current working directory."),
      limit: z.number().int().min(1).max(50).optional()
        .describe("Max memories to include in the context report (default 10)."),
      pinned: z.boolean().optional()
        .describe("Return pinned memories only instead of the full context."),
      tiers: z.boolean().optional()
        .describe("Return per-tier memory counts instead of the full context."),
      listProjects: z.boolean().optional()
        .describe("List all registered projects instead of loading context for the current one."),
    },
    async execute(args, ctx) {
      const project = args.project ?? ctx.directory;
      const limit = args.limit ?? 10;
      const cliArgs: string[] = ["context", "--project", project, "--limit", String(limit)];
      if (args.pinned) cliArgs.push("--pinned");
      if (args.tiers) cliArgs.push("--tiers");
      if (args.listProjects) cliArgs.push("--list-projects");
      cliArgs.push("--json");
      const out = await runSquishJsonSafe(
        cliArgs,
        ctx.directory,
        input.client.app.log,
        { tool: "context", project, pinned: !!args.pinned, tiers: !!args.tiers, listProjects: !!args.listProjects },
      );
      if (out === null) return err("squish context failed");
      return ok(out);
    },
  });

  const squishStats = tool({
    description:
      "Show Squish memory statistics (counts, sizes, tier breakdown) for a project or globally. Use when the user asks how much is stored. Wraps `squish stats`.",
    args: {
      project: z.string().optional()
        .describe("Project path. Omit to see global stats."),
    },
    async execute(args, ctx) {
      const cliArgs: string[] = ["stats"];
      if (args.project) cliArgs.push("--project", args.project);
      cliArgs.push("--json");
      const cwd = args.project ?? ctx.directory;
      const out = await runSquishJsonSafe(
        cliArgs,
        cwd,
        input.client.app.log,
        { tool: "stats", project: args.project ?? null },
      );
      if (out === null) return err("squish stats failed");
      return ok(out);
    },
  });

  // ---------------------------------------------------------------------
  // Event hook (session lifecycle -> chunk capture)
  // ---------------------------------------------------------------------

  const sessionIdFromEvent = (event: Record<string, unknown>): string | null => {
    if (typeof event.sessionID === "string") return event.sessionID;

    const properties = event.properties;
    if (!properties || typeof properties !== "object") return null;
    const info = (properties as Record<string, unknown>).info;
    if (!info || typeof info !== "object") return null;
    const id = (info as Record<string, unknown>).id;
    return typeof id === "string" ? id : null;
  };

  const eventHook: NonNullable<Hooks["event"]> = async ({ event }) => {
    const type = (event as { type?: unknown })?.type;
    if (typeof type !== "string") return;
    if (!autoCapture && !(autoInjectContext && type === "session.created")) return;

    const fire = (chunk: {
      type: ChunkType;
      content: string;
      session_id: string;
      session_title: string;
      project: string;
      repo_path: string;
      branch: string;
      agent_session_id: string;
      files?: string[];
      timestamp: string;
      source_event: string;
    }) => {
      // Fire-and-forget; captureChunk never throws.
      void captureChunk(chunk, input.directory, input.client.app.log);
    };

    try {
      switch (type) {
        case "session.created": {
          const id = sessionIdFromEvent(event);
          if (!id) break;
          if (autoCapture) {
            currentSessionID = id;
            currentSessionTitle = typeof event.title === "string" ? event.title : "";
            currentSessionCreated = nowIso();
            const branch = await getBranch(input, input.directory);
            const project = deriveProjectName(input.directory);
            fire({
              type: "summary",
              content: "(session started)",
              session_id: id,
              session_title: currentSessionTitle,
              project,
              repo_path: input.directory,
              branch,
              agent_session_id: id,
              timestamp: currentSessionCreated,
              source_event: "session.created",
            });
          }
          if (autoInjectContext) {
            void injectContextOnStart(input, id, input.directory, log);
          }
          break;
        }
        case "session.diff": {
          const id = typeof event.sessionID === "string" ? event.sessionID : currentSessionID;
          if (!id) break;
          const diff = event.diff;
          if (!diff || typeof diff !== "object") break;
          const files = Array.isArray(diff.files)
            ? diff.files.filter((f): f is string => typeof f === "string")
            : [];
          const branch = await getBranch(input, input.directory);
          const project = deriveProjectName(input.directory);
          for (const f of files) {
            fire({
              type: "file",
              content: `Edited: ${f}`,
              session_id: id,
              session_title: currentSessionTitle,
              project,
              repo_path: input.directory,
              branch,
              agent_session_id: id,
              files: [f],
              timestamp: nowIso(),
              source_event: "session.diff",
            });
          }
          break;
        }
        case "file.edited": {
          const id = currentSessionID;
          const file = typeof event.file === "string" ? event.file : null;
          if (!id || !file) break;
          const branch = await getBranch(input, input.directory);
          const project = deriveProjectName(input.directory);
          fire({
            type: "file",
            content: `Edited: ${file}`,
            session_id: id,
            session_title: currentSessionTitle,
            project,
            repo_path: input.directory,
            branch,
            agent_session_id: id,
            files: [file],
            timestamp: nowIso(),
            source_event: "file.edited",
          });
          break;
        }
        case "command.executed": {
          const id = typeof event.sessionID === "string" ? event.sessionID : currentSessionID;
          const args = event.arguments;
          const cmd = typeof args === "string"
            ? args
            : args !== undefined && args !== null
              ? JSON.stringify(args)
              : "(command)";
          if (!id) break;
          const branch = await getBranch(input, input.directory);
          const project = deriveProjectName(input.directory);
          fire({
            type: "command",
            content: cmd,
            session_id: id,
            session_title: currentSessionTitle,
            project,
            repo_path: input.directory,
            branch,
            agent_session_id: id,
            timestamp: nowIso(),
            source_event: "command.executed",
          });
          break;
        }
        case "session.idle": {
          const id = typeof event.sessionID === "string" ? event.sessionID : currentSessionID;
          if (!id) break;
          // Defer detailed chunking to a best-effort fetch of the message
          // history; if that fails we still capture a fallback summary.
          const branch = await getBranch(input, input.directory);
          const project = deriveProjectName(input.directory);
          let decisionSummary = "";
          try {
            const messages = await input.client.session.messages({
              path: { id: id },
            });
            const decisionChunks = chunkSession(
              id,
              currentSessionTitle,
              messages,
              null,
              nowIso(),
            ).filter((c) => c.type === "decision");
            for (const c of decisionChunks) {
              fire({
                type: "decision",
                content: c.content,
                session_id: id,
                session_title: currentSessionTitle,
                project,
                repo_path: input.directory,
                branch,
                agent_session_id: id,
                timestamp: c.timestamp,
                source_event: "session.idle",
              });
            }
            decisionSummary = decisionChunks.length > 0
              ? decisionChunks.map((c) => c.content).join(" | ")
              : "";
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            log("warn", "session.idle: messages fetch failed", { id, error: message });
          }
          fire({
            type: "summary",
            content: decisionSummary || "(no decisions captured)",
            session_id: id,
            session_title: currentSessionTitle,
            project,
            repo_path: input.directory,
            branch,
            agent_session_id: id,
            timestamp: nowIso(),
            source_event: "session.idle",
          });
          break;
        }
        case "session.error": {
          const id = typeof event.sessionID === "string" ? event.sessionID : currentSessionID;
          if (!id) break;
          const errObj = event.error;
          const errMsg =
            errObj && typeof errObj === "object" && typeof errObj.message === "string"
              ? errObj.message
              : "session error";
          const branch = await getBranch(input, input.directory);
          const project = deriveProjectName(input.directory);
          fire({
            type: "error",
            content: errMsg,
            session_id: id,
            session_title: currentSessionTitle,
            project,
            repo_path: input.directory,
            branch,
            agent_session_id: id,
            timestamp: nowIso(),
            source_event: "session.error",
          });
          break;
        }
        default:
          // Unhandled event type - intentionally ignored.
          break;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log("warn", `event hook (${type}) threw`, { error: message });
    }
  };

  return {
    tool: {
      squish_remember: squishRemember,
      squish_recall: squishRecall,
      squish_context: squishContext,
      squish_stats: squishStats,
      squish_session_list: sessionList,
      squish_session_show: sessionShow,
      squish_session_search: sessionSearch,
      squish_session_capture: sessionCapture,
      squish_session_related: sessionRelated,
    },
    event: eventHook,
  };
};

const plugin: PluginModule = {
  id: "squish-memory",
  server: SquishPlugin,
};

export default plugin;
