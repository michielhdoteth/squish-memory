/**
 * Forget Command - Delete memory
 *
 * Usage: squish forget <memoryId> [--confirm] [--older-than "30 days"]
 */

import { Command } from 'commander';
import { client } from '../program.js';
import { filterByDateRange } from '../../core/lib/utils.js';
import { getProjectByPath } from '../../core/projects.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

/** Commander options for `squish forget`. */
interface ForgetOptions {
  olderThan?: string;
  search?: string;
  type?: string;
  confirm?: boolean;
  includeGlobal?: boolean;
  limit?: string;
  project?: string;
  json?: boolean;
}

/**
 * Fail closed on a bulk forget. Prints the error payload and exits 1 so no
 * deletion is attempted once ownership cannot be trusted.
 */
function abort(options: ForgetOptions, message: string, detail: string, remediation: string): never {
  const payload = {
    ok: false,
    error: message,
    detail,
    command: 'forget',
    remediation,
  };
  console.error(
    options.json
      ? JSON.stringify(payload, null, 2)
      : `${colors.red('Error')}: ${message}\nDetail: ${detail}\nHint: ${remediation}`
  );
  process.exit(1);
}

export function registerForgetCommand(program: Command) {
  program
    .command('forget <memoryId>')
    .description('Delete memory (single or bulk with --older-than --search)')
    .option('--older-than <period>', 'Bulk delete memories older than')
    .option('--search <query>', 'Search query to match specific memories')
    .option('--type <type>', 'Filter by memory type')
    .option('--confirm', 'Actually delete (default is dry-run)', false)
    .option('--include-global', 'Bulk delete: also delete matched shared global memories (no project). Without it, global matches are reported but never deleted.', false)
    .option('-l, --limit <number>', 'Max memories to delete', '100')
    .option('-p, --project <project>', 'Project path (global if omitted)')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (memoryId: string, options: ForgetOptions) => {
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
        const memoryRecords = results.map(r => r.memory);
        const hitIds = options.olderThan
          ? new Set(
              filterByDateRange(
                memoryRecords.map((m) => ({
                  id: m.id,
                  createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt ?? null,
                })),
                '',
                options.olderThan
              ).map((m) => m.id)
            )
          : null;
        const matchedIds = memoryRecords
          .map((m) => m.id)
          .filter((id) => hitIds === null || hitIds.has(id));

        // Partition the hits before anything is deleted.
        //
        // Search is project-scoped PLUS global (`project_id IS NULL`), so a
        // project-scoped bulk forget also matches every global row. `forget` ->
        // deleteMemoryPermanently deletes by id with NO project check, so
        // deleting every hit would permanently destroy shared context that
        // belongs to no single project and that every agent sharing this
        // database can see.
        //
        // Ownership is read from the memories table rather than from the search
        // result shape: which search leg produced a result decides which fields
        // its representation carries, so `result.memory.project` is not a
        // reliable discriminator. getMemoriesByIds reads the authoritative
        // project_id.
        //
        // Three buckets: rows owned by the resolved project (always deletable),
        // global rows (deletable only with an explicit --include-global), and
        // rows owned by anything else, which this bulk path never deletes.
        // Without --project there is no project scope, so nothing is
        // project-owned and only globals are reachable, and only on opt-in.
        let ownershipById = new Map<string, string | null>();
        let resolvedProjectId: string | null = null;
        try {
          if (options.project) {
            const project = await getProjectByPath(options.project);
            resolvedProjectId = project?.id ?? null;
          }
          const owned = await client.getMemoriesByIds(matchedIds);
          ownershipById = new Map(owned.map((row) => [row.id, row.project ?? null]));
        } catch (error) {
          // Ownership could not be established, so nothing can be safely
          // classified as the caller's own. Fail closed: no deletion.
          abort(options, 'Bulk delete aborted; nothing was deleted',
            error instanceof Error ? error.message : String(error),
            'Retry the dry run. If it persists, delete memories one at a time by id.');
        }

        const unresolved = matchedIds.filter((id) => !ownershipById.has(id));
        if (unresolved.length > 0) {
          abort(options, 'Bulk delete aborted; ownership could not be resolved for every hit',
            `${unresolved.length} of ${matchedIds.length} matched memories have no readable project owner`,
            'Retry the dry run. If it persists, delete memories one at a time by id.');
        }

        const projectIds = matchedIds.filter(
          (id) => resolvedProjectId !== null && ownershipById.get(id) === resolvedProjectId
        );
        const globalIds = matchedIds.filter((id) => ownershipById.get(id) === null);
        const foreignCount = matchedIds.length - projectIds.length - globalIds.length;
        const includeGlobal = options.includeGlobal === true;
        const skippedGlobal = includeGlobal ? 0 : globalIds.length;
        const deletableIds = includeGlobal ? [...projectIds, ...globalIds] : projectIds;

        const deleted: string[] = [];
        const skippedChangedScope: string[] = [];
        if (options.confirm) {
          for (const id of deletableIds) {
            const removed = await client.forget(id, { expectedProjectId: ownershipById.get(id) ?? null });
            if (removed) deleted.push(id);
            else skippedChangedScope.push(id);
          }
        }

        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            matched: matchedIds.length,
            matchedProject: projectIds.length,
            matchedGlobal: globalIds.length,
            skippedOtherProject: foreignCount,
            deleted: deleted.length,
            skippedGlobal,
            skippedChangedScope: skippedChangedScope.length,
            dryRun: !options.confirm,
            message: !options.confirm
              ? (skippedGlobal > 0
                ? `Dry run. ${projectIds.length} project memory/memories would be deleted; ${globalIds.length} shared global memory/memories are excluded unless you re-run with --include-global.`
                : 'Dry run. Re-run with --confirm to execute.')
              : (skippedGlobal > 0
                ? `${deleted.length} project memory/memories deleted; ${globalIds.length} shared global memory/memories were excluded.`
                : `${deleted.length} memories deleted.`),
          }, null, 2));
        } else {
          console.log(`${colors.bold('Matched')} ${matchedIds.length}: ${colors.green(String(projectIds.length))} project, ${colors.yellow(String(globalIds.length))} shared global, ${colors.dim(String(foreignCount))} other project`);
          if (!options.confirm) {
            console.log(`${colors.yellow('DRY RUN')} Would delete ${colors.bold(String(projectIds.length + skippedGlobal))} memories. Use --confirm to apply.`);
          } else {
            console.log(`${colors.green('OK')} Deleted ${colors.bold(String(deleted.length))} memories`);
          }
          if (skippedChangedScope.length > 0) {
            console.log(`${colors.yellow('SKIPPED')} ${skippedChangedScope.length} memories whose project changed during deletion; recheck the scope and retry.`);
          }
          if (skippedGlobal > 0) {
            console.log(`${colors.yellow('SKIPPED')} ${skippedGlobal} shared global memories. Pass --include-global to delete them.`);
          }
          if (foreignCount > 0) {
            console.log(`${colors.dim(`${foreignCount} memories owned by another project are never deleted by this bulk path.`)}`);
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
