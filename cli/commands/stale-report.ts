/**
 * Stale Report Command - Generate a read-only staleness report
 *
 * Usage:
 *   squish stale-report [--days 30] [--limit 200] [--output stale-report.md]
 *
 * Delegates to core/memory/staleness-report.ts so the CLI and the MCP
 * squish_stale_report tool share one staleness definition.
 */

import { Command } from 'commander';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerStaleReportCommand(program: Command) {
  program
    .command('stale-report')
    .description('Generate a read-only report of stale memories grouped by attribution')
    .option('-d, --days <number>', 'Show memories older than N days', '30')
    .option('-l, --limit <number>', 'Max memories to scan', '200')
    .option('-o, --output <file>', 'Output file (default: stdout)')
    .option('-p, --project <project>', 'Project path')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const { buildStalenessReport } = await import('../../core/memory/staleness-report.js');
        const report = await buildStalenessReport({
          projectId: options.project,
          olderThanDays: parseInt(options.days) || 30,
          limit: parseInt(options.limit) || 200,
        });

        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...report }, null, 2));
          return;
        }

        const lines: string[] = [];
        lines.push(`# Stale Memory Report`);
        lines.push(`Generated: ${report.generatedAt}`);
        lines.push(`Threshold: older than ${parseInt(options.days) || 30} days`);
        lines.push(`Groups: ${report.groups.length}`);
        lines.push('');

        for (const group of report.groups) {
          lines.push(`## ${group.group} (${group.count})`);
          lines.push(group.digest);
          for (const item of group.items) {
            lines.push(`- ${item.memoryId} -> ${item.suggestedAction}`);
          }
          lines.push('');
        }

        const text = lines.join('\n');

        if (options.output) {
          const fs = await import('node:fs');
          fs.writeFileSync(options.output, text);
          console.log(`${colors.green('OK')} Report written to ${options.output}`);
        } else {
          console.log(text);
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
