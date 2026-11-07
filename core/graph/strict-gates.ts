import { denyStrictSurface } from '../acl/trust-audit.js';

/**
 * Deny unscoped graph projection operations before reads, writes, or provider
 * calls. The preamble (resolve caller or minimize to `unbound`, audit, throw)
 * is `denyStrictSurface`; this module owns the graph wording and the
 * `operation:resource` compound id.
 */
export async function denyUnscopedGraphOperation(operation: string, resourceId: string): Promise<void> {
  await denyStrictSurface(
    `${operation}:${resourceId}`,
    'graph_operation',
    `Unscoped graph operation '${operation}' is disabled under strict trust`,
  );
}
