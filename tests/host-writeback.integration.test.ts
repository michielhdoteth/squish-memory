import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const gitBashCandidates = [
  process.env.SQUISH_GIT_BASH,
  'C:\\Program Files\\Git\\bin\\bash.exe',
  '/usr/bin/bash',
  '/bin/bash',
].filter((candidate): candidate is string => Boolean(candidate));
const bash = gitBashCandidates.find((candidate) => existsSync(candidate));
const scratchRoots: string[] = [];

function makeFixture(): { root: string; project: string; data: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'squish-host-writeback-'));
  scratchRoots.push(root);
  const project = path.join(root, 'project');
  const data = path.join(root, 'data');
  mkdirSync(project, { recursive: true });
  mkdirSync(data, { recursive: true });
  return { root, project, data };
}

function installCliShim(root: string): void {
  const binDir = path.join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'squish');
  writeFileSync(
    shimPath,
    '#!/bin/sh\nexec "$SQUISH_TEST_BUN" "$SQUISH_TEST_REPO/bin/squish.mjs" "$@"\n',
    'utf8',
  );
  chmodSync(shimPath, 0o755);
}

function invokeHook(
  scriptPath: string,
  cwd: string,
  payload: object,
  dataDir: string,
  root: string,
  extraEnv: NodeJS.ProcessEnv = {},
): void {
  if (!bash) throw new Error('Git Bash or bash is required for host hook integration tests');
  const shimDir = path.join(root, 'bin');
  const env = { ...process.env };
  for (const key of [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY',
    'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'COHERE_API_KEY',
  ]) delete env[key];
  Object.assign(env, {
    PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
    SQUISH_DATA_DIR: dataDir,
    SQUISH_TEST_BUN: process.execPath,
    SQUISH_TEST_REPO: repoRoot,
    SQUISH_EMBEDDINGS_PROVIDER: 'local',
    SQUISH_PROFILE: 'fast-local',
    SQUISH_TRUST_MODE: 'local-compatible',
    CLAUDE_PROJECT_DIR: cwd,
    CODEX_PROJECT_DIR: cwd,
    ...extraEnv,
  });
  execFileSync(bash, [scriptPath], {
    cwd,
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

function storedMemories(dataDir: string): Array<{ content: string; project_id: string | null }> {
  const dbPath = path.join(dataDir, 'squish.db');
  if (!existsSync(dbPath)) throw new Error(`Hook did not create its isolated database: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query('SELECT content, project_id FROM memories ORDER BY created_at').all() as Array<{
      content: string;
      project_id: string | null;
    }>;
  } finally {
    db.close();
  }
}

function writeClaudeTranscript(root: string, userText: string, assistantText: string): string {
  const transcriptPath = path.join(root, 'claude-session.jsonl');
  const rows = [
    { type: 'user', message: { content: userText } },
    { type: 'assistant', message: { content: [{ type: 'text', text: assistantText }] } },
  ];
  writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!bash)('host hook write-back to isolated Squish SQLite', () => {
  test('Claude Code Stop hook persists the current transcript excerpt', () => {
    const { root, project, data } = makeFixture();
    installCliShim(root);
    const transcriptPath = writeClaudeTranscript(root, 'Remember the release constraint.', 'The release is local-only.');

    invokeHook(
      path.join(repoRoot, 'plugin', 'claude-code', 'scripts', 'session-stop.sh'),
      project,
      { transcript_path: transcriptPath },
      data,
      root,
    );

    const memories = storedMemories(data);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain('Remember the release constraint.');
    expect(memories[0]?.content).toContain('The release is local-only.');
    expect(memories[0]?.project_id).toBeTruthy();
  });

  test('Claude Code SessionEnd hook persists to archive through the same CLI path', () => {
    const { root, project, data } = makeFixture();
    installCliShim(root);
    const transcriptPath = writeClaudeTranscript(root, 'Keep the migration note.', 'The migration is forward-only.');

    invokeHook(
      path.join(repoRoot, 'plugin', 'claude-code', 'scripts', 'session-end.sh'),
      project,
      { transcript_path: transcriptPath },
      data,
      root,
    );

    const memories = storedMemories(data);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain('The migration is forward-only.');
    expect(memories[0]?.project_id).toBeTruthy();
  });

  test('Codex Stop hook persists an explicitly supplied rollout with project attribution', () => {
    const { root, project, data } = makeFixture();
    installCliShim(root);
    const rolloutPath = path.join(root, 'rollout.json');
    writeFileSync(rolloutPath, JSON.stringify({ items: [
      { role: 'user', content: [{ type: 'input_text', text: 'Preserve the timeout decision.' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Timeout remains 30 seconds.' }] },
    ] }), 'utf8');

    invokeHook(
      path.join(repoRoot, 'plugin', 'codex', 'scripts', 'save-hook.sh'),
      project,
      { transcript_path: rolloutPath },
      data,
      root,
    );

    const memories = storedMemories(data);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain('Timeout remains 30 seconds.');
    expect(memories[0]?.project_id).toBeTruthy();
  });

  test('Codex Stop hook stores an unattributed fallback rollout globally', () => {
    const { root, project, data } = makeFixture();
    installCliShim(root);
    const codexHome = path.join(root, 'codex-home');
    const sessions = path.join(codexHome, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const rolloutPath = path.join(sessions, 'rollout-unmatched.json');
    writeFileSync(rolloutPath, JSON.stringify({ items: [
      { role: 'user', content: [{ type: 'input_text', text: 'Summarize this unrelated deployment topic.' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'It remains globally scoped.' }] },
    ] }), 'utf8');

    invokeHook(
      path.join(repoRoot, 'plugin', 'codex', 'scripts', 'save-hook.sh'),
      project,
      {},
      data,
      root,
      { CODEX_HOME: codexHome },
    );

    const memories = storedMemories(data);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain('It remains globally scoped.');
    expect(memories[0]?.project_id).toBeNull();
  });
});
