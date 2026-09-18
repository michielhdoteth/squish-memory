import { SquishRuntime } from '../core/runtime/squish-runtime.js';

/** Shared SDK client available to all command handlers. */
export const client = new SquishRuntime();

/** Alias so command modules can write `import { getClient } from './client.js'`. */
export { client as getClient };
