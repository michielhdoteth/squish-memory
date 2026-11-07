/**
 * Sessions Command - List, inspect, diff, or replay conversation sessions
 *
 * Usage:
 *   squish sessions list [--limit 20] [--has-transcript]
 *   squish sessions search <query> [--source <source>] [--project <path>]
 *   squish sessions capture <source> <sessionId>
 *   squish sessions inspect <sessionId>
 *   squish sessions diff <sessionA> <sessionB>
 *   squish sessions replay <sessionId> [--format json|text]
 */

import { suppressQuietMode } from '../quiet-mode.js';
import { Command, Option } from 'commander';
import { client } from '../client.js';
import type { SquishRuntime } from '../../core/runtime/squish-runtime.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';
import { ensureSidecarFts } from '../../core/sessions/agent-stores/opencode.js';

/**
 * Fail closed for a session capability the runtime does not implement.
 *
 * `diff` and `replay` are registered subcommands whose runtime methods never
 * existed (they are absent from core/ and from master), so both used to throw a
 * TypeError once they reached the call. Enabling either is one edit here plus the
 * runtime method it delegates to.
 */
function sessionCapabilityRequired(capability: string): never {
  throw new Error(
    `Session ${capability} is not available in this build: the runtime exposes no ${capability} capability`
  );
}

export function registerSessionsCommand(
  program: Command,
  runtime: SquishRuntime = client,
  buildOpenCodeIndex: typeof ensureSidecarFts = ensureSidecarFts,
) {
  const sessions = program
    .command('sessions')
    .description('List, inspect, diff, or replay conversation sessions')
    .addHelpText('after', `
Examples:
  squish sessions list --limit 5
  squish sessions index --source opencode  # Explicitly builds a resumable local index
  squish sessions inspect session_abc123
  squish sessions diff session_abc session_def
  squish sessions replay session_abc
`);

  sessions.command('list')
    .description('List recent sessions')
    .option('-l, --limit <number>', 'Max results', '20')
    .addOption(new Option('--source <source>', 'Source: all, opencode, claude-code, codex, gemini').choices(['all', 'opencode', 'claude-code', 'codex', 'gemini']).default('all'))
    .option('--project <path>', 'Limit results to a project directory')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        const listedSessions = await runtime.listSessions({
          limit: options.limit ? Number(options.limit) : undefined,
          source: options.source,
          project: options.project,
        });

        if (options.json) {
          console.log(JSON.stringify({ ok: true, count: listedSessions.length, sessions: listedSessions }));
        } else {
          console.log(colors.bold(`Sessions (${listedSessions.length}):\n`));
          listedSessions.forEach((s: any, i: number) => {
            console.log(`${colors.green(`${i + 1}.`)} ${colors.dim(s.id)} [${s.status || 'active'}] ${s.createdAt || 'unknown'}`);
            if (s.summary) console.log(`   ${s.summary.substring(0, 80)}`);
            console.log();
          });
        }
      } catch (error: any) {
        const remediation = remediationFor(error);
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${remediation}`);
        }
        process.exit(1);
      } finally {
        restoreQuiet();
      }
    });

  sessions.command('search <query>')
    .description('Search local agent transcripts across supported sources')
    .addOption(new Option('--source <source>', 'Source: all, opencode, claude-code, codex, gemini').choices(['all', 'opencode', 'claude-code', 'codex', 'gemini']).default('all'))
    .option('--project <path-or-name>', 'Limit to a project directory; OpenCode also accepts an exact project ID or name')
    .option('-l, --limit <number>', 'Max results', '20')
    .option('--scan-budget-sessions <number>', 'Maximum sessions to scan', '5000')
    .option('--scan-timeout-ms <number>', 'Maximum scan time in milliseconds', '7000')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (query, options) => {
      const result = await runtime.searchChunksDetailed(query, {
        source: options.source,
        project: options.project,
        limit: Number(options.limit),
        scanBudgetSessions: Number(options.scanBudgetSessions),
        scanTimeoutMs: Number(options.scanTimeoutMs),
      });
      if (options.json) {
        console.log(JSON.stringify({ ok: true, query, count: result.results.length, results: result.results, diagnostics: result.diagnostics }));
        return;
      }
      console.log(colors.bold(`Session matches (${result.results.length}):`));
      for (const [index, item] of result.results.entries()) {
        console.log(`${colors.green(`${index + 1}.`)} ${item.agent} ${colors.dim(item.sessionId)} [${item.type}]`);
        console.log(`   ${item.content}`);
      }
      if (result.diagnostics.opencode?.scopeError) {
        console.error(`OpenCode project scope error: ${result.diagnostics.opencode.scopeError}`);
      }
      // Diagnostics are reported per agent: a top-level truncated flag never
      // existed on the Partial<Record<AgentName, ...>> this returns.
      for (const [agent, diagnostics] of Object.entries(result.diagnostics)) {
        if (diagnostics?.truncated) {
          console.error(`Search was truncated for ${agent}: ${diagnostics.reason ?? 'scan limit reached'}`);
        }
      }
      if (!options.project
        && (options.source === 'all' || options.source === 'opencode')
        && result.diagnostics.opencode?.mode === 'session_scan') {
        console.error('OpenCode used a bounded database scan because its FTS index is missing or stale. Run `squish sessions index --source opencode` to build or refresh it; indexing reads the full database, can use substantial disk space, and resumes if interrupted.');
      }
    });

  sessions.command('index')
    .description('Explicitly build or resume the OpenCode FTS index; reads the full database')
    .addOption(new Option('--source <source>', 'Transcript source to index').choices(['opencode']).default('opencode'))
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: { source: 'opencode'; json?: boolean }) => {
      const startedAt = Date.now();
      if (!options.json) console.error('Indexing OpenCode sessions from the full local database. This yields between bounded batches, resumes if interrupted, and needs enough free disk space for a replacement index while the current index is retained.');
      const indexPath = await buildOpenCodeIndex();
      if (!indexPath) {
        const message = 'Could not build the OpenCode FTS index. Check that the OpenCode database is available and readable.';
        if (options.json) console.log(JSON.stringify({ ok: false, source: options.source, error: message }));
        else console.error(message);
        process.exitCode = 1;
        return;
      }
      const response = { ok: true, source: options.source, indexPath, durationMs: Date.now() - startedAt };
      console.log(options.json ? JSON.stringify(response) : `OpenCode session index ready (${(response.durationMs / 1000).toFixed(1)}s).`);
    });

  sessions.command('capture <source> <sessionId>')
    .description('Capture a local agent session into Squish memory')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (source, sessionId, options) => {
      if (!['opencode', 'claude-code', 'codex', 'gemini'].includes(source)) {
        throw new Error(`Unsupported source: ${source}`);
      }
      const memoryIds = await runtime.captureHostSession(source, sessionId);
      const response = { ok: true, source, sessionId, capturedCount: memoryIds.length, memoryIds };
      console.log(options.json ? JSON.stringify(response) : `Captured ${memoryIds.length} memories from ${source} session ${sessionId}.`);
    });

  sessions.command('inspect <sessionId>')
    .description('Show full session transcript and metadata')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (sessionId: string, options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        const session = await runtime.getSession(sessionId);
        if (!session) {
          const error = new Error(`Session not found: ${sessionId}`);
          (error as any).code = 'SESSION_NOT_FOUND';
          throw error;
        }
        if (options.json) {
          console.log(JSON.stringify(session));
        } else {
          console.log(JSON.stringify(session, null, 2));
        }
      } catch (error: any) {
        const remediation = remediationFor(error);
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${remediation}`);
        }
        process.exit(1);
      } finally {
        restoreQuiet();
      }
    });

  sessions.command('diff <sessionA> <sessionB>')
    .description('Compare two sessions')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (sessionA: string, sessionB: string, options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        sessionCapabilityRequired('diff');
      } catch (error: any) {
        const remediation = remediationFor(error);
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${remediation}`);
        }
        process.exit(1);
      } finally {
        restoreQuiet();
      }
    });

  sessions.command('replay <sessionId>')
    .description('Replay a session transcript')
    .option('--format <format>', 'Output format: json, text', 'text')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (sessionId: string, options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        sessionCapabilityRequired('replay');
      } catch (error: any) {
        const remediation = remediationFor(error);
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${remediation}`);
        }
        process.exit(1);
      } finally {
        restoreQuiet();
      }
    });
}
