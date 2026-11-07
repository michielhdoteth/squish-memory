import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-gemini-reader-'));
const dataDir = path.join(root, 'data');
const geminiDir = path.join(root, 'gemini');
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_GEMINI_DIR = geminiDir;

import { discoverGeminiSessionFiles, listGeminiSessions, readGeminiTranscript, searchGeminiSessions } from '../../../../core/sessions/agent-stores/gemini.js';
import { createSessionSearchBudget } from '../../../../core/sessions/agent-stores/types.js';

const sessionId = 'fixture-session-1';
const projectPath = path.join(root, 'project');
const transcriptPath = path.join(geminiDir, 'tmp', 'fixture-hash', 'chats', `session-${sessionId}.json`);

function writeTranscript(doc: unknown): void {
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, JSON.stringify(doc));
}

beforeAll(() => {
  writeTranscript({
    sessionId,
    projectPath,
    messages: [
      { type: 'user', content: 'Remember the release is Friday.' },
      { type: 'gemini', content: 'I will keep that in mind.' },
      { type: 'system-notice', content: 'ignore this internal record' },
    ],
  });
});

afterAll(async () => {
  delete process.env.SQUISH_GEMINI_DIR;
  const { closeAllDbs, resetDb } = await import('../../../../db/index.js');
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  await closeAllDbs();
  resetDb();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('bounded Gemini transcript reader', () => {
  test('stops before filesystem discovery when the shared search deadline has expired', async () => {
    const budget = createSessionSearchBudget(12, 1000);
    budget.deadlineMs = Date.now() - 1;
    const existsSpy = spyOn(fs, 'existsSync');
    try {
      const results = await searchGeminiSessions({ query: 'synthetic', limit: 2, scanBudget: budget }, { geminiDir });
      expect(results).toEqual([]);
      expect(existsSpy).not.toHaveBeenCalled();
      expect(budget.reason).toBe('time_limit');
      expect(budget.truncationReasons).toContain('time_limit');
    } finally {
      existsSpy.mockRestore();
    }
  });

  test('caps discovered session paths at the per-source scan budget without opening transcript data', () => {
    const firstCandidate = path.join(geminiDir, 'tmp', 'budget-a', 'chats', 'session-a.json');
    const secondCandidate = path.join(geminiDir, 'tmp', 'budget-b', 'chats', 'session-b.json');
    for (const candidate of [firstCandidate, secondCandidate]) {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, '');
    }
    const budget = createSessionSearchBudget(1, 1000);

    const candidates = discoverGeminiSessionFiles(geminiDir, budget);

    expect(candidates).toHaveLength(1);
    expect(budget.truncated).toBe(true);
    expect(budget.reason).toBe('session_limit');
    expect(budget.scannedSessions).toBe(0);
  });

  test('refuses oversized transcript discovery after one candidate beyond the ceiling', () => {
    const isolatedGeminiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-gemini-capture-cap-'));
    const chatsDir = path.join(isolatedGeminiDir, 'tmp', 'synthetic-project', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });

    const previousDir = process.env.SQUISH_GEMINI_DIR;
    process.env.SQUISH_GEMINI_DIR = isolatedGeminiDir;
    let candidateStats = 0;
    const statSync = fs.statSync.bind(fs);
    const realpathSync = fs.realpathSync.bind(fs);
    const opendirSync = fs.opendirSync.bind(fs);
    const makeDirent = (name: string, directory: boolean): fs.Dirent => ({
      name,
      isDirectory: () => directory,
      isFile: () => !directory,
    } as unknown as fs.Dirent);
    const makeDirectory = (entries: fs.Dirent[]): fs.Dir => {
      let index = 0;
      return {
        readSync: () => entries[index++] ?? null,
        closeSync: () => undefined,
      } as unknown as fs.Dir;
    };
    const tmpDir = path.join(isolatedGeminiDir, 'tmp');
    const opendirSpy = spyOn(fs, 'opendirSync').mockImplementation(((directory: fs.PathLike) => {
      if (String(directory) === tmpDir) return makeDirectory([makeDirent('synthetic-project', true)]);
      if (String(directory) === chatsDir) {
        return makeDirectory(Array.from({ length: 5_001 }, (_, index) =>
          makeDirent(`session-${String(index).padStart(5, '0')}.json`, false)));
      }
      return opendirSync(directory);
    }) as typeof fs.opendirSync);
    const realpathSpy = spyOn(fs, 'realpathSync').mockImplementation(((filePath: fs.PathLike, ...args: unknown[]) => {
      if (typeof filePath === 'string' && path.dirname(filePath) === chatsDir) return filePath;
      return (realpathSync as (...realpathArgs: unknown[]) => string)(filePath, ...args);
    }) as typeof fs.realpathSync);
    const statSpy = spyOn(fs, 'statSync').mockImplementation(((filePath: fs.PathLike, ...args: unknown[]) => {
      if (typeof filePath === 'string' && path.dirname(filePath) === chatsDir) candidateStats++;
      if (typeof filePath === 'string' && path.dirname(filePath) === chatsDir) {
        return { isFile: () => true } as fs.Stats;
      }
      return (statSync as (...statArgs: unknown[]) => fs.Stats)(filePath, ...args);
    }) as typeof fs.statSync);
    try {
      expect(readGeminiTranscript('missing-synthetic-session')).toBeNull();
      expect(candidateStats).toBe(5_001);
    } finally {
      statSpy.mockRestore();
      realpathSpy.mockRestore();
      opendirSpy.mockRestore();
      if (previousDir === undefined) delete process.env.SQUISH_GEMINI_DIR;
      else process.env.SQUISH_GEMINI_DIR = previousDir;
      fs.rmSync(isolatedGeminiDir, { recursive: true, force: true });
    }
  }, 20_000);

  test('reads structured user and assistant roles with project binding and stable fingerprints', () => {
    const first = readGeminiTranscript(sessionId);
    const second = readGeminiTranscript(sessionId);
    expect(first).not.toBeNull();
    expect(first?.projectPath).toBe(projectPath);
    expect(first?.messages.map(({ role, content, messageIndex }) => ({ role, content, messageIndex }))).toEqual([
      { role: 'user', content: 'Remember the release is Friday.', messageIndex: 0 },
      { role: 'assistant', content: 'I will keep that in mind.', messageIndex: 1 },
    ]);
    expect(first?.messages.map((message) => message.sourceFingerprint)).toEqual(
      second?.messages.map((message) => message.sourceFingerprint),
    );
  });

  test('uses structured project paths to scope search and populate result metadata', async () => {
    const isolatedGeminiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-gemini-project-path-'));
    try {
      const projectHash = createHash('sha256').update(projectPath).digest('hex');
      const chatDir = path.join(isolatedGeminiDir, 'tmp', projectHash, 'chats');
      fs.mkdirSync(chatDir, { recursive: true });
      fs.writeFileSync(path.join(chatDir, 'session-project-path.json'), JSON.stringify({
        sessionId: 'gemini-project-path',
        projectHash,
        projectPath,
        messages: [{ type: 'user', content: 'synthetic project path retrieval marker' }],
      }));

      const results = await searchGeminiSessions(
        { query: 'project path retrieval marker', directory_glob: projectPath },
        { geminiDir: isolatedGeminiDir },
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.repo_path).toBe(projectPath);
      expect(results[0]?.chunk.project).toBe(path.basename(projectPath));
      expect(listGeminiSessions({ directory_glob: projectPath }, { geminiDir: isolatedGeminiDir }))
        .toMatchObject([{ repo_path: projectPath, project: path.basename(projectPath) }]);
    } finally {
      fs.rmSync(isolatedGeminiDir, { recursive: true, force: true });
    }
  });

  test('fails closed without a structured project path or on an oversized file', () => {
    writeTranscript({ sessionId, projectHash: 'hash-only', messages: [{ type: 'user', content: 'x' }] });
    expect(readGeminiTranscript(sessionId)).toBeNull();
    fs.writeFileSync(transcriptPath, ' '.repeat(5 * 1024 * 1024 + 1));
    expect(readGeminiTranscript(sessionId)).toBeNull();
  });

  test('rejects path-like session identifiers and skips messages over the per-message limit', () => {
    expect(readGeminiTranscript('../outside')).toBeNull();
    writeTranscript({
      sessionId,
      cwd: projectPath,
      messages: [
        { type: 'user', content: 'x'.repeat(20_001) },
        { type: 'user', content: 'safe message' },
      ],
    });
    const result = readGeminiTranscript(sessionId);
    expect(result?.messages).toHaveLength(1);
    expect(result?.messages[0]?.messageIndex).toBe(1);
  });

  test('does not enumerate transcripts reached through a junction outside the Gemini data root', () => {
    const outsideChats = path.join(root, 'outside', 'chats');
    const linkedChats = path.join(geminiDir, 'tmp', 'linked-project', 'chats');
    fs.mkdirSync(outsideChats, { recursive: true });
    fs.writeFileSync(path.join(outsideChats, 'session-external-fixture.json'), JSON.stringify({
      sessionId: 'external-fixture',
      projectPath,
      messages: [{ type: 'user', content: 'Synthetic external transcript marker.' }],
    }));
    fs.mkdirSync(path.dirname(linkedChats), { recursive: true });
    try {
      fs.symlinkSync(outsideChats, linkedChats, 'junction');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return;
      throw error;
    }

    const sessionIds = listGeminiSessions({}, { geminiDir }).map((session) => session.session_id);
    expect(sessionIds).toContain(sessionId);
    expect(sessionIds).not.toContain('external-fixture');
  });

  test('does not treat a project-path fragment inside an unrelated project hash as a scope match', async () => {
    const isolatedGeminiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-gemini-scope-'));
    try {
      const unrelatedProject = '/unrelated';
      const unrelatedHash = createHash('sha256').update(unrelatedProject).digest('hex');
      expect(unrelatedHash).toContain('a');
      const chatDir = path.join(isolatedGeminiDir, 'tmp', unrelatedHash, 'chats');
      fs.mkdirSync(chatDir, { recursive: true });
      fs.writeFileSync(path.join(chatDir, 'session-unrelated.json'), JSON.stringify({
        sessionId: 'gemini-unrelated-scope',
        projectHash: unrelatedHash,
        projectPath: unrelatedProject,
        messages: [{ type: 'user', content: 'synthetic scoped search collision marker' }],
      }));

      const results = await searchGeminiSessions(
        { query: 'scoped search collision marker', directory_glob: '/a' },
        { geminiDir: isolatedGeminiDir },
      );
      expect(results).toEqual([]);
    } finally {
      fs.rmSync(isolatedGeminiDir, { recursive: true, force: true });
    }
  });
});
