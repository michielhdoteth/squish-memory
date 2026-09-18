import { Command } from 'commander';

import { probeSchemaHealth } from '../db/schema-probe.js';
import { fixSchemaIssues } from '../db/schema-repair.js';
import { config } from '../config.js';

import { client } from './client.js';
export { client };

import { registerRememberCommand } from './commands/remember.js';
import { registerRecallCommand } from './commands/recall.js';
import { registerForgetCommand } from './commands/forget.js';
import { registerLinkCommand } from './commands/link.js';
import { registerCleanCommand } from './commands/clean.js';
import { registerRunCommand } from './commands/run.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerInstallCommand, registerUninstallCommand } from './commands/install.js';
import { registerPinCommand } from './commands/pin.js';
import { registerSessionsCommand } from './commands/sessions.js';
import { registerEditsCommand } from './commands/edits.js';
import { registerCloudCommand } from './commands/cloud.js';
import { registerStatusCommand } from './commands/status.js';
import { registerContextCommand } from './commands/context.js';
import { registerStaleReportCommand } from './commands/stale-report.js';
import { registerBackupCommand } from './commands/backup.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('squish')
    .description('Universal Memory for AI Agents - CLI')
    .version('2.0.0');

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    const commandName = actionCommand.name();
    const exempt = new Set(['doctor', 'install', 'install-plugin', 'uninstall', 'pin', 'sessions', 'cloud', 'backup']);
    if (exempt.has(commandName)) return;

    const probe = await probeSchemaHealth();
    if (probe.status === 'ok') return;

    // Auto-migrate if SQUISH_AUTO_MIGRATE=true
    if (probe.status === 'drifted' && config.autoMigrate) {
      try {
        const actions = await fixSchemaIssues({ fixAll: true, verbose: false });
        if (actions.length > 0) {
          const recheck = await probeSchemaHealth();
          if (recheck.status === 'ok') {
            return; // Auto-migration succeeded, continue with command
          }
        }
      } catch {
        // Fall through to error below
      }
    }

    const errorPayload = {
      ok: false,
      error: probe.status === 'drifted' ? 'schema_drift' : 'database_unavailable',
      backend: probe.backend,
      detail: probe.detail,
      missingTables: probe.missingTables,
      remediation: probe.remediation,
    };

    const jsonFlag = actionCommand.opts()?.json === true;
    const text = JSON.stringify(errorPayload, null, 2);
    if (jsonFlag) {
      console.log(text);
    } else {
      console.error(text);
    }
    if (probe.status === 'drifted') {
      console.error(`Schema needs migration. Run 'squish doctor --fix' to update.`);
      if (config.autoMigrate) {
        console.error(`(SQUISH_AUTO_MIGRATE is set but auto-migration did not fully resolve the drift)`);
      }
    }
    process.exit(1);
  });

  registerRememberCommand(program);
  registerRecallCommand(program);
  registerForgetCommand(program);
  registerLinkCommand(program);
  registerCleanCommand(program);
  registerRunCommand(program);
  registerDoctorCommand(program);
  registerInstallCommand(program);
  registerUninstallCommand(program);
  registerPinCommand(program);
  registerSessionsCommand(program);
  registerEditsCommand(program);
  registerCloudCommand(program);
  registerStatusCommand(program);
  registerContextCommand(program);
  registerStaleReportCommand(program);
  registerBackupCommand(program);

  return program;
}
