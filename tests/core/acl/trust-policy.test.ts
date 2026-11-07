import { describe, expect, it } from 'bun:test';
import { getRetrievalProfile } from '../../../core/retrieval/profiles.js';
import { getTrustPolicy, isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../../../core/acl/trust-policy.js';
import { withRequestPrincipal } from '../../../core/acl/request-principal.js';

describe('trust policy selection', () => {
  it('defaults to local-compatible independently of retrieval profile', () => {
    const env = { SQUISH_PROFILE: 'high-recall' } as NodeJS.ProcessEnv;
    expect(getTrustPolicy(env)).toBe('local-compatible');
    expect(isStrictTrustPolicy(env)).toBe(false);
    expect(getRetrievalProfile(env).name).toBe('high-recall');
  });

  it('selects strict trust independently of retrieval profile', () => {
    const env = { SQUISH_PROFILE: 'fast-local', SQUISH_TRUST_POLICY: ' Strict ' } as NodeJS.ProcessEnv;
    expect(getTrustPolicy(env)).toBe('strict');
    expect(isStrictTrustPolicy(env)).toBe(true);
    expect(getRetrievalProfile(env).name).toBe('fast-local');
  });

  it('rejects unknown policy values instead of silently disabling strict enforcement', () => {
    expect(() => getTrustPolicy({ SQUISH_TRUST_POLICY: 'strcit' } as NodeJS.ProcessEnv))
      .toThrow('SQUISH_TRUST_POLICY must be "local-compatible" or "strict"');
  });

  it('accepts the legacy local alias as local-compatible', () => {
    expect(getTrustPolicy({ SQUISH_TRUST_POLICY: ' Local ' } as NodeJS.ProcessEnv)).toBe('local-compatible');
  });

  it('uses the authenticated request principal and rejects a forged requested identity', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    delete process.env.SQUISH_TRUSTED_CALLER_ID;
    try {
      await withRequestPrincipal('team-user-a', async () => {
        expect(resolveTrustedCallerId()).toBe('team-user-a');
        expect(resolveTrustedCallerId('team-user-a')).toBe('team-user-a');
        expect(() => resolveTrustedCallerId('team-user-b')).toThrow(TrustBoundaryError);
      });
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('rejects request principals that conflict with a static server identity', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'fixed-user';
    try {
      await withRequestPrincipal('other-user', async () => {
        expect(() => resolveTrustedCallerId()).toThrow(TrustBoundaryError);
      });
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('clears an enclosing principal for an unauthenticated nested request', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    delete process.env.SQUISH_TRUSTED_CALLER_ID;
    try {
      await withRequestPrincipal('outer-user', async () => {
        await withRequestPrincipal(undefined, async () => {
          expect(() => resolveTrustedCallerId()).toThrow(TrustBoundaryError);
        });
      });
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('isolates identities across concurrent requests', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    delete process.env.SQUISH_TRUSTED_CALLER_ID;
    try {
      const identities = await Promise.all(['member-a', 'member-b'].map((principal) =>
        withRequestPrincipal(principal, async () => {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return resolveTrustedCallerId();
        }),
      ));
      expect(identities).toEqual(['member-a', 'member-b']);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });
});
