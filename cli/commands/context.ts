/**
 * Context Command - Show relevant context for a topic or file
 *
 * Usage:
 *   squish context <topic>
 *   squish context --file <path>
 *   squish context <topic> --limit 10
 */

import { Command } from 'commander';
import { client } from '../client.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerContextCommand(program: Command) {
  program
    .command('context [topic]')
    .description('Show relevant context for a topic or file')
    .option('-f, --file <path>', 'Get context for a file')
    .option('-l, --limit <number>', 'Max results', '5')
    .option('-p, --project <project>', 'Project path')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (topic: string | undefined, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const query = topic || options.file || '';
        if (!query) {
          const payload = {
            ok: false,
            error: 'Provide a topic or --file',
            command: 'context',
            remediation: 'Usage: squish context "topic" or squish context --file <path>',
          };
          if (options.json) {
            console.error(JSON.stringify(payload));
          } else {
            console.error(`${colors.red('Error')}: Provide a topic or --file`);
          }
          process.exit(1);
        }

        const limit = parseInt(options.limit) || 5;
        const results = await client.search(query, { limit, project: options.project });

        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            query,
            count: results.length,
            results: results.map((r: any) => ({
              id: r.memory?.id ?? r.id,
              type: r.memory?.type ?? r.type,
              content: r.memory?.content ?? r.content,
              similarity: r.similarity,
              tags: r.memory?.tags ?? r.tags,
            })),
          }, null, 2));
        } else {
          console.log(colors.bold(`Context for "${query}":\n`));
          results.forEach((r: any, i: number) => {
            const mem = r.memory ?? r;
            console.log(`${colors.green(`${i + 1}.`)} [${colors.green(mem.type || 'unknown')}] ${mem.content?.substring(0, 100)}...`);
            console.log(`   Similarity: ${colors.dim((r.similarity ?? 0).toFixed(3))} | ID: ${colors.dim(mem.id)}`);
            if (mem.tags?.length) {
              console.log(`   Tags: ${colors.dim(mem.tags.join(', '))}`);
            }
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
    });
}
