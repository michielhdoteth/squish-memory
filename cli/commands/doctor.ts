/**
 * Doctor Command - Diagnose and repair memory system
 *
 * Usage:
 *   squish doctor
 *   squish doctor --fix
 *   squish doctor --migrate
 *   squish doctor --json
 */

import { Command } from 'commander';
import { probeSchemaHealth, ProbeResult } from '../../db/schema-probe.js';
import { runHealthChecks, type HealthReport } from '../../core/health-check.js';
import { migrateToLatest } from '../../db/schema-migrator.js';
import { fixSchemaIssues } from '../../db/schema-repair.js';
import { config } from '../../config.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerDoctorCommand(program: Command) {
  program
    .command('doctor')
    .description('Diagnose and repair memory system')
    .option('--fix', 'Attempt to fix found issues', false)
    .option('--migrate', 'Run database migration', false)
    .option('--json', 'Emit machine-readable output', false)
    .option('-v, --verbose', 'Show detailed information', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        // Run health checks
        const report = await runHealthChecks();
        const probe = await probeSchemaHealth();

        // Auto-fix if requested
        if (options.fix || options.migrate) {
          const actions = await fixSchemaIssues({
            fixAll: options.fix,
            verbose: options.verbose,
          });

          if (actions.length > 0) {
            const recheck = await probeSchemaHealth();
            if (recheck.status === 'ok') {
              console.log(colors.green('Schema repaired successfully'));
            } else {
              console.error(colors.red('Schema issues remain after repair attempt'));
            }
          } else {
            console.log(colors.green('No schema issues found'));
          }
        }

        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            healthy: report.healthy,
            probe: {
              status: probe.status,
              backend: probe.backend,
              detail: probe.detail,
              missingTables: probe.missingTables,
            },
            checks: report.checks,
          }, null, 2));
        } else {
          console.log(colors.bold('Doctor Report:\n'));
          console.log(`  Database:  ${colors.green(probe.backend)} (${probe.status})`);
          console.log(`  Schema:    ${probe.status === 'ok' ? colors.green('OK') : colors.red(probe.status)}`);
          if (probe.missingTables.length > 0) {
            console.log(`  Missing:   ${colors.red(probe.missingTables.join(', '))}`);
          }
          console.log();
          for (const check of report.checks) {
            const icon = check.ok ? colors.green('OK') : colors.red('FAIL');
            console.log(`  ${check.name}: [${icon}] ${check.message}`);
          }
          if (!report.healthy) {
            console.log();
            console.log(colors.yellow('Run "squish doctor --fix" to attempt automatic repair'));
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
