import { denyStrictSurface } from '../acl/trust-audit.js';

/**
 * Deny place operations that have no caller-scoped authorization contract.
 * The preamble is `denyStrictSurface`; this module owns the place wording and
 * the `operation:resource` compound id.
 */
export function denyUnscopedPlaceOperation(operation: string, resourceId: string): Promise<never> {
  return denyStrictSurface(
    `${operation}:${resourceId}`,
    'place',
    `Unscoped place operation '${operation}' is disabled under strict trust`,
  );
}
