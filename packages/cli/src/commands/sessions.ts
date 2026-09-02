/**
 * Sessions Command - search / list / load / capture past AI coding sessions.
 *
 * The CLI is for HUMANS. The plugin uses its own LLM-invokable tools.
 * Search returns CHUNKS (3-10 matching pieces) not whole sessions.
 *
 * Three-tool mental model (v1.5.5):
 *   1. `squish sessions` (this CLI / `search` plugin tool) - past agent
 *      sessions via the agent-stores adapter layer (opencode.db today;
 *      claude-code / codex tomorrow).
 *   2. `squish_recall` / `squish search` - long-term memory DB.
 *   3. `squish_remember` / `squish remember` - store to long-term memory.
 *
 * Long-term memory is NOT part of the sessions surface. The sessions
 * surface exclusively returns past agent sessions from one of the
 * registered agent stores. Use `squish remember` / `squish recall` for
 * long-term memory operations.
 *
 * Subcommands:
 *   squish sessions list [--limit N] [--project PATH] [--directory PATH]
 *                        [--source opencode|claude-code|codex|gemini|all] [--db-path PATH]
 *                        [--json|--pretty]
 *   squish sessions show <id> [--source ...] [--db-path PATH] [--json|--pretty]
 *   squish sessions search <query> [--chunk-type type] [--project PATH]
 *                              [--directory PATH] [--source ...] [--db-path PATH]
 *                              [--limit N] [--depth text|deep]
 *                              [--json|--pretty]
 *   squish sessions capture <summary> [--id ID] [--title TITLE] [--project PATH]
 *                                  [--agent A] [--agent-session-id SID] [--json]
 *   squish sessions related [--file path1,path2] [--repo-path PATH] [--limit N]
 *                           [--source ...] [--db-path PATH] [--json|--pretty]
 *   squish sessions status [--json|--pretty]
 *
 * All commands default to --json output. Pass --pretty for human-readable.
 */

import { randomUUID } from 'node:crypto';
import { Command } from 'commander';

import {
  captureChunk,
  findRelatedSessions,
  formatChunkResults,
  formatSessionDetail,
  formatSessionList,
  getSessionChunks,
  listSessions,
  makeSummaryChunk,
  searchChunks,
  type AgentId,
  type Chunk,
  type SessionGroup,
  type SessionSource,
} from '../../../../core/sessions/index.js';

import { allAgentStores } from '../../../../core/sessions/agent-stores/registry.js';

function parseCsv(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const VALID_SOURCES: readonly SessionSource[] = ['opencode', 'claude-code', 'codex', 'gemini', 'all'];

function parseSource(input: string | undefined): SessionSource {
  if (!input) return 'all';
  // Friendly alias: 'claude' -> canonical 'claude-code'
  const normalized = input === 'claude' ? 'claude-code' : input;
  if ((VALID_SOURCES as readonly string[]).includes(normalized)) return normalized as SessionSource;
  fail(`unknown source '${input}'. Available: ${VALID_SOURCES.join(', ')}`);
}

function outputJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function outputPretty(text: string): void {
  process.stdout.write(text + '\n');
}

function fail(message: string, extra: Record<string, unknown> = {}): never {
  process.stderr.write(JSON.stringify({ ok: false, error: message, ...extra }) + '\n');
  process.exit(1);
}

function asAgent(v: string | undefined, fallback: AgentId = 'cli'): AgentId {
  const allowed: AgentId[] = ['opencode', 'claude-code', 'openclaw', 'codex', 'gemini', 'cli', 'manual'];
  if (!v) return fallback;
  return allowed.includes(v as AgentId) ? (v as AgentId) : fallback;
}

/* ------------------------------------------------------------------ */
/* Subcommand implementations                                         */
/* ------------------------------------------------------------------ */

interface CommonOpts {
  source?: string;
  dbPath?: string;
  json?: boolean;
  pretty?: boolean;
}

async function runList(opts: {
  limit?: string;
  project?: string;
  directory?: string;
  source?: string;
  dbPath?: string;
  json?: boolean;
  pretty?: boolean;
}): Promise<void> {
  const limit = opts.limit ? parseInt(opts.limit, 10) || 20 : 20;
  const source = parseSource(opts.source);
  const result = await listSessions({
    limit,
    project: opts.project,
    source,
    opencode_db_path: opts.dbPath,
    directory_glob: opts.directory,
  });

  if (opts.pretty) {
    outputPretty(formatSessionList(result.sessions));
    if (result.sources.opencode > 0) {
      const oc = result.opencode;
      if (oc.ok) {
        process.stdout.write(
          `\n(${result.sources.opencode} opencode (from ${oc.session_count} total in ${oc.path}))\n`
        );
      } else {
        process.stdout.write(`\n(opencode: ${oc.error ?? 'not found'})\n`);
      }
    } else {
      process.stdout.write(`\n(no sessions found)\n`);
    }
    return;
  }
  outputJson({ ok: true, count: result.sessions.length, ...result });
}

async function runShow(
  id: string,
  opts: { source?: string; dbPath?: string; json?: boolean; pretty?: boolean }
): Promise<void> {
  const source = parseSource(opts.source);
  const session = await getSessionChunks(id, { source, opencode_db_path: opts.dbPath });
  if (!session) fail(`Session not found: ${id}`);
  if (opts.pretty) {
    outputPretty(formatSessionDetail(session));
    return;
  }
  outputJson({ ok: true, session });
}

async function runSearch(
  query: string,
  opts: {
    chunkType?: string;
    project?: string;
    directory?: string;
    source?: string;
    dbPath?: string;
    depth?: string;
    limit?: string;
    json?: boolean;
    pretty?: boolean;
  }
): Promise<void> {
  const limit = opts.limit ? parseInt(opts.limit, 10) || 8 : 8;
  const source = parseSource(opts.source);
  const depth = opts.depth === 'deep' ? 'deep' : 'text';
  const chunk_type = (opts.chunkType ?? undefined) as Chunk['type'] | undefined;
  const results = await searchChunks({
    query,
    limit,
    project: opts.project,
    repo_path: opts.directory,
    chunk_type,
    source,
    opencode_db_path: opts.dbPath,
  });

  if (opts.pretty) {
    outputPretty(formatChunkResults(results));
    return;
  }
  outputJson({
    ok: true,
    count: results.length,
    source,
    results: results.map((r) => ({
      score: r.score,
      memory_id: r.memory_id,
      why: r.why,
      chunk: r.chunk,
    })),
  });
}

async function runCapture(
  summary: string,
  opts: {
    id?: string;
    title?: string;
    project?: string;
    repoPath?: string;
    branch?: string;
    agent?: string;
    agentSessionId?: string;
    json?: boolean;
  }
): Promise<void> {
  const sessionId = opts.id ?? randomUUID();
  const project = opts.project ?? process.cwd();
  const title = opts.title ?? summary.split('\n')[0].slice(0, 80);
  const agent = asAgent(opts.agent);
  const agentSessionId = opts.agentSessionId ?? `cli-${Date.now()}`;

  const chunk: Chunk = makeSummaryChunk({
    session_id: sessionId,
    title,
    firstUserMessage: summary,
    project,
    repo_path: opts.repoPath ?? project,
    branch: opts.branch ?? '',
    agent,
    agent_session_id: agentSessionId,
    timestamp: new Date().toISOString(),
  });
  const memoryId = await captureChunk(chunk, { project });

  outputJson({ ok: true, id: sessionId, memory_id: memoryId, chunk });
}

async function runRelated(
  id: string | undefined,
  opts: {
    file?: string;
    repoPath?: string;
    source?: string;
    dbPath?: string;
    limit?: string;
    json?: boolean;
    pretty?: boolean;
  }
): Promise<void> {
  const files = parseCsv(opts.file);
  const source = parseSource(opts.source);

  // If the user gave an id, derive the repo path from the session itself
  // (works for both squish-stored sessions and opencode.db sessions).
  let repoPath = opts.repoPath ?? process.cwd();
  let sourceSession: SessionGroup | null = null;
  if (id) {
    const { getSessionChunks } = await import(
      '../../../../core/sessions/store.js'
    );
    const group = await getSessionChunks(id, {
      source,
      opencode_db_path: opts.dbPath,
    });
    if (group) {
      sourceSession = group;
      repoPath = group.repo_path || repoPath;
    } else {
      // Try opencode directly
      const { getOpenCodeSession } = await import(
        '../../../../core/sessions/opencode-store.js'
      );
      const oc = getOpenCodeSession(id, opts.dbPath ? { dbPath: opts.dbPath } : undefined);
      if (oc) {
        sourceSession = oc;
        repoPath = oc.repo_path || repoPath;
      } else {
        fail(`Session not found: ${id}`);
      }
    }
  }

  const limit = opts.limit ? parseInt(opts.limit, 10) || 5 : 5;
  const results = await findRelatedSessions({
    repo_path: repoPath,
    files,
    limit,
    source,
    opencode_db_path: opts.dbPath,
  });

  if (opts.pretty) {
    const sessions: SessionGroup[] = results.map((r) => r.session);
    if (sourceSession) {
      outputPretty(
        `Source: ${sourceSession.title || sourceSession.session_id}  (${sourceSession.repo_path})\n`
      );
    }
    outputPretty(formatSessionList(sessions));
    return;
  }
  outputJson({
    ok: true,
    source: sourceSession
      ? {
          session_id: sourceSession.session_id,
          title: sourceSession.title,
          repo_path: sourceSession.repo_path,
        }
      : null,
    repo_path: repoPath,
    count: results.length,
    results: results.map((r) => ({
      score: r.score,
      session: r.session,
      matching_chunks: r.matching_chunks,
    })),
  });
}

async function runStatus(opts: { json?: boolean; pretty?: boolean }): Promise<void> {
  const stores = allAgentStores();

  const results: Array<{
    name: string;
    available: boolean;
    path?: string;
    size?: number;
    sessions?: number;
    messages?: number;
    parts?: number;
    error?: string;
  }> = [];

  for (const store of stores) {
    const st = await store.status();
    if (st) {
      results.push({
        name: store.name,
        available: true,
        path: st.path,
        size: st.size,
        sessions: st.sessions,
        messages: st.messages,
        parts: st.parts,
      });
    } else {
      results.push({
        name: store.name,
        available: false,
      });
    }
  }

  if (opts.pretty) {
    const lines: string[] = ['Agent stores:'];
    for (const r of results) {
      if (r.available) {
        const mb = r.size ? (r.size / 1_000_000).toFixed(1) + ' MB' : '?';
        lines.push(
          [
            `  ${r.name}:`,
            `    path:     ${r.path ?? '?'}`,
            `    size:     ${mb}`,
            `    sessions: ${r.sessions ?? 0}`,
            `    messages: ${r.messages ?? 0}`,
            `    parts:    ${r.parts ?? 0}`,
          ].join('\n')
        );
      } else {
        lines.push(`  ${r.name}: not available`);
      }
    }
    outputPretty(lines.join('\n'));
    return;
  }

  outputJson({ ok: true, stores: results });
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerSessionsCommand(program: Command): void {
  const sessions = program
    .command('sessions')
    .description('Search, list, show, and capture past AI coding sessions (opencode, claude-code, codex)');

  sessions
    .command('list')
    .description('List past sessions across all registered agent stores')
    .option('-l, --limit <n>', 'Max results', '20')
    .option('-p, --project <path>', 'Filter results by project')
    .option('-d, --directory <path>', 'Filter opencode results by directory substring')
    .option('-s, --source <src>', 'opencode | claude-code | codex | all (default: all)', 'all')
    .option('--db-path <path>', 'Override opencode.db path')
    .option('--json', 'Emit JSON (default)', false)
    .option('--pretty', 'Human-readable output', false)
    .action(async (opts: any) => {
      try {
        await runList(opts);
      } catch (err: any) {
        fail(err?.message ?? String(err));
      }
    });

  sessions
    .command('show <id>')
    .description('Show all chunks for a session')
    .option('-s, --source <src>', 'opencode | claude-code | codex | all (default: all)', 'all')
    .option('--db-path <path>', 'Override opencode.db path')
    .option('--json', 'Emit JSON (default)', false)
    .option('--pretty', 'Human-readable output', false)
    .action(async (id: string, opts: any) => {
      try {
        await runShow(id, opts);
      } catch (err: any) {
        fail(err?.message ?? String(err));
      }
    });

  sessions
    .command('search <query>')
    .description('Search chunks (returns 3-10 matching pieces, not whole sessions)')
    .option('--chunk-type <type>', 'summary|decision|command|file|error|todo')
    .option('-p, --project <path>', 'Restrict squish results to one project')
    .option('-d, --directory <path>', 'Restrict opencode results to one directory')
    .option('-s, --source <src>', 'opencode | claude-code | codex | all (default: all)', 'all')
    .option('--db-path <path>', 'Override opencode.db path')
    .option('--depth <depth>', 'text (fast) | deep (all parts, slower)', 'text')
    .option('-l, --limit <n>', 'Max results (default 8, max 10)', '8')
    .option('--json', 'Emit JSON (default)', false)
    .option('--pretty', 'Human-readable output', false)
    .action(async (query: string, opts: any) => {
      try {
        await runSearch(query, opts);
      } catch (err: any) {
        fail(err?.message ?? String(err));
      }
    });

  sessions
    .command('capture <summary>')
    .description('Capture a session summary chunk (creates or uses --id)')
    .option('--id <id>', 'Session id (generates one if not provided)')
    .option('--title <title>', 'Human-readable title')
    .option('-p, --project <name>', 'Project name')
    .option('--repo-path <path>', 'Absolute path to repo root')
    .option('--branch <branch>', 'Git branch at capture time')
    .option('--agent <agent>', 'opencode|claude-code|openclaw|codex|cli|manual', 'cli')
    .option('--agent-session-id <sid>', 'Source agent session id')
    .option('--json', 'Emit JSON (default)', false)
    .action(async (summary: string, opts: any) => {
      try {
        await runCapture(summary, opts);
      } catch (err: any) {
        fail(err?.message ?? String(err));
      }
    });

  sessions
    .command('related [id]')
    .description(
      'Find past sessions related to a repo and files. With [id], derive the repo from that session. ' +
        'Without [id], use --repo-path or cwd.'
    )
    .option('--file <paths>', 'Comma-separated files of interest')
    .option('--repo-path <path>', 'Absolute repo path (default: cwd)')
    .option('-s, --source <src>', 'opencode | claude-code | codex | all (default: all)', 'all')
    .option('--db-path <path>', 'Override opencode.db path')
    .option('-l, --limit <n>', 'Max results (default 5)', '5')
    .option('--json', 'Emit JSON (default)', false)
    .option('--pretty', 'Human-readable output', false)
    .action(async (id: string | undefined, opts: any) => {
      try {
        await runRelated(id, opts);
      } catch (err: any) {
        fail(err?.message ?? String(err));
      }
    });

  sessions
    .command('status')
    .description('Show status for all registered agent stores (opencode, claude-code, codex)')
    .option('--json', 'Emit JSON (default)', false)
    .option('--pretty', 'Human-readable output', false)
    .action(async (opts: any) => {
      try {
        await runStatus(opts);
      } catch (err: any) {
        fail(err?.message ?? String(err));
      }
    });
}
