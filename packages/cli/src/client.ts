import { SquishClient } from '@squish/core-sdk';

/** Shared SDK client available to all command handlers. */
export const client = new SquishClient();

/** Alias so command modules can write `import { getClient } from './client.js'`. */
export { client as getClient };
