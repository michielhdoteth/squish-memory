/**
 * Link Command - Manage memory associations
 * 
 * Usage: squish link find <memoryId> [--depth 2]
 *        squish link add <fromId> <toId> [--type relates_to]
 */

import { Command } from 'commander';
import { createAssociation, getRelatedMemories } from '../../core/associations.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerLinkCommand(program: Command) {
  program
    .command('link <action> [args...]')
    .description('Manage links (find/add/list)')
    .option('-d, --depth <number>', 'Graph traversal depth', '2')
    .option('-t, --type <type>', 'Association type', 'relates_to')
    .option('-w, --weight <number>', 'Association weight', '0.5')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (action: string, args: string[], options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) {
        process.env.SQUISH_QUIET = '1';
      }
      try {
        if (action === 'find' && args[0]) {
          const related = await getRelatedMemories(args[0], options.depth * 5);
          if (options.json) {
            console.log(JSON.stringify({ ok: true, count: related.length, related }, null, 2));
          } else {
            console.log(`${colors.bold(`Found ${related.length} related memories:`)}\n`);
            related.forEach((r: any, i: number) => {
              console.log(`${colors.green(`${i + 1}.`)} ${colors.dim(r.id)} [${r.type}] ${r.content?.substring(0, 80)}...`);
            });
          }
        } else if (action === 'add' && args[0] && args[1]) {
          await createAssociation(args[0], args[1], options.type as any, options.weight);
          
          // Auto-update knowledge graph (fire-and-forget)
          try {
            const { addMemoryToGraph } = await import('../../core/graph/graph-builder.js');
            const [result1, result2] = await Promise.all([
              addMemoryToGraph(args[0]).catch(() => null),
              addMemoryToGraph(args[1]).catch(() => null)
            ]);
            if (result1 || result2) {
              if (!options.json) {
                console.error(colors.dim('[Graph] Updated graph for linked memories'));
              }
            }
          } catch (e) {
            // Ignore graph errors
          }
          
          if (options.json) {
            console.log(JSON.stringify({ ok: true, action: 'created', from: args[0], to: args[1], type: options.type }));
          } else {
            console.log(`${colors.green('OK')} Linked ${colors.dim(args[0])} -> ${colors.dim(args[1])} (${options.type})`);
          }
        } else {
          const payload = { ok: false, error: 'Usage: squish link find <id> OR squish link add <from> <to>', command: 'link' };
          console.error(options.json ? JSON.stringify(payload) : `${colors.red('Error')}: Usage: squish link find <id> OR squish link add <from> <to>`);
          process.exit(1);
        }
      } catch (error: any) {
        const remediation = remediationFor(error);
        const payload = {
          ok: false,
          error: error.message,
          command: 'link',
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
