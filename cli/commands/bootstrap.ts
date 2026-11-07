import { suppressQuietMode } from '../quiet-mode.js';
import { Command, InvalidArgumentError } from 'commander';
import {
  bootstrapDesktopRuntime,
  DESKTOP_BOOTSTRAP_CONTRACT_VERSION,
  DesktopBootstrapError,
} from '../../core/runtime/desktop-bootstrap.js';

function parseContractVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new InvalidArgumentError('Contract version must be a positive integer.');
  }
  return version;
}

/** Machine-readable, versioned first-run bootstrap for desktop hosts. */
export function registerBootstrapCommand(program: Command): void {
  program
    .command('bootstrap')
    .description('Initialize the local Squish runtime for a desktop host')
    .requiredOption('--contract-version <version>', 'Desktop bootstrap protocol version', parseContractVersion)
    .action(async (options: { contractVersion: number }) => {
      const restoreQuiet = suppressQuietMode(true);
      try {
        const result = await bootstrapDesktopRuntime({ contractVersion: options.contractVersion });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } catch (error) {
        const payload = {
          ok: false,
          contractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION,
          error: {
            code: error instanceof DesktopBootstrapError ? error.code : 'bootstrap_failed',
            message: error instanceof Error ? error.message : 'Desktop bootstrap failed.',
            supportedContractVersions: [DESKTOP_BOOTSTRAP_CONTRACT_VERSION],
          },
        };
        process.stdout.write(`${JSON.stringify(payload)}\n`);
        process.exit(1);
      } finally {
        restoreQuiet();
      }
    });
}
