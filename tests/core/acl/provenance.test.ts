import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { signGraphRelationProvenance, signMemoryProvenance, verifyGraphRelationProvenance, verifyMemoryProvenance } from '../../../core/acl/provenance.js';

describe('memory provenance signatures', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const record = { content: 'Use Bun for local tests', projectId: 'project-a', type: 'preference' };

  it('signs a versioned canonical record and verifies with its key id', () => {
    const signature = signMemoryProvenance(record, {
      SQUISH_PROVENANCE_PRIVATE_KEY: privatePem,
      SQUISH_PROVENANCE_KEY_ID: 'key-a',
    });
    expect(signature).toMatchObject({ version: 1, keyId: 'key-a' });
    expect(verifyMemoryProvenance({ ...record, metadata: { __squishProvenance: signature } }, {
      SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'key-a': publicPem }),
    })).toBe(true);
  });

  it('rejects unsigned, modified, and unknown-key records', () => {
    const signature = signMemoryProvenance(record, {
      SQUISH_PROVENANCE_PRIVATE_KEY: privatePem,
      SQUISH_PROVENANCE_KEY_ID: 'key-a',
    });
    expect(verifyMemoryProvenance(record, {})).toBe(false);
    expect(verifyMemoryProvenance({ ...record, content: 'changed', metadata: { __squishProvenance: signature } }, {
      SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'key-a': publicPem }),
    })).toBe(false);
    expect(verifyMemoryProvenance({ ...record, metadata: { __squishProvenance: signature } }, {
      SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'key-b': publicPem }),
    })).toBe(false);
  });

  it('supports a key-rotation overlap and rejects retired keys after overlap', () => {
    const previousPair = generateKeyPairSync('ed25519');
    const nextPair = generateKeyPairSync('ed25519');
    const previousPrivate = previousPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const previousPublic = previousPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const nextPublic = nextPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const previousSignature = signMemoryProvenance(record, {
      SQUISH_PROVENANCE_PRIVATE_KEY: previousPrivate,
      SQUISH_PROVENANCE_KEY_ID: 'previous-key',
    });
    const signedRecord = { ...record, metadata: { __squishProvenance: previousSignature } };

    expect(verifyMemoryProvenance(signedRecord, {
      SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'previous-key': previousPublic, 'next-key': nextPublic }),
    })).toBe(true);
    expect(verifyMemoryProvenance(signedRecord, {
      SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'next-key': nextPublic }),
    })).toBe(false);
  });

  it('treats the configured public-key set as authoritative over the legacy single-key fallback', () => {
    const retiredPair = generateKeyPairSync('ed25519');
    const nextPair = generateKeyPairSync('ed25519');
    const retiredPrivate = retiredPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const retiredPublic = retiredPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const nextPublic = nextPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const retiredSignature = signMemoryProvenance(record, {
      SQUISH_PROVENANCE_PRIVATE_KEY: retiredPrivate,
      SQUISH_PROVENANCE_KEY_ID: 'retired-key',
    });
    const signedRecord = { ...record, metadata: { __squishProvenance: retiredSignature } };

    expect(verifyMemoryProvenance(signedRecord, {
      SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'next-key': nextPublic }),
      SQUISH_PROVENANCE_KEY_ID: 'retired-key',
      SQUISH_PROVENANCE_PUBLIC_KEY: retiredPublic,
    })).toBe(false);
  });

  it('does not restore a retired graph key through the legacy single-key fallback', () => {
    const retiredPair = generateKeyPairSync('ed25519');
    const nextPair = generateKeyPairSync('ed25519');
    const retiredPrivate = retiredPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const retiredPublic = retiredPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const nextPublic = nextPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const relation = {
      fromId: 'entity-a', fromKind: 'entity', toId: 'entity-b', toKind: 'entity',
      edgeType: 'version_of', weight: 3,
      metadata: { sourceMemoryIds: ['memory-a'] },
    };
    const signature = signGraphRelationProvenance(relation, {
      SQUISH_PROVENANCE_PRIVATE_KEY: retiredPrivate,
      SQUISH_PROVENANCE_KEY_ID: 'retired-key',
    });

    expect(verifyGraphRelationProvenance({
      ...relation,
      metadata: { ...relation.metadata, __squishGraphProvenance: signature },
    }, {
      SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'next-key': nextPublic }),
      SQUISH_PROVENANCE_KEY_ID: 'retired-key',
      SQUISH_PROVENANCE_PUBLIC_KEY: retiredPublic,
    })).toBe(false);
  });

  it('signs source and procedure evidence fields with version 2 while retaining version 1 verification', () => {
    const evidence = {
      ...record,
      metadata: {
        sourceId: 'message-42',
        observedAt: '2026-10-14T12:00:00.000Z',
        procedureOutcome: { result: 'success', evidenceId: 'receipt-9' },
      },
    };
    const signature = signMemoryProvenance(evidence, {
      SQUISH_PROVENANCE_PRIVATE_KEY: privatePem,
      SQUISH_PROVENANCE_KEY_ID: 'key-a',
    });
    expect(signature).toMatchObject({ version: 2, keyId: 'key-a' });
    expect(verifyMemoryProvenance({ ...evidence, metadata: { ...evidence.metadata, __squishProvenance: signature } }, {
      SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'key-a': publicPem }),
    })).toBe(true);
    expect(verifyMemoryProvenance({
      ...evidence,
      metadata: { ...evidence.metadata, sourceId: 'forged-source', __squishProvenance: signature },
    }, {
      SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'key-a': publicPem }),
    })).toBe(false);
  });

  it('binds persisted owner, team, and source lineage in version 3', () => {
    const scoped = {
      ...record,
      ownerId: 'user-owner-db-id',
      teamId: 'team-a',
      sourceMemoryId: 'memory-source-id',
      metadata: { sourceId: 'message-42' },
    };
    const signature = signMemoryProvenance(scoped, {
      SQUISH_PROVENANCE_PRIVATE_KEY: privatePem,
      SQUISH_PROVENANCE_KEY_ID: 'key-a',
    });
    const signed = { ...scoped, metadata: { ...scoped.metadata, __squishProvenance: signature } };
    const verifyEnv = { SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'key-a': publicPem }) };

    expect(signature).toMatchObject({ version: 3, keyId: 'key-a' });
    expect(verifyMemoryProvenance(signed, verifyEnv)).toBe(true);
    expect(verifyMemoryProvenance({ ...signed, ownerId: 'different-owner' }, verifyEnv)).toBe(false);
    expect(verifyMemoryProvenance({ ...signed, teamId: 'different-team' }, verifyEnv)).toBe(false);
    expect(verifyMemoryProvenance({ ...signed, sourceMemoryId: 'different-source' }, verifyEnv)).toBe(false);
  });

  it('binds team promotion lineage inside the scope-bound provenance signature', () => {
    const promoted = {
      ...record,
      ownerId: 'user-owner-db-id',
      teamId: 'team-a',
      sourceMemoryId: 'promoted-memory-id',
      metadata: { promotionSourceId: 'personal-source-id' },
    };
    const signature = signMemoryProvenance(promoted, {
      SQUISH_PROVENANCE_PRIVATE_KEY: privatePem,
      SQUISH_PROVENANCE_KEY_ID: 'key-a',
    });
    const signed = { ...promoted, metadata: { ...promoted.metadata, __squishProvenance: signature } };
    const verifyEnv = { SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'key-a': publicPem }) };

    expect(signature).toMatchObject({ version: 3, keyId: 'key-a' });
    expect(verifyMemoryProvenance(signed, verifyEnv)).toBe(true);
    expect(verifyMemoryProvenance({ ...signed, metadata: { ...signed.metadata, promotionSourceId: 'forged-source-id' } }, verifyEnv)).toBe(false);
  });

  it('signs source-backed graph relation payloads and detects relation or support tampering', () => {
    const relation = {
      fromId: 'entity-a', fromKind: 'entity', toId: 'entity-b', toKind: 'entity',
      edgeType: 'version_of', weight: 3,
      metadata: { sourceMemoryIds: ['memory-a'], context: 'The amendment belongs to the agreement.' },
    };
    const signingEnv = { SQUISH_PROVENANCE_PRIVATE_KEY: privatePem, SQUISH_PROVENANCE_KEY_ID: 'key-a' };
    const signature = signGraphRelationProvenance(relation, signingEnv);
    const signedRelation = { ...relation, metadata: { ...relation.metadata, __squishGraphProvenance: signature } };
    const verifyEnv = { SQUISH_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ 'key-a': publicPem }) };

    expect(signature).toMatchObject({ version: 1, keyId: 'key-a' });
    expect(verifyGraphRelationProvenance(signedRelation, verifyEnv)).toBe(true);
    expect(verifyGraphRelationProvenance({
      ...signedRelation,
      metadata: { ...signedRelation.metadata, context: 'forged context' },
    }, verifyEnv)).toBe(false);
    expect(verifyGraphRelationProvenance({
      ...signedRelation,
      metadata: { ...signedRelation.metadata, sourceMemoryIds: ['memory-b'] },
    }, verifyEnv)).toBe(false);
    expect(signGraphRelationProvenance({ ...relation, metadata: { context: 'unsupported source' } }, signingEnv)).toBeNull();
  });
});
