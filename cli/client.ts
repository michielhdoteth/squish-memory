import { SquishRuntime } from '../core/runtime/squish-runtime.js';

/** Shared SDK client available to all command handlers. */
export const client = new SquishRuntime();

/** Accessor so command modules can write `import { getClient } from './client.js'`. */
export function getClient(): SquishRuntime {
  return client;
}
