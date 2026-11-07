/**
 * Status Command - Show memory system health, stats, and graph info
 *
 * Usage:
 *   squish status
 *   squish status --verbose
 *   squish status --json
 */

import { suppressQuietMode } from '../quiet-mode.js';
import { Command } from 'commander';
import { client } from '../client.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerStatusCommand(program: Command) {
  program
    .command('status')
    .description('Show memory system health and stats')
    .option('-v, --verbose', 'Show detailed information', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        const stats = await client.getStats();

        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...stats }));
        } else {
          console.log(colors.bold('Memory System Status:\n'));
          console.log(`  Total memories:  ${colors.cyan(String(stats.totalMemories ?? 0))}`);
          console.log(`  Project:         ${colors.cyan(stats.projectPath ?? 'unknown')}`);
          console.log(`  Mode:            ${colors.cyan(stats.mode ?? 'unknown')}`);
          if (stats.durableMemories !== undefined) {
            console.log(`  Durable:         ${colors.cyan(String(stats.durableMemories))}`);
          }
          if (stats.totalNotes !== undefined) {
            console.log(`  Notes:           ${colors.cyan(String(stats.totalNotes))}`);
          }
          if (stats.totalLearnings !== undefined) {
            console.log(`  Learnings:       ${colors.cyan(String(stats.totalLearnings))}`);
          }
          if (stats.totalLinks !== undefined) {
            console.log(`  Links:           ${colors.cyan(String(stats.totalLinks))}`);
          }
          if (stats.oldestMemory) {
            console.log(`  Oldest memory:   ${colors.cyan(stats.oldestMemory)}`);
          }
          if (stats.newestMemory) {
            console.log(`  Newest memory:   ${colors.cyan(stats.newestMemory)}`);
          }
          console.log();
          if (options.verbose) {
            const byType = stats.byType ?? {};
            const entries = Object.entries(byType);
            console.log(colors.bold('By type:'));
            if (entries.length === 0) {
              console.log('  (none)');
            }
            for (const [type, count] of entries) {
              console.log(`  ${type}: ${colors.cyan(String(count))}`);
            }
            console.log();
            if (stats.signal) {
              console.log(colors.bold('Capture signal:'));
              console.log(`  captured: ${colors.cyan(String(stats.signal.captured))}`);
              console.log(`  durable:  ${colors.cyan(String(stats.signal.durable))}`);
              console.log(`  tokens saved: ${colors.cyan(String(stats.signal.tokensSaved))}`);
              console.log();
            }
          }
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
}
