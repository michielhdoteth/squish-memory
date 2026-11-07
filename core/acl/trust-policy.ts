/** Trust policy is independent from retrieval profile selection. */
import { getRequestPrincipal } from './request-principal.js';

export type TrustPolicy = 'local-compatible' | 'strict';

export function getTrustPolicy(env: NodeJS.ProcessEnv = process.env): TrustPolicy {
  const configured = env.SQUISH_TRUST_POLICY?.trim().toLowerCase();
  if (!configured || configured === 'local' || configured === 'local-compatible') return 'local-compatible';
  if (configured === 'strict') return 'strict';
  throw new Error('SQUISH_TRUST_POLICY must be "local-compatible" or "strict"');
}

export function isStrictTrustPolicy(env: NodeJS.ProcessEnv = process.env): boolean {
  return getTrustPolicy(env) === 'strict';
}

export class TrustBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustBoundaryError';
  }
}

/** Resolve request identity against the operator-bound principal in strict mode. */
export function resolveTrustedCallerId(
  requestedUserId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const requested = requestedUserId?.trim() || null;
  if (!isStrictTrustPolicy(env)) return requested;

  const transportPrincipal = env === process.env ? getRequestPrincipal() : null;
  const configuredPrincipal = env.SQUISH_TRUSTED_CALLER_ID?.trim() || null;
  if (transportPrincipal && configuredPrincipal && transportPrincipal !== configuredPrincipal) {
    throw new TrustBoundaryError('Strict trust policy rejected a transport principal that does not match the server-bound caller');
  }
  const trusted = transportPrincipal ?? configuredPrincipal;
  if (!trusted) {
    throw new TrustBoundaryError('Strict trust policy requires an authenticated transport principal or SQUISH_TRUSTED_CALLER_ID');
  }
  if (requested && requested !== trusted) {
    throw new TrustBoundaryError('Strict trust policy rejected a caller identity that does not match the authenticated principal');
  }
  return trusted;
}
