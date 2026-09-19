/**
 * Status Command - Show memory system health, stats, and graph info
 *
 * Usage:
 *   squish status
 *   squish status --verbose
 *   squish status --json
 */

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
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const stats = await client.getStats();

        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...stats }));
        } else {
          console.log(colors.bold('Memory System Status:\n'));
          console.log(`  Total memories:  ${colors.cyan(String(stats.totalMemories ?? 0))}`);
          console.log(`  Storage:         ${colors.cyan(stats.storagePath ?? 'unknown')}`);
          console.log(`  Backend:         ${colors.cyan(stats.backend ?? 'unknown')}`);
          if (stats.totalAssociations !== undefined) {
            console.log(`  Associations:    ${colors.cyan(String(stats.totalAssociations))}`);
          }
          if (stats.totalGraphEntities !== undefined) {
            console.log(`  Graph entities:  ${colors.cyan(String(stats.totalGraphEntities))}`);
          }
          if (stats.recentSessions !== undefined) {
            console.log(`  Recent sessions: ${colors.cyan(String(stats.recentSessions))}`);
          }
          if (stats.lastBackup) {
            console.log(`  Last backup:     ${colors.cyan(stats.lastBackup)}`);
          }
          console.log();
          if (options.verbose && stats.memoryTypes) {
            console.log(colors.bold('By type:'));
            for (const [type, count] of Object.entries(stats.memoryTypes)) {
              console.log(`  ${type}: ${colors.cyan(String(count))}`);
            }
            console.log();
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
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    });
}
