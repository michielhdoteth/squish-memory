import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('legacy graph-edge copied-database rehearsal', () => {
  test('reviews and attests an explicitly mapped source edge on a copy only', () => {
    const root = join(tmpdir(), `squish-graph-attestation-rehearsal-${randomUUID()}`);
    const fixture = join(import.meta.dir, 'attest-legacy-graph-edges-rehearsal.ts');
    try {
      const child = Bun.spawnSync({
        cmd: [process.execPath, 'run', fixture],
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          TEMP: process.env.TEMP ?? tmpdir(),
          TMP: process.env.TMP ?? tmpdir(),
          USERPROFILE: process.env.USERPROFILE ?? '',
          SQUISH_TEST_ATTEST_ROOT: root,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(child.stdout.toString()).toContain('copied database attestation rehearsal passed');
    } finally {
      for (let attempt = 0; attempt < 20; attempt++) {
        try { rmSync(root, { recursive: true, force: true }); break; }
        catch (error) {
          if (attempt === 19 || !(error instanceof Error) || !('code' in error) || error.code !== 'EBUSY') throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
      }
    }
  });
});
