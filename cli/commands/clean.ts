/**
 * Clean Command - Memory maintenance and stale detection
 *
 * Usage:
 *   squish clean [--confirm] [--dry-run] [--steps dedup,stale,consolidate,inbox]
 *   squish clean --list-stale [--days 30] [--limit 20]
 */

import { Command } from 'commander';
import { client } from '../program.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerCleanCommand(program: Command): void {
  const cleanCommand = new Command('clean')
    .description('Run full memory maintenance: dedup + stale cleanup + consolidation + inbox triage')
    .option('--dry-run', 'Preview without making changes (default for safety)')
    .option('--steps <list>', 'Comma-separated: dedup,stale,consolidate,inbox (default: all)')
    .option('--age <days>', 'Age threshold for stale/consolidation in days (default: 30)')
    .option('--confirm', 'Actually run the maintenance (default: dry-run)')
    .option('--json', 'Emit machine-readable output', false)
    // Stale detection flags (absorbed from stale.ts)
    .option('-l, --list-stale', 'List stale memories without cleaning', false)
    .option('-d, --days <number>', 'Show memories older than N days (used with --list-stale)', '30')
    .option('-L, --limit <number>', 'Max stale memories to display (used with --list-stale)', '20')
    .option('-p, --project <project>', 'Project path (global if omitted)')
    .action(async (opts) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (opts.json) {
        process.env.SQUISH_QUIET = '1';
      }
      try {
        // --- Mode 1: List stale memories (absorbed from stale command) ---
        if (opts.listStale) {
          const days = parseInt(opts.days) || 30;
          const limit = parseInt(opts.limit) || 20;
          const cutoffDate = new Date(Date.now() - days * 86400000);
          const results = await client.getRecent(500, opts.project);

          const stale = results.filter((m: any) => {
            const created = m.createdAt ? new Date(m.createdAt) : null;
            const isOld = created && created < cutoffDate;
            const isLowConfidence = m.confidenceLevel === 'outdated' || m.confidenceLevel === 'speculative';
            const hasLowImportance = (m.importance || 50) < 40;
            return isOld || isLowConfidence || hasLowImportance;
          });

          const limited = stale.slice(0, limit);

          if (opts.json) {
            console.log(JSON.stringify({
              ok: true,
              totalStale: stale.length,
              count: limited.length,
              memories: limited
            }, null, 2));
            return;
          }

          console.log(`${colors.bold(`Stale memories (${stale.length} total):`)}\n`);
          limited.forEach((r: any, i: number) => {
            console.log(`${colors.green(`${i + 1}.`)} [${colors.yellow(r.type)}] ${r.content?.substring(0, 100)}...`);
            console.log(`   ID: ${colors.dim(r.id)} Created: ${colors.dim(r.createdAt || 'unknown')}\n`);
          });
          return;
        }

        // --- Mode 2: Full maintenance (existing clean command) ---
        const steps = opts.steps ? opts.steps.split(',').map((s: string) => s.trim()) : undefined;
        const result = (await client.runMaintenance({
          dryRun: !opts.confirm,
          steps: steps as any,
          age: opts.age ? parseInt(opts.age) : undefined,
          project: opts.project,
        })) as { dryRun: boolean; steps: Record<string, { ok: boolean; count: number; error?: string }> };

        if (opts.json) {
          console.log(JSON.stringify({ ...result, ok: true }, null, 2));
          return;
        }

        if (result.dryRun) {
          console.log('--- DRY RUN (no changes made) ---\n');
        }
        for (const [step, info] of Object.entries(result.steps)) {
          const icon = info.ok ? 'OK' : 'FAIL';
          console.log(`  ${step}: [${icon}] count=${info.count}${info.error ? ' error=' + info.error : ''}`);
        }
        if (result.dryRun) {
          console.log('\nRun with --confirm to actually apply changes.');
        }
      } catch (error: any) {
        const remediation = remediationFor(error);
        if (opts.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${remediation}`);
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

  program.addCommand(cleanCommand);
}
