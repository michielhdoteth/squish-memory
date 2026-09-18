/**
 * Status Command - Show launch readiness, stats, projects, pinned, and tiers
 *
 * Usage:
 *   squish status [--json] [--pretty]
 *   squish status --stats [--project /path]
 *   squish status --projects
 *   squish status --pinned [--project /path]
 *   squish status --tiers [--project /path]
 */

import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { probeSchemaHealth } from '../../../../db/schema-probe.js';
import { allAgentStores } from '../../../../core/sessions/agent-stores/registry.js';
import { buildStatsState } from '../../../../core/runtime/trust-state.js';
import { formatStatsReport } from '../../../../core/runtime/trust-report.js';
import { buildContextState, resolveProjectScope } from '../../../../core/runtime/trust-state.js';
import { formatContextReport } from '../../../../core/runtime/trust-report.js';
import { client } from '../program.js';
import { colors } from '../colors.js';

interface CloudAuth {
  email: string;
  projectName?: string;
  cloudUrl?: string;
}

const AUTH_FILE = path.join(os.homedir(), '.squish', 'auth.json');

function loadCloudAuth(): CloudAuth | null {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as CloudAuth;
  } catch {
    return null;
  }
}

function outputJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function outputPretty(lines: string[]): void {
  process.stdout.write(lines.join('\n') + '\n');
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show launch readiness, stats, projects, pinned, or tier info for Squish')
    .option('--json', 'Emit machine-readable output', false)
    .option('--pretty', 'Human-readable output', false)
    // Stats flags (absorbed from stats command)
    .option('--stats', 'Show memory statistics')
    // Context flags (absorbed from context command)
    .option('--context', 'Show full project context (memories, beliefs, signals)')
    .option('--projects', 'List registered projects')
    .option('--pinned', 'Show pinned memories')
    .option('--tiers', 'Show memory count per tier')
    .option('--list-projects', 'Alias for --projects')
    // Shared flags
    .option('-p, --project <project>', 'Project path')
    .option('--limit <number>', 'Max memories to return (for context)', '10')
    .action(async (opts: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (opts.json) {
        process.env.SQUISH_QUIET = '1';
      }
      try {
        // ── Mode 1: Stats (absorbed from stats command) ───────────────────
        if (opts.stats) {
          const stats = await buildStatsState(opts.project);
          if (opts.json) {
            console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
            return;
          }
          console.log(colors.bold('Memory Statistics'));
          console.log(colors.dim('─'.repeat(40)));
          console.log(formatStatsReport(stats));
          return;
        }

        // ── Mode 2: Tiers (absorbed from context --tiers) ─────────────────
        if (opts.tiers) {
          const tiers = await client.getTierStats(opts.project);
          if (opts.json) {
            console.log(JSON.stringify({ ok: true, tiers }, null, 2));
            return;
          }
          console.log('Memory tiers:');
          for (const [tier, count] of Object.entries(tiers)) {
            console.log(`  ${tier}: ${count}`);
          }
          const total = Object.values(tiers).reduce((a, b) => a + b, 0);
          console.log(`  total: ${total}`);
          return;
        }

        // ── Mode 3: Pinned (absorbed from context --pinned) ───────────────
        if (opts.pinned) {
          const pinned = await client.getPinnedMemories(opts.project);
          if (opts.json) {
            console.log(JSON.stringify({ ok: true, count: pinned.length, pinned }, null, 2));
            return;
          }
          if (pinned.length === 0) {
            console.log('No pinned memories found.');
            return;
          }
          console.log(`Pinned memories (${pinned.length}):\n`);
          for (const m of pinned) {
            const content = (m.content || '(no content)').substring(0, 200);
            const tags = m.tags ? ` [${m.tags.join(', ')}]` : '';
            console.log(`  ${m.id}${tags}`);
            console.log(`  -> ${content}`);
            console.log();
          }
          return;
        }

        // ── Mode 4: Projects (absorbed from context --list-projects) ──────
        if (opts.projects || opts.listProjects) {
          const projects = await client.listProjects();
          const scope = await resolveProjectScope(opts.project);
          const payload = {
            ok: true,
            count: projects.length,
            currentProject: scope.currentProject,
            otherProjects: scope.otherProjects,
            projects: projects.map((project: any) => ({
              id: project.id,
              name: project.name,
              path: project.path,
              resolution: project.path === '.' ? 'legacy-placeholder' : (project.metadata?.source === 'mcp' ? 'auto-created' : 'inferred'),
            })),
            nextStep: scope.nextStep,
          };
          if (opts.json) {
            console.log(JSON.stringify(payload, null, 2));
            return;
          }
          console.log(colors.bold('Project Context'));
          console.log(colors.dim('─'.repeat(40)));
          console.log(formatContextReport({
            currentProject: scope.currentProject,
            otherProjects: scope.otherProjects,
            runtime: {
              sessionSummary: 'Project listing only',
              activePlaces: [],
              signalSummary: { captured: 0, suppressed: 0, sessionOnly: 0, durable: 0, durableWithRaw: 0 },
              graphSummary: 'Not loaded in list-only mode',
            },
            durableMemories: [],
            nextStep: scope.nextStep,
          }));
          return;
        }

        // ── Mode 5: Full context (absorbed from context command) ──────────
        if (opts.context) {
          const context = await buildContextState(opts.project, parseInt(opts.limit) || 10);
          if (opts.json) {
            console.log(JSON.stringify({ ok: true, ...context }, null, 2));
            return;
          }
          console.log(colors.bold('Project Context'));
          console.log(colors.dim('─'.repeat(40)));
          console.log(formatContextReport(context));
          return;
        }

        // ── Default: Basic status (original status command) ───────────────
        const schema = await probeSchemaHealth();
        const stores = await Promise.all(
          allAgentStores().map(async (store) => {
            const status = await store.status();
            return {
              name: store.name,
              available: Boolean(status),
              path: status?.path,
              sessions: status?.sessions,
              messages: status?.messages,
              parts: status?.parts,
            };
          })
        );
        const cloud = loadCloudAuth();

        const payload = {
          ok: true,
          schema: {
            status: schema.status,
            detail: schema.detail,
          },
          cloud: cloud
            ? {
                connected: true,
                email: cloud.email,
                projectName: cloud.projectName ?? null,
                cloudUrl: cloud.cloudUrl ?? null,
              }
            : {
                connected: false,
              },
          stores,
        };

        if (opts.pretty) {
          outputPretty([
            `Schema: ${schema.status}`,
            `Cloud: ${cloud ? `connected (${cloud.email})` : 'disconnected'}`,
            ...stores.map((store: any) =>
              store.available
                ? `Store ${store.name}: available (${store.sessions ?? 0} sessions)`
                : `Store ${store.name}: unavailable`
            ),
          ]);
          return;
        }

        outputJson(payload);
      } catch (error: any) {
        if (opts.json) {
          console.error(JSON.stringify({ ok: false, error: error.message }));
        } else {
          console.error(`Error: ${error.message}`);
        }
        process.exit(1);
      } finally {
        if (opts.json) {
          if (previousQuiet === undefined) {
            delete process.env.SQUISH_QUIET;
          } else {
            process.env.SQUISH_QUIET = previousQuiet;
          }
        }
      }
    });
}
