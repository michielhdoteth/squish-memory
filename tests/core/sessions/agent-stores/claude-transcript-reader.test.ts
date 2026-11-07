import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeTranscript, searchClaudeCodeSessions } from '../../../../core/sessions/agent-stores/claude-code.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-claude-reader-'));
const hostDir = path.join(root, 'host');
const dataDir = path.join(root, 'data');
const previousClaudeDir = process.env.SQUISH_CLAUDE_DIR;
const previousDataDir = process.env.SQUISH_DATA_DIR;
const previousDatabaseUrl = process.env.DATABASE_URL;
const projectPath = path.join(root, 'project');
const sessionId = 'reader-session_1';

beforeAll(() => {
  process.env.SQUISH_CLAUDE_DIR = hostDir;
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  const projectHash = projectPath.replace(/:/g, '-').replace(/\\/g, '-');
  const projectDir = path.join(hostDir, 'projects', projectHash);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, 'history.jsonl'), JSON.stringify({
    display: 'fixture', timestamp: 1, project: projectPath, sessionId,
  }));
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
    { type: 'user', message: { role: 'user', content: 'Remember this synthetic user fact.' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer.' }] } },
    { type: 'user', message: { role: 'assistant', content: 'Role disagreement must not be trusted.' } },
    { type: 'tool', message: { role: 'user', content: 'Tool-like records are not user turns.' } },
  ].map((record) => JSON.stringify(record)).join('\n'));
});

afterAll(() => {
  if (previousClaudeDir === undefined) delete process.env.SQUISH_CLAUDE_DIR;
  else process.env.SQUISH_CLAUDE_DIR = previousClaudeDir;
  if (previousDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = previousDataDir;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readClaudeTranscript', () => {
  it('reads structured roles uncached with stable fingerprints and project binding', () => {
    const snapshot = readClaudeTranscript(sessionId);
    expect(snapshot?.sessionId).toBe(sessionId);
    expect(snapshot?.projectPath).toBe(projectPath);
    expect(snapshot?.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Remember this synthetic user fact.'],
      ['assistant', 'Synthetic answer.'],
    ]);
    expect(snapshot?.messages[0]?.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(readClaudeTranscript(sessionId)?.messages[0]?.sourceFingerprint)
      .toBe(snapshot?.messages[0]?.sourceFingerprint);
    expect(readClaudeTranscript('../outside')).toBeNull();
    expect(readClaudeTranscript('missing-session')).toBeNull();
  });

  it('fails closed when the indexed project transcript is missing', () => {
    const projectHash = projectPath.replace(/:/g, '-').replace(/\\/g, '-');
    fs.renameSync(
      path.join(hostDir, 'projects', projectHash, `${sessionId}.jsonl`),
      path.join(hostDir, 'projects', projectHash, `${sessionId}.hidden`),
    );
    try { expect(readClaudeTranscript(sessionId)).toBeNull(); }
    finally {
      fs.renameSync(
        path.join(hostDir, 'projects', projectHash, `${sessionId}.hidden`),
        path.join(hostDir, 'projects', projectHash, `${sessionId}.jsonl`),
      );
    }
  });

  it('reloads project mappings and stops returning sessions after index removal', async () => {
    const original = await searchClaudeCodeSessions(
      { query: 'synthetic user fact', directory_glob: projectPath },
      { claudeDir: hostDir },
    );
    expect(original.map((result) => result.chunk.repo_path)).toEqual([projectPath]);

    const remappedProject = path.join(root, 'remapped-project');
    const remappedHash = remappedProject.replace(/:/g, '-').replace(/\\/g, '-');
    const remappedDir = path.join(hostDir, 'projects', remappedHash);
    fs.mkdirSync(remappedDir, { recursive: true });
    fs.copyFileSync(
      path.join(hostDir, 'projects', projectPath.replace(/:/g, '-').replace(/\\/g, '-'), `${sessionId}.jsonl`),
      path.join(remappedDir, `${sessionId}.jsonl`),
    );
    fs.writeFileSync(path.join(hostDir, 'history.jsonl'), `${JSON.stringify({
      display: 'remapped fixture', timestamp: 2, project: remappedProject, sessionId,
    })}\n`);

    const staleScope = await searchClaudeCodeSessions(
      { query: 'synthetic user fact', directory_glob: projectPath },
      { claudeDir: hostDir },
    );
    expect(staleScope).toEqual([]);
    const refreshed = await searchClaudeCodeSessions(
      { query: 'synthetic user fact', directory_glob: remappedProject },
      { claudeDir: hostDir },
    );
    expect(refreshed.map((result) => result.chunk.repo_path)).toEqual([remappedProject]);

    fs.writeFileSync(path.join(hostDir, 'history.jsonl'), '');
    expect(await searchClaudeCodeSessions(
      { query: 'synthetic user fact' },
      { claudeDir: hostDir },
    )).toEqual([]);
  });

  it('rejects a projects-directory junction that resolves outside the Claude data directory', () => {
    const projectsDir = path.join(hostDir, 'projects');
    const preservedProjectsDir = path.join(hostDir, 'projects-preserved');
    const outsideProjectsDir = path.join(root, 'outside-projects');
    const projectHash = projectPath.replace(/:/g, '-').replace(/\\/g, '-');
    const outsideProjectDir = path.join(outsideProjectsDir, projectHash);
    fs.mkdirSync(outsideProjectDir, { recursive: true });
    fs.copyFileSync(
      path.join(projectsDir, projectHash, `${sessionId}.jsonl`),
      path.join(outsideProjectDir, `${sessionId}.jsonl`),
    );
    fs.renameSync(projectsDir, preservedProjectsDir);
    fs.symlinkSync(outsideProjectsDir, projectsDir, 'junction');
    try {
      expect(fs.lstatSync(projectsDir).isSymbolicLink()).toBe(true);
      expect(readClaudeTranscript(sessionId)).toBeNull();
    } finally {
      fs.unlinkSync(projectsDir);
      fs.renameSync(preservedProjectsDir, projectsDir);
    }
  });

  it('does not attribute transcript records to an indexed project when their cwd is unrelated', async () => {
    const unrelatedProject = path.join(root, 'unrelated-project');
    fs.writeFileSync(path.join(hostDir, 'history.jsonl'), JSON.stringify({
      display: 'mismatched fixture', timestamp: 3, project: projectPath, sessionId,
    }));
    const transcriptPath = path.join(
      hostDir,
      'projects',
      projectPath.replace(/:/g, '-').replace(/\\/g, '-'),
      `${sessionId}.jsonl`,
    );
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'user',
      cwd: unrelatedProject,
      message: { role: 'user', content: 'Synthetic cross-project attribution marker.' },
    }));

    expect(readClaudeTranscript(sessionId)).toBeNull();
    expect(await searchClaudeCodeSessions(
      { query: 'cross-project attribution marker', directory_glob: projectPath },
      { claudeDir: hostDir },
    )).toEqual([]);
  });
});
