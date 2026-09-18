/**
 * Recall Command - Get memory by ID, search, export, or list recent
 *
 * Usage:
 *   squish recall "query-or-uuid" [--pretty]
 *   squish recall --format markdown|json|csv [--output file] [--limit N]
 *   squish recall --recent [days] [--limit N]
 */

import { Command } from 'commander';
import { client } from '../program.js';
import { shouldReturnRawFallback } from '../../core/ingestion/signal-engine.js';
import { getMemorySnapshot } from '../../core/snapshots/retrieval.js';
import { filterByDateRange } from '../../core/lib/utils.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

// --- Formatting helpers (absorbed from export.ts) ---

function formatMemories(memories: any[], format: string): string {
  switch (format) {
    case 'json':
      return JSON.stringify(memories.map(m => ({
        id: m.id,
        type: m.type,
        content: m.content,
        summary: m.summary,
        tags: m.tags,
        importance: m.importance,
        confidenceLevel: m.confidenceLevel,
        place: m.place,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt
      })), null, 2);

    case 'csv': {
      const headers = ['id', 'type', 'content', 'summary', 'tags', 'importance', 'confidenceLevel', 'place', 'createdAt', 'updatedAt'];
      const rows = memories.map(m => [
        m.id,
        m.type,
        `"${(m.content || '').replace(/"/g, '""')}"`,
        `"${(m.summary || '').replace(/"/g, '""')}"`,
        `"${(m.tags || []).join(';')}"`,
        m.importance || '',
        m.confidenceLevel || '',
        m.place || '',
        m.createdAt || '',
        m.updatedAt || ''
      ].join(','));
      return [headers.join(','), ...rows].join('\n');
    }

    case 'markdown':
    default:
      return memories.map(m => {
        const lines = [
          `## ${m.summary || m.content.slice(0, 60)}${m.content.length > 60 ? '...' : ''}`,
          '',
          `**Type:** ${m.type || 'unknown'}`,
          m.place ? `**Place:** ${m.place}` : null,
          m.confidenceLevel ? `**Confidence:** ${m.confidenceLevel}` : null,
          m.importance ? `**Importance:** ${m.importance.toFixed(2)}` : null,
          m.tags?.length ? `**Tags:** ${m.tags.join(', ')}` : null,
          '',
          m.content
        ].filter(Boolean);

        if (m.createdAt) {
          lines.push('', `*Created: ${new Date(m.createdAt).toISOString()}*`);
        }

        return lines.join('\n');
      }).join('\n\n---\n\n');
  }
}

// --- Recent helpers (absorbed from recent.ts) ---

const PERIOD_MAP: Record<string, [string, string]> = {
  today: ['today', 'now'],
  yesterday: ['yesterday', 'today'],
  thisweek: ['this week', 'now'],
  '7days': ['7 days', 'now'],
  '14days': ['14 days', 'now'],
  '30days': ['30 days', 'now'],
  '90days': ['90 days', 'now'],
};

// --- Command Registration ---

export function registerRecallCommand(program: Command) {
  program
    .command('recall [query]')
    .description('Search, get by ID, export, or list recent memories')
    .option('-t, --type <type>', 'Filter by memory type')
    .option('--place <place>', 'Filter by place (inbox, ref, wip, sandbox, board, sparks, archive)')
    .option('-l, --limit <number>', 'Max results', '5')
    .option('-P, --pretty', 'Human-friendly output', false)
    .option('-p, --project <project>', 'Project path')
    .option('--json', 'Emit machine-readable output', false)
    // Export flags (absorbed from export.ts)
    .option('-f, --format <format>', 'Export format: markdown, json, csv')
    .option('-o, --output <file>', 'Output file (default: stdout)')
    // Recent flags (absorbed from recent.ts)
    .option('--recent [period]', 'Show recent memories (today/yesterday/thisweek/7days/14days/30days/90days or Ndays)')
    .action(async (query: string | undefined, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) {
        process.env.SQUISH_QUIET = '1';
      }
      try {
        // --- Mode 1: Export (absorbed from export command) ---
        if (options.format) {
          const format = options.format.toLowerCase();
          if (!['markdown', 'json', 'csv'].includes(format)) {
            console.error(`Invalid format: ${format}. Use markdown, json, or csv.`);
            process.exit(1);
          }

          const limit = parseInt(options.limit) || 100;
          const searchResults = await client.search('*', { limit, project: options.project });
          const memories = searchResults.map((r: any) => r.memory ?? r);

          if (memories.length === 0) {
            if (options.json) {
              console.log(JSON.stringify({ ok: true, count: 0, results: [] }, null, 2));
            } else {
              console.log('No memories to export');
            }
            return;
          }

          const output = formatMemories(memories, format);

          if (options.output) {
            const fs = await import('node:fs');
            fs.writeFileSync(options.output, output);
            if (options.json) {
              console.log(JSON.stringify({ ok: true, exported: memories.length, file: options.output }, null, 2));
            } else {
              console.log(`Exported ${memories.length} memories to ${options.output}`);
            }
          } else {
            if (options.json) {
              console.log(JSON.stringify({
                ok: true,
                count: memories.length,
                results: memories.map((m: any) => ({
                  id: m.id,
                  type: m.type,
                  content: m.content,
                  summary: m.summary,
                  tags: m.tags,
                  importance: m.importance,
                  confidenceLevel: m.confidenceLevel,
                  place: m.place,
                  createdAt: m.createdAt,
                  updatedAt: m.updatedAt
                }))
              }, null, 2));
            } else {
              console.log(output);
            }
          }
          return;
        }

        // --- Mode 2: Recent (absorbed from recent command) ---
        if (options.recent !== undefined) {
          const period = options.recent === true ? 'today' : options.recent;
          const limit = parseInt(options.limit) || 10;
          const allRecent = await client.getRecent(500, options.project);

          const periodRange = PERIOD_MAP[period] || [period, 'now'];
          const [since, until] = periodRange;
          // SDK MemoryRecord has Date objects; filterByDateRange expects string ISO dates
          const allRecentWithStrings = allRecent.map(m => ({
            ...m,
            createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt ?? null,
          }));
          const filtered = filterByDateRange(allRecentWithStrings, since, until);
          const results = filtered.slice(0, limit);

          if (options.json) {
            console.log(JSON.stringify({
              ok: true,
              period,
              count: results.length,
              results
            }, null, 2));
            return;
          }

          if (options.pretty) {
            console.log(colors.bold(`\nRecent memories (${period}):\n`));
            results.forEach((r: any, i: number) => {
              console.log(`${colors.cyan(`${i + 1}.`)} [${colors.green(r.type)}] ${r.content?.substring(0, 100)}...`);
              console.log(`   ${colors.dim(r.createdAt || 'unknown')}\n`);
            });
          } else {
            console.log(`Recent memories (${period}):\n`);
            results.forEach((r: any, i: number) => {
              console.log(`${i + 1}. [${r.type}] ${r.content?.substring(0, 100)}...`);
              console.log(`   ${r.createdAt || 'unknown'}\n`);
            });
          }
          return;
        }

        // --- Mode 3: Standard recall (by UUID or text search) ---
        if (!query) {
          const payload = {
            ok: false,
            error: 'Provide a query, UUID, --format, or --recent',
            command: 'recall',
            remediation: 'Usage: squish recall "query" | squish recall <uuid> | squish recall --format json | squish recall --recent today',
          };
          console.error(options.json ? JSON.stringify(payload) : `${colors.red('Error')}: Provide a query, UUID, --format, or --recent\nHint: ${payload.remediation}`);
          process.exit(1);
        }

        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query);

        let result: any[];

        if (isUuid) {
          const memory = await client.getById(query);
          if (!memory) {
            const payload = { ok: false, error: 'Memory not found', command: 'recall', remediation: 'Check the ID or query, or run "squish recall" to find memories' };
            console.error(options.json ? JSON.stringify(payload) : `${colors.red('Error')}: Memory not found\nHint: Check the ID or query, or run "squish recall" to find memories`);
            process.exit(1);
          }
          result = [memory];
        } else {
          const limit = parseInt(options.limit) || 5;
          const searchResults = await client.search(query, {
            limit,
            project: options.project,
          });

          result = await Promise.all(searchResults.map(async (sr: any) => {
            const memory = sr.memory ?? sr;
            const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
            const rawFallbackSnapshotId = typeof metadata.rawFallbackSnapshotId === 'string'
              ? metadata.rawFallbackSnapshotId
              : typeof (metadata.signal as Record<string, unknown> | undefined)?.rawFallbackSnapshotId === 'string'
                ? String((metadata.signal as Record<string, unknown>).rawFallbackSnapshotId)
                : undefined;
            const nuanceSuppressed = Boolean(
              metadata.nuanceSuppressed ??
              (metadata.signal as Record<string, unknown> | undefined)?.nuanceSuppressed
            );

            if (shouldReturnRawFallback({
              query,
              hasRawFallback: Boolean(rawFallbackSnapshotId),
              nuanceSuppressed,
            }) && rawFallbackSnapshotId) {
              const snapshot = await getMemorySnapshot(rawFallbackSnapshotId);
              return {
                ...memory,
                rawFallback: snapshot?.content ?? null,
              };
            }

            return memory;
          }));
        }

        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            count: result.length,
            results: result.map((r: any) => ({
              id: r.id,
              type: r.type,
              content: r.content,
              tags: r.tags,
              similarity: r.similarity ?? r.score,
              createdAt: r.createdAt
            }))
          }, null, 2));
          return;
        }

        if (options.pretty) {
          console.log(colors.bold(`\nFound ${result.length} memories:\n`));
          result.forEach((r: any, i: number) => {
            console.log(`${colors.cyan(`${i + 1}.`)} [${colors.green(r.type)}] ${r.content?.substring(0, 100)}...`);
            console.log(`   Tags: ${colors.dim(r.tags?.join(', ') || 'none')}`);
            console.log(`   Similarity: ${colors.dim((r.similarity ?? r.score)?.toFixed(3) || 'N/A')}`);
            console.log(`   ID: ${colors.dim(r.id)}`);
            console.log(`   Created: ${colors.dim(r.createdAt || 'unknown')}\n`);
          });
        } else {
          // Default human-readable output
          console.log(`Found ${result.length} memories:\n`);
          result.forEach((r: any, i: number) => {
            console.log(`${i + 1}. [${r.type}] ${r.content?.substring(0, 100)}...`);
            console.log(`   ID: ${r.id}`);
            console.log(`   Created: ${r.createdAt || 'unknown'}\n`);
          });
        }
      } catch (error: any) {
        const remediation = remediationFor(error);
        const payload = {
          ok: false,
          error: error.message,
          command: 'recall',
          remediation,
        };
        console.error(options.json ? JSON.stringify(payload) : `${colors.red('Error')}: ${error.message}\nHint: ${remediation}`);
        process.exit(1);
      } finally {
        if (options.json) {
          if (previousQuiet === undefined) {
            delete process.env.SQUISH_QUIET;
          } else {
            process.env.SQUISH_QUIET = previousQuiet;
          }
        }
      }
    });
}
