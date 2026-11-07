import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(repoRoot, 'tests', 'fixtures', 'compact-recall-package.json');
const workspaceRoot = path.join(repoRoot, '.workspace');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
mkdirSync(workspaceRoot, { recursive: true });
const runRoot = mkdtempSync(path.join(workspaceRoot, 'packed-compact-recall-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${command} was terminated by ${result.signal}`);
  assert.equal(result.status, 0, [
    `${command} ${args.join(' ')} exited with ${result.status}`,
    result.stdout,
    result.stderr,
  ].filter(Boolean).join('\n'));
  return result.stdout;
}

try {
  const packageManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const archiveName = `${packageManifest.name}-${packageManifest.version}.tgz`;
  const archivePath = path.join(runRoot, archiveName);
  const unpackRoot = path.join(runRoot, 'unpacked');
  const consumerRoot = path.join(runRoot, 'consumer');
  const installedPackage = path.join(consumerRoot, 'node_modules', 'squish-memory');
  const isolatedData = path.join(runRoot, 'data');
  mkdirSync(unpackRoot, { recursive: true });
  mkdirSync(path.dirname(installedPackage), { recursive: true });

  run('bun', [
    'pm', 'pack', '--ignore-scripts', '--destination', runRoot, '--quiet',
  ]);
  assert.ok(existsSync(archivePath), 'package archive was not created');
  run('tar', ['-xzf', archivePath, '-C', unpackRoot]);
  const packedDirectory = path.join(unpackRoot, 'package');
  const packedManifest = JSON.parse(readFileSync(path.join(packedDirectory, 'package.json'), 'utf8'));
  assert.equal(packedManifest.name, 'squish-memory');
  assert.ok(!packedManifest.scripts?.['verify:packed-compact-recall'], 'private verification command leaked into the published manifest');
  for (const privateFile of ['PLAN.md', 'LOG.md', 'ROADMAP.md', 'MAP.md']) {
    assert.ok(!existsSync(path.join(packedDirectory, privateFile)), `${privateFile} was included in the package`);
  }
  writeFileSync(path.join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'squish-packed-recall-consumer',
    version: '1.0.0',
    private: true,
  }, null, 2));
  run('bun', ['add', '--no-save', '--no-progress', '--no-summary', archivePath], {
    cwd: consumerRoot,
    timeout: 180_000,
  });
  assert.ok(existsSync(path.join(installedPackage, 'package.json')), 'packed CLI package was not installed in the isolated consumer');

  const isolatedEnv = { ...process.env };
  for (const name of [
    'SQUISH_DATABASE_URL', 'DATABASE_URL', 'SQUISH_ABSTAIN_BELOW',
    'SQUISH_BACKEND', 'SQUISH_STORAGE_BACKEND',
    'OPENAI_API_KEY', 'SQUISH_OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  ]) delete isolatedEnv[name];
  Object.assign(isolatedEnv, {
    SQUISH_DATA_DIR: isolatedData,
    SQUISH_EMBEDDINGS_PROVIDER: 'none',
    SQUISH_LLM_ENABLED: 'false',
    SQUISH_DECISION_LAYER_ENABLED: 'false',
    SQUISH_DECISION_MODEL_ENABLED: 'false',
    SQUISH_TRUST_POLICY: 'local-compatible',
    SQUISH_QUIET: '1',
  });

  const cliPath = path.join(installedPackage, 'bin', 'squish.mjs');
  const rememberOutput = run(process.execPath, [
    cliPath, 'remember', fixture.content, '--type', fixture.type, '--route', 'memory', '--json',
  ], { cwd: consumerRoot, env: isolatedEnv });
  const remembered = JSON.parse(rememberOutput);
  assert.equal(remembered.ok, true, 'packed CLI did not save the local fixture');

  const recallOutput = run(process.execPath, [
    cliPath, 'recall', fixture.query, '--json', '--max-tokens', String(fixture.maxTokens),
  ], { cwd: consumerRoot, env: isolatedEnv });
  const response = JSON.parse(recallOutput);
  assert.deepEqual(Object.keys(response).sort(), ['memories', 'missing', 'status']);
  assert.notEqual(response.status, 'none', 'packed CLI returned no matching fixture');
  assert.ok(response.memories.some((memory) => memory.content.includes(fixture.expected)), 'packed CLI omitted the expected fixture evidence');
  assert.ok(Math.ceil(JSON.stringify(response).length / 3) <= fixture.maxTokens, 'packed CLI exceeded the configured compact response budget');

  process.stdout.write('Packed compact recall smoke passed using the isolated local fixture and SQLite database.\n');
} finally {
  const resolvedRoot = path.resolve(runRoot);
  const expectedParent = path.resolve(workspaceRoot);
  assert.ok(resolvedRoot.startsWith(`${expectedParent}${path.sep}`), 'refusing to remove a path outside the package scratch area');
  rmSync(resolvedRoot, { recursive: true, force: true });
}
