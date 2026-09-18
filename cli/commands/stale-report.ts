/**
 * Stale Report Command - Generate a report of stale memories
 *
 * Usage:
 *   squish stale-report [--days 30] [--limit 20] [--output stale-report.md]
 */

import { Command } from 'commander';
import { client } from '../program.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerStaleReportCommand(program: Command) {
  program
    .command('stale-report')
    .description('Generate a report of stale memories')
    .option('-d, --days <number>', 'Show memories older than N days', '30')
    .option('-l, --limit <number>', 'Max memories to display', '20')
    .option('-o, --output <file>', 'Output file (default: stdout)')
    .option('-p, --project <project>', 'Project path')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const days = parseInt(options.days) || 30;
        const limit = parseInt(options.limit) || 20;
        const cutoffDate = new Date(Date.now() - days * 86400000);

        const results = await client.getRecent(500, options.project);

        const stale = results.filter((m: any) => {
          const created = m.createdAt ? new Date(m.createdAt) : null;
          const isOld = created && created < cutoffDate;
          const isLowConfidence = m.confidenceLevel === 'outdated' || m.confidenceLevel === 'speculative';
          const hasLowImportance = (m.importance || 50) < 40;
          return isOld || isLowConfidence || hasLowImportance;
        });

        const limited = stale.slice(0, limit);

        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            days,
            totalStale: stale.length,
            count: limited.length,
            memories: limited,
          }, null, 2));
          return;
        }

        const lines: string[] = [];
        lines.push(`# Stale Memory Report`);
        lines.push(`Generated: ${new Date().toISOString()}`);
        lines.push(`Threshold: older than ${days} days`);
        lines.push(`Total stale: ${stale.length} (showing ${limited.length})`);
        lines.push('');
        lines.push('| # | Type | Content | Created | ID |');
        lines.push('|---|------|---------|---------|-----|');

        limited.forEach((r: any, i: number) => {
          lines.push(`| ${i + 1} | ${r.type || '?'} | ${(r.content || '').substring(0, 60).replace(/\|/g, '/')}... | ${r.createdAt || 'unknown'} | ${r.id} |`);
        });

        if (stale.length > limit) {
          lines.push('');
          lines.push(`... and ${stale.length - limit} more`);
        }

        const report = lines.join('\n');

        if (options.output) {
          const fs = await import('node:fs');
          fs.writeFileSync(options.output, report);
          console.log(`${colors.green('OK')} Report written to ${options.output}`);
        } else {
          console.log(report);
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
