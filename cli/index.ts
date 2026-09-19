import { createProgram } from './program.js';

const program = createProgram();

// Default: show help if no arguments
if (process.argv.length === 2) {
  await program.parseAsync(['node', 'squish', '--help']);
} else {
  await program.parseAsync();
}

process.exit(0);
