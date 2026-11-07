import { isStrictTrustPolicy, TrustBoundaryError } from '../../../core/acl/trust-policy.js';

/** Merge handlers have no caller-scoped source/proposal contract yet. */
export function assertMergeWorkflowAvailable(): void {
  if (isStrictTrustPolicy()) {
    throw new TrustBoundaryError('Merge workflow handlers are disabled under strict trust until caller-scoped proposal and source authorization is implemented');
  }
}
