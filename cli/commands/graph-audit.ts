import { Command } from 'commander';
import { isStrictTrustPolicy } from '../../core/acl/trust-policy.js';
import { auditSupersessionCycles, repairSupersessionCycles } from '../../core/knowledge/supersession-audit.js';

function collectEdgeId(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function assertGraphAuditTrustAllowed(strict = isStrictTrustPolicy()): void {
  if (strict) {
    throw new Error('Graph cycle details are withheld under strict trust until graph provenance parity is supported');
  }
}

export function registerGraphAuditCommand(program: Command): void {
  program
    .command('graph-audit')
    .description('Audit current temporal supersession cycles and optionally repair selected edges')
    .option('--repair-edge <id>', 'Select a cycle edge to retract; may be repeated', collectEdgeId, [])
    .option('--apply', 'Apply a validated repair; without this flag the operation is a dry run', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: { repairEdge: string[]; apply: boolean; json: boolean }) => {
      try {
        assertGraphAuditTrustAllowed();
        if (options.apply && options.repairEdge.length === 0) {
          throw new Error('--apply requires one or more --repair-edge IDs from a prior audit');
        }
        const report = options.repairEdge.length > 0
          ? await repairSupersessionCycles(options.repairEdge, { apply: options.apply })
          : { ok: true, applied: false, cyclesBefore: await auditSupersessionCycles(), cyclesAfter: [], retractedEdgeIds: [] };
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else if (!report.ok) {
          console.error(`Cycle repair refused: ${report.error ?? 'unknown error'}`);
        } else if (report.cyclesBefore.length === 0 && report.retractedEdgeIds.length === 0) {
          console.log('No active supersession cycles found.');
        } else {
          console.log(JSON.stringify(report, null, 2));
          if (!report.applied && report.retractedEdgeIds.length > 0) {
            console.log('Review the cycle and selected edge IDs; repeat with --apply to retract them.');
          }
        }
        if (!report.ok) process.exitCode = 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
        else console.error(message);
        process.exitCode = 1;
      }
    });
}
