/**
 * Sessions Command - List, inspect, diff, or replay conversation sessions
 *
 * Usage:
 *   squish sessions list [--limit 20] [--has-transcript]
 *   squish sessions inspect <sessionId>
 *   squish sessions diff <sessionA> <sessionB>
 *   squish sessions replay <sessionId> [--format json|text]
 */

import { Command } from 'commander';
import { client } from '../program.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerSessionsCommand(program: Command) {
  program
    .command('sessions')
    .description('List, inspect, diff, or replay conversation sessions')
    .addHelpText('after', `
Examples:
  squish sessions list --limit 5
  squish sessions inspect session_abc123
  squish sessions diff session_abc session_def
  squish sessions replay session_abc
`)

    .command('list')
    .description('List recent sessions')
    .option('-l, --limit <number>', 'Max results', '20')
    .option('--has-transcript', 'Only sessions with transcripts')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const sessions = await client.listSessions({
          limit: options.limit ? Number(options.limit) : undefined,
          hasTranscript: options.hasTranscript || undefined,
        });

        if (options.json) {
          console.log(JSON.stringify({ ok: true, count: sessions.length, sessions }));
        } else {
          console.log(colors.bold(`Sessions (${sessions.length}):\n`));
          sessions.forEach((s: any, i: number) => {
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
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    })

    .command('inspect <sessionId>')
    .description('Show full session transcript and metadata')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (sessionId: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const session = await client.getSession(sessionId);
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
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    })

    .command('diff <sessionA> <sessionB>')
    .description('Compare two sessions')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (sessionA: string, sessionB: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const diff = await client.diffSessions(sessionA, sessionB);
        if (options.json) {
          console.log(JSON.stringify(diff));
        } else {
          console.log(JSON.stringify(diff, null, 2));
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
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    })

    .command('replay <sessionId>')
    .description('Replay a session transcript')
    .option('--format <format>', 'Output format: json, text', 'text')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (sessionId: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const replay = await client.replaySession(sessionId, { format: options.format });
        if (options.json) {
          console.log(JSON.stringify(replay));
        } else {
          console.log(JSON.stringify(replay, null, 2));
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
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    });
}
