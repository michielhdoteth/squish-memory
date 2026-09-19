/**
 * Forget Command - Delete memory
 * 
 * Usage: squish forget <memoryId> [--confirm] [--older-than "30 days"]
 */

import { Command } from 'commander';
import { client } from '../program.js';
import { filterByDateRange } from '../../core/lib/utils.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerForgetCommand(program: Command) {
  program
    .command('forget <memoryId>')
    .description('Delete memory (single or bulk with --older-than --search)')
    .option('--older-than <period>', 'Bulk delete memories older than')
    .option('--search <query>', 'Search query to match specific memories')
    .option('--type <type>', 'Filter by memory type')
    .option('--confirm', 'Actually delete (default is dry-run)', false)
    .option('-l, --limit <number>', 'Max memories to delete', '100')
    .option('-p, --project <project>', 'Project path (global if omitted)')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (memoryId: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) {
        process.env.SQUISH_QUIET = '1';
      }
      try {
        if (memoryId && memoryId !== 'all') {
          await client.forget(memoryId);
          if (options.json) {
            console.log(JSON.stringify({ ok: true, deleted: 1, memoryId }));
          } else {
            console.log(`${colors.green('OK')} Deleted memory ${colors.dim(memoryId)}`);
          }
          return;
        }
        
        if (!options.olderThan && !options.search) {
          const payload = { 
            ok: false, 
            error: 'Provide memoryId or use --older-than / --search for bulk delete',
            command: 'forget',
            remediation: 'Run "squish forget <memoryId>" to delete a single memory, or use --older-than / --search for bulk delete',
          };
          console.error(options.json ? JSON.stringify(payload) : `${colors.red('Error')}: Provide memoryId or use --older-than / --search for bulk delete\nHint: ${payload.remediation}`);
          process.exit(1);
        }
        
        const results = await client.search(options.search || '', {
          project: options.project,
          limit: parseInt(options.limit) || 100,
        });
        
        // Extract memory records and apply date filter
        let memoryRecords = results.map(r => r.memory);
        if (options.olderThan) {
          memoryRecords = filterByDateRange(memoryRecords as any, '', options.olderThan);
        }
        
        const deleted = [];
        if (options.confirm) {
          for (const mem of memoryRecords) {
            await client.forget(mem.id);
            deleted.push(mem.id);
          }
        }
        
        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            matched: memoryRecords.length,
            deleted: deleted.length,
            dryRun: !options.confirm
          }, null, 2));
        } else {
          if (!options.confirm) {
            console.log(`${colors.yellow('DRY RUN')} Would delete ${colors.bold(String(memoryRecords.length))} memories. Use --confirm to apply.`);
          } else {
            console.log(`${colors.green('OK')} Deleted ${colors.bold(String(deleted.length))} memories`);
          }
        }
      } catch (error: any) {
        const remediation = remediationFor(error);
        const payload = {
          ok: false,
          error: error.message,
          command: 'forget',
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
