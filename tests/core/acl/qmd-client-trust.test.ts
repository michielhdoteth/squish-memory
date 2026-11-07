import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { QMDClient } from '../../../core/embeddings/qmd-client.js';
import { TrustBoundaryError } from '../../../core/acl/trust-policy.js';

const envKeys = ['SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID', 'SQUISH_QMD_ENABLED'] as const;
const savedEnv = new Map<string, string | undefined>();

describe('QMD strict trust boundary', () => {
  beforeAll(() => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'qmd-strict-test-user';
    process.env.SQUISH_QMD_ENABLED = 'true';
  });

  afterAll(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects availability and query calls before the QMD install probe can spawn a process', async () => {
    const client = new QMDClient();
    const installProbe = spyOn(client, 'checkQMDInstalled');

    await expect(client.isAvailable()).rejects.toBeInstanceOf(TrustBoundaryError);
    await expect(client.query({ query: 'private strict memory query' })).rejects.toBeInstanceOf(TrustBoundaryError);
    await expect(client.get({ pathOrDocid: '/private/notes.md' })).rejects.toBeInstanceOf(TrustBoundaryError);
    expect(installProbe).not.toHaveBeenCalled();

    installProbe.mockRestore();
  });
});

describe('QMD subprocess opt-in', () => {
  beforeAll(() => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    delete process.env.SQUISH_TRUSTED_CALLER_ID;
    delete process.env.SQUISH_QMD_ENABLED;
  });

  afterAll(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('does not probe or start QMD unless explicitly enabled', async () => {
    let spawnCount = 0;
    const client = new QMDClient(() => {
      spawnCount += 1;
      throw new Error('QMD must not spawn while disabled');
    });
    const installProbe = spyOn(client, 'checkQMDInstalled');

    await expect(client.isAvailable()).resolves.toBe(false);
    await expect(client.connect()).resolves.toBe(false);
    installProbe.mockRestore();
    await expect(client.checkQMDInstalled()).resolves.toBe(false);
    await expect(client.query({ query: 'offline by default' })).rejects.toBeInstanceOf(TrustBoundaryError);
    expect(spawnCount).toBe(0);
  });

  it('probes QMD only after explicit opt-in', async () => {
    process.env.SQUISH_QMD_ENABLED = 'true';
    const client = new QMDClient();
    const installProbe = spyOn(client, 'checkQMDInstalled').mockResolvedValue(false);

    await expect(client.isAvailable()).resolves.toBe(false);
    expect(installProbe).toHaveBeenCalledTimes(1);

    installProbe.mockRestore();
  });

  it('bounds a stalled QMD MCP handshake and reports unavailable', async () => {
    process.env.SQUISH_QMD_ENABLED = 'true';
    const client = new QMDClient(undefined, 10);
    const installProbe = spyOn(client, 'checkQMDInstalled').mockResolvedValue(true);
    const mcpConnect = spyOn(Client.prototype, 'connect').mockReturnValue(new Promise(() => {}));

    try {
      const startedAt = Date.now();
      await expect(client.isAvailable()).resolves.toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(mcpConnect).toHaveBeenCalledTimes(1);
    } finally {
      installProbe.mockRestore();
      mcpConnect.mockRestore();
    }
  });

  it('does not start the MCP subprocess when opt-in is revoked during the install probe', async () => {
    process.env.SQUISH_QMD_ENABLED = 'true';
    let finishProbe!: (installed: boolean) => void;
    const probeResult = new Promise<boolean>((resolve) => {
      finishProbe = resolve;
    });
    const client = new QMDClient(() => {
      throw new Error('The install probe is replaced by a deferred fixture');
    });
    const installProbe = spyOn(client, 'checkQMDInstalled').mockReturnValue(probeResult);
    const mcpConnect = spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    const mcpClose = spyOn(Client.prototype, 'close').mockResolvedValue(undefined);

    try {
      const connecting = client.connect();
      await Promise.resolve();
      process.env.SQUISH_QMD_ENABLED = 'false';
      await expect(client.isAvailable()).resolves.toBe(false);

      finishProbe(true);
      await expect(connecting).resolves.toBe(false);
      expect(mcpConnect).not.toHaveBeenCalled();
    } finally {
      installProbe.mockRestore();
      await client.disconnect();
      mcpConnect.mockRestore();
      mcpClose.mockRestore();
    }
  });
});
