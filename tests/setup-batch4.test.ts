import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { expect, test } from 'bun:test';

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

test('test preload isolates SQLite and disables inherited external credentials before imports', () => {
  const dataDir = process.env.SQUISH_DATA_DIR;
  expect(dataDir).toBeDefined();
  expect(isAbsolute(dataDir!)).toBe(true);
  expect(isWithin(resolve(tmpdir()), resolve(dataDir!))).toBe(true);
  expect(isWithin(resolve(homedir(), '.squish'), resolve(dataDir!))).toBe(false);
  expect(existsSync(resolve(dataDir!, 'squish.db'))).toBe(false);
  expect(process.env.DATABASE_URL).toBe('');
  expect(process.env.SQUISH_LOCAL_BUNDLED_MODEL).toBe('off');
  expect(process.env.SQUISH_RERANKER_ENABLED).toBe('false');
  expect(process.env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED).toBe('false');
  expect(Object.keys(process.env).filter((key) => /(?:API_KEY|API_TOKEN)$/.test(key))).toEqual([]);
});
