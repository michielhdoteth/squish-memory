/**
 * Pin/Unpin Commands - Mark memories as pinned to prevent consolidation
 *
 * Usage: squish pin <memoryId>          # Toggles pin state
 *        squish pin <memoryId> --pin    # Force pin
 *        squish pin <memoryId> --unpin  # Force unpin
 *        squish promote <memoryId>      # Promote to sturdy tier
 */

import { Command } from 'commander';
import { pinMemory, unpinMemory } from '../../core/security/governance.js';
import { promoteToSturdy } from '../../core/memory/tiers.js';
import { getMemory } from '../../core/memory/memories.js';
import { remediationFor } from '../errors.js';

export function registerPinCommand(program: Command) {
  // squish pin <memoryId> (toggles by default)
  program
    .command('pin <memoryId>')
    .description('Toggle pin on a memory (prevents decay). Use --pin or --unpin to force direction')
    .option('--pin', 'Force pin (no toggle)', false)
    .option('--unpin', 'Force unpin (no toggle)', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (memoryId: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) {
        process.env.SQUISH_QUIET = '1';
      }
      try {
        const forcePin = options.pin === true;
        const forceUnpin = options.unpin === true;

        if (forcePin) {
          await pinMemory(memoryId);
          if (options.json) {
            console.log(JSON.stringify({ ok: true, pinned: true, memoryId }));
          } else {
            console.log(`Pinned: ${memoryId}`);
          }
          return;
        }

        if (forceUnpin) {
          await unpinMemory(memoryId);
          if (options.json) {
            console.log(JSON.stringify({ ok: true, pinned: false, memoryId }));
          } else {
            console.log(`Unpinned: ${memoryId}`);
          }
          return;
        }

        // Toggle: check current state
        const memory = await getMemory(memoryId, false);
        if (!memory) {
          const payload = { ok: false, error: `Memory not found: ${memoryId}`, command: 'pin', remediation: 'Check the ID or query, or run "squish recall" to find memories' };
          if (options.json) {
            console.error(JSON.stringify(payload));
          } else {
            console.error(`Memory not found: ${memoryId}`);
          }
          process.exit(1);
        }

        const currentlyPinned = !!(memory as any).isPinned;
        if (currentlyPinned) {
          await unpinMemory(memoryId);
          if (options.json) {
            console.log(JSON.stringify({ ok: true, pinned: false, memoryId }));
          } else {
            console.log(`Unpinned (was pinned): ${memoryId}`);
          }
        } else {
          await pinMemory(memoryId);
          if (options.json) {
            console.log(JSON.stringify({ ok: true, pinned: true, memoryId }));
          } else {
            console.log(`Pinned (was unpinned): ${memoryId}`);
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
          if (previousQuiet === undefined) {
            delete process.env.SQUISH_QUIET;
          } else {
            process.env.SQUISH_QUIET = previousQuiet;
          }
        }
      }
    });

  // squish promote <memoryId>
  program
    .command('promote <memoryId>')
    .description('Promote a memory to sturdy tier (pins it, prevents decay, boosts in search)')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (memoryId: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) {
        process.env.SQUISH_QUIET = '1';
      }
      try {
        const success = await promoteToSturdy(memoryId);
        if (options.json) {
          console.log(JSON.stringify({ ok: success, promoted: true, memoryId }));
        } else {
          if (success) {
            console.log(`Promoted to sturdy tier: ${memoryId}`);
          } else {
            console.error('Failed to promote memory');
            process.exit(1);
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
          if (previousQuiet === undefined) {
            delete process.env.SQUISH_QUIET;
          } else {
            process.env.SQUISH_QUIET = previousQuiet;
          }
        }
      }
    });
}
