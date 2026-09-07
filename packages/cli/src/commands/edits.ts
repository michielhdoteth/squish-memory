/**
 * Edits Command - Edit proposal workflow for memory corrections
 *
 * Usage:
 *   squish edits propose <memoryId> --proposed-content <content> --reason <reason>
 *   squish edits list [--memory-id <id>] [--status pending|approved|rejected|expired] [--limit 20]
 *   squish edits preview <proposalId>
 *   squish edits approve <proposalId> [--review-notes <notes>]
 *   squish edits reject <proposalId> [--review-notes <notes>]
 *   squish edits correct <memoryId> --proposed-content <content> --reason <reason>
 */

import { Command } from 'commander';
import { getClient } from '../client.js';
import { getRemediationForError } from '../errors.js';

export function registerEditsCommand(program: Command) {
  program
    .command('edits')
    .description('Edit proposal workflow for memory corrections')
    .addHelpText('after', `
Examples:
  squish edits propose mem_123 --proposed-content "new text" --reason "fix typo"
  squish edits list --status pending --limit 20
  squish edits preview proposal_abc
  squish edits approve proposal_abc --review-notes "looks good"
  squish edits reject proposal_abc --review-notes "stale"
  squish edits correct mem_123 --proposed-content "new text" --reason "learning signal"
`)

    .command('propose <memoryId>')
    .description('Stage an edit proposal for a memory')
    .requiredOption('--proposed-content <content>', 'Proposed new memory content')
    .requiredOption('--reason <reason>', 'Why this edit is needed')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (memoryId: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const client = getClient();
        const result = await client.createEditProposal({
          memoryId,
          proposedContent: options.proposedContent,
          reason: options.reason,
        });
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (error: any) {
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation: getRemediationForError(error) }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${getRemediationForError(error)}`);
        }
        process.exit(1);
      } finally {
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    })

    .command('list')
    .description('List edit proposals')
    .option('--memory-id <id>', 'Filter by memory ID')
    .option('--status <status>', 'Filter by status: pending|approved|rejected|expired')
    .option('--limit <number>', 'Max results', '20')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const client = getClient();
        const result = await client.listEditProposals({
          memoryId: options.memoryId,
          status: options.status,
          limit: options.limit ? Number(options.limit) : undefined,
        });
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (error: any) {
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation: getRemediationForError(error) }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${getRemediationForError(error)}`);
        }
        process.exit(1);
      } finally {
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    })

    .command('preview <proposalId>')
    .description('Preview before/after diff for a proposal')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (proposalId: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const client = getClient();
        const result = await client.previewEditProposal(proposalId);
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (error: any) {
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation: getRemediationForError(error) }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${getRemediationForError(error)}`);
        }
        process.exit(1);
      } finally {
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    })

    .command('approve <proposalId>')
    .description('Approve a pending edit proposal')
    .option('--review-notes <notes>', 'Optional review notes')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (proposalId: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const client = getClient();
        const result = await client.approveEditProposal(proposalId, options.reviewNotes);
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (error: any) {
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation: getRemediationForError(error) }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${getRemediationForError(error)}`);
        }
        process.exit(1);
      } finally {
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    })

    .command('reject <proposalId>')
    .description('Reject a pending edit proposal')
    .option('--review-notes <notes>', 'Optional review notes')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (proposalId: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const client = getClient();
        const result = await client.rejectEditProposal(proposalId, options.reviewNotes);
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (error: any) {
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation: getRemediationForError(error) }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${getRemediationForError(error)}`);
        }
        process.exit(1);
      } finally {
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    })

    .command('correct <memoryId>')
    .description('Apply a direct correction to a memory with undo snapshot')
    .requiredOption('--proposed-content <content>', 'Corrected memory content')
    .requiredOption('--reason <reason>', 'Why this correction is needed')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (memoryId: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const client = getClient();
        const result = await client.correctMemory(memoryId, options.proposedContent, options.reason);
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (error: any) {
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation: getRemediationForError(error) }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${getRemediationForError(error)}`);
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
