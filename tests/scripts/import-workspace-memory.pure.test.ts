import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  DEFAULT_PROJECT_PATH,
  MAX_LABEL_LENGTH,
  assertLabelRootAvailable,
  asMemoryType,
  identityFor,
  keyFor,
  normalizeLabel,
  parseImportArgs,
  parseSource,
  parseSourceTags,
  readFlag,
  type ImportRecord,
} from '../../scripts/import-workspace-memory.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serializeMetadata } from '../../core/memory/serialization.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ROOT = mkdtempSync(join(tmpdir(), 'squish-iwm-pure-'));

function tempDir(name: string): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJournal(dir: string, relativePath: string, body: string): void {
  const target = join(dir, relativePath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, body, 'utf8');
}

// ─── Argument parsing: --project (M1) ────────────────────────────────────────

describe('import-workspace-memory: --project parsing', () => {
  test('absent --project falls back to the documented default project', () => {
    const args = parseImportArgs(['--source=' + join(ROOT, 'a')]);
    expect(args.projectPath).toBe(DEFAULT_PROJECT_PATH);
    expect(args.projectScopeSource).toBe('default');
  });

  test('--project= is an explicit request for global scope', () => {
    const args = parseImportArgs(['--project=']);
    expect(args.projectPath).toBeUndefined();
    expect(args.projectScopeSource).toBe('global');
  });

  test('bare --project is rejected instead of silently defaulting to a project', () => {
    // The defect: `--project` did not match `startsWith('--project=')`, so the
    // default project path silently applied to 299 rows.
    expect(() => parseImportArgs(['--project'])).toThrow(/--project requires a value/);
  });

  test('bare --project alongside --source= is still rejected', () => {
    expect(() => parseImportArgs(['--source=' + join(ROOT, 'a'), '--project'])).toThrow(/--project requires a value/);
  });

  test('whitespace-only --project is rejected rather than resolving to cwd', () => {
    // The defect: normalizeProjectPath trims then resolve('') yields the cwd.
    expect(() => parseImportArgs(['--project=   '])).toThrow(/whitespace only/);
    expect(() => parseImportArgs(['--project=\t '])).toThrow(/whitespace only/);
  });

  test('--project value containing = survives intact', () => {
    const args = parseImportArgs(['--project=a=b']);
    expect(args.projectPath).toBe('a=b');
    expect(args.projectScopeSource).toBe('path');
  });

  test('--project path is trimmed', () => {
    const args = parseImportArgs(['--project=  C:\\some\\path  ']);
    expect(args.projectPath).toBe('C:\\some\\path');
  });
});

// ─── Argument parsing: --label (C2) ─────────────────────────────────────────

describe('import-workspace-memory: --label normalisation', () => {
  test('plain label is lowercased', () => {
    expect(normalizeLabel('PersonalMemory')).toBe('personalmemory');
  });

  test('leading and trailing whitespace does not create a second namespace', () => {
    // The defect: " Personal Memory " became "personal-memory-", so a rerun with
    // --label=personal-memory landed in a different namespace and duplicated.
    expect(normalizeLabel(' Personal Memory ')).toBe('personal-memory');
    expect(normalizeLabel(' Personal Memory ')).toBe(normalizeLabel('personal-memory'));
  });

  test('label with only punctuation is rejected, naming the label', () => {
    // The defect: '!!!' normalised to '-', colliding with other dash-only labels.
    expect(() => normalizeLabel('!!!')).toThrow(/--label "!!!" normalises/);
  });

  test('unicode-only label is rejected', () => {
    // The defect: '日本語' normalised to '-'.
    expect(() => normalizeLabel('日本語')).toThrow(/no alphanumeric character/);
  });

  test('all-dash label is rejected', () => {
    // The defect: '---' normalised to '---'.
    expect(() => normalizeLabel('---')).toThrow(/no alphanumeric character/);
  });

  test('two labels that used to collide are now distinguished or rejected', () => {
    expect(() => normalizeLabel('!!!')).toThrow();
    expect(() => normalizeLabel('日本語')).toThrow();
    // The only dash-bearing label that survives is one with real content.
    expect(normalizeLabel('a-!!!-b')).toBe('a-b');
  });

  test('very long label is capped and re-stripped of trailing dashes', () => {
    const label = 'x'.repeat(MAX_LABEL_LENGTH + 40);
    expect(normalizeLabel(label).length).toBe(MAX_LABEL_LENGTH);
    const dashy = `${'y'.repeat(MAX_LABEL_LENGTH - 1)}-${'z'.repeat(20)}`;
    const capped = normalizeLabel(dashy);
    expect(capped.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    expect(capped.endsWith('-')).toBe(false);
  });

  test('empty --label= is rejected rather than silently downgrading namespace', () => {
    expect(() => parseImportArgs(['--label='])).toThrow(/--label was passed with an empty value/);
  });

  test('whitespace-only --label= is rejected', () => {
    expect(() => parseImportArgs(['--label=   '])).toThrow(/empty value/);
  });

  test('bare --label is rejected', () => {
    expect(() => parseImportArgs(['--label'])).toThrow(/--label requires a value/);
  });

  test('absent --label yields the unlabelled namespace', () => {
    expect(parseImportArgs([]).sourceLabel).toBe('');
  });

  test('--label in argv is normalised through the same path', () => {
    expect(parseImportArgs(['--label= Personal Memory ']).sourceLabel).toBe('personal-memory');
  });
});

// ─── Argument parsing: --source and --apply ──────────────────────────────────

describe('import-workspace-memory: --source and --apply', () => {
  test('--source is resolved to an absolute path', () => {
    const args = parseImportArgs(['--source=' + join(ROOT, 'a')]);
    expect(args.sourceRoot).toBe(join(ROOT, 'a'));
  });

  test('--source relative path resolves against cwd', () => {
    const args = parseImportArgs(['--source=some-relative-dir']);
    expect(args.sourceRoot.endsWith('some-relative-dir')).toBe(true);
  });

  test('empty --source= is rejected', () => {
    expect(() => parseImportArgs(['--source='])).toThrow(/--source was passed with an empty value/);
  });

  test('bare --source is rejected', () => {
    expect(() => parseImportArgs(['--source'])).toThrow(/--source requires a value/);
  });

  test('--apply toggles write mode', () => {
    expect(parseImportArgs([]).apply).toBe(false);
    expect(parseImportArgs(['--apply']).apply).toBe(true);
  });

  test('--apply is only honoured as an exact token', () => {
    expect(parseImportArgs(['--apply=true']).apply).toBe(false);
  });
});

// ─── Flag reader ────────────────────────────────────────────────────────────

describe('import-workspace-memory: readFlag', () => {
  test('classifies absent, bare, and valued flags', () => {
    expect(readFlag([], '--project')).toEqual({ kind: 'absent' });
    expect(readFlag(['--project'], '--project')).toEqual({ kind: 'bare' });
    expect(readFlag(['--project=x'], '--project')).toEqual({ kind: 'value', value: 'x' });
  });

  test('does not confuse a different flag that shares a prefix', () => {
    expect(readFlag(['--projective=1'], '--project')).toEqual({ kind: 'absent' });
  });
});

// ─── Identity and key derivation ─────────────────────────────────────────────

describe('import-workspace-memory: identity and key derivation', () => {
  test('identity is sourcePath plus timestamp', () => {
    expect(identityFor('lbl/a.txt', '2026-01-01T00:00:00Z')).toBe('lbl/a.txt\t2026-01-01T00:00:00Z');
  });

  test('identity with no timestamp uses an empty slot, not undefined', () => {
    expect(identityFor('lbl/a.txt')).toBe('lbl/a.txt\t');
  });

  test('two roots with the same relative path get different identities once labelled', () => {
    expect(identityFor('alpha/a.txt', 'T')).not.toBe(identityFor('beta/a.txt', 'T'));
  });

  test('key is stable for identical input', () => {
    expect(keyFor('p', 'i', 'c')).toBe(keyFor('p', 'i', 'c'));
  });

  test('key changes with content', () => {
    expect(keyFor('p', 'i', 'c')).not.toBe(keyFor('p', 'i', 'c2'));
  });
});

// ─── Memory type mapping ─────────────────────────────────────────────────────

describe('import-workspace-memory: asMemoryType', () => {
  test('passes through known types', () => {
    expect(asMemoryType('fact', 'x')).toBe('fact');
    expect(asMemoryType('DECISION', 'x')).toBe('decision');
  });

  test('maps failure, fix, success to note', () => {
    expect(asMemoryType('failure', 'x')).toBe('note');
    expect(asMemoryType('fix', 'x')).toBe('note');
    expect(asMemoryType('success', 'x')).toBe('note');
  });

  test('recognises architecture decisions in legacy memos', () => {
    expect(asMemoryType('legacy-memo', 'Architecture Decision: use bun')).toBe('decision');
    expect(asMemoryType('legacy-memo', 'just a note')).toBe('fact');
  });

  test('unknown kind falls back to fact', () => {
    expect(asMemoryType('whatever', 'x')).toBe('fact');
  });
});

// ─── Tag parsing ─────────────────────────────────────────────────────────────

describe('import-workspace-memory: parseSourceTags', () => {
  test('parses comma-separated tags', () => {
    expect(parseSourceTags(' a , b ')).toEqual(['a', 'b']);
  });

  test('parses JSON array tags', () => {
    expect(parseSourceTags('["a", "b"]')).toEqual(['a', 'b']);
  });

  test('falls back to comma splitting on malformed JSON', () => {
    expect(parseSourceTags('[broken, b')).toEqual(['[broken', 'b']);
  });

  test('drops empty tags', () => {
    expect(parseSourceTags('a,,  ,b')).toEqual(['a', 'b']);
  });
});

// ─── Source parsing (M3) ─────────────────────────────────────────────────────

describe('import-workspace-memory: parseSource', () => {
  test('parses typed journal records with tags', async () => {
    const dir = tempDir('journal-ok');
    writeJournal(dir, '2026-01-01/memory.txt', '[2026-01-01T10:00:00Z] [TYPE:fact] [SOURCE:agent] The sky is blue | tags: sky, color\n');
    const records = await parseSource(dir, 'testroot');
    expect(records).toHaveLength(1);
    expect(records[0].content).toBe('The sky is blue');
    expect(records[0].type).toBe('fact');
    expect(records[0].sourcePath).toBe('testroot/2026-01-01/memory.txt');
    expect(records[0].timestamp).toBe('2026-01-01T10:00:00Z');
    expect(records[0].tags).toContain('import-testroot');
  });

  test('duplicate timestamps in one file are rejected, naming the file', async () => {
    // The defect: both records resolved to one identity, so the second repair
    // overwrote the first row. The archive had no such file, but the contract
    // depended on an invariant nothing checked.
    const dir = tempDir('journal-dup-ts');
    writeJournal(dir, '2026-01-01/memory.txt', [
      '[2026-01-01T10:00:00Z] [TYPE:fact] [SOURCE:agent] first body',
      '[2026-01-01T10:00:00Z] [TYPE:fact] [SOURCE:agent] second body',
      '',
    ].join('\n'));
    let message = '';
    try {
      await parseSource(dir, 'testroot');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('2026-01-01/memory.txt');
    expect(message).toContain('Duplicate source timestamp');
    expect(message).toContain('2026-01-01T10:00:00Z');
    // Both offending records are named, so the operator can find them.
    expect(message).toContain('records 1 and 2');
  });

  test('duplicate timestamps in different files are allowed', async () => {
    const dir = tempDir('journal-cross-file');
    writeJournal(dir, '2026-01-01/memory.txt', '[2026-01-01T10:00:00Z] [TYPE:fact] [SOURCE:agent] one\n');
    writeJournal(dir, '2026-01-02/memory.txt', '[2026-01-01T10:00:00Z] [TYPE:fact] [SOURCE:agent] two\n');
    const records = await parseSource(dir, 'testroot');
    expect(records).toHaveLength(2);
    expect(records[0].sourcePath).not.toBe(records[1].sourcePath);
  });

  test('empty content is rejected naming the timestamp', async () => {
    const dir = tempDir('journal-empty');
    writeJournal(dir, '2026-01-01/memory.txt', '[2026-01-01T10:00:00Z] [TYPE:fact] [SOURCE:agent] \n');
    await expect(parseSource(dir, 'testroot')).rejects.toThrow(/Empty source memory/);
  });

  test('a record spanning continuation lines keeps the tags suffix out of content', async () => {
    const dir = tempDir('journal-multiline');
    writeJournal(dir, '2026-01-01/memory.txt', [
      '[2026-01-01T10:00:00Z] [TYPE:decision] [SOURCE:agent] line one',
      'line two | tags: alpha, beta',
      '',
    ].join('\n'));
    const records = await parseSource(dir, 'testroot');
    expect(records[0].content).toBe('line one\nline two');
    expect(records[0].tags).toContain('alpha');
    expect(records[0].tags).toContain('beta');
  });

  test('legacy MEMO lines parse with the legacy-memo tag', async () => {
    const dir = tempDir('journal-memo');
    writeJournal(dir, '2026-01-01/memory.txt', '[2026-01-01T10:00:00Z] [MEMO] Architecture Decision: pick bun\n');
    const records = await parseSource(dir, 'testroot');
    // Pre-existing behaviour, unchanged: parseSource prefixes MEMO content with
    // "[MEMO] " before asMemoryType sees it, so the ADR sniffing regex cannot
    // match and a legacy ADR lands as a fact. Recorded, not fixed here.
    expect(records[0].type).toBe('fact');
    expect(records[0].content).toBe('[MEMO] Architecture Decision: pick bun');
    expect(records[0].tags).toContain('legacy-memo');
  });

  test('asMemoryType sniffs an ADR when the content reaches it unprefixed', () => {
    expect(asMemoryType('legacy-memo', 'Architecture Decision: pick bun')).toBe('decision');
  });

  test('an unlabelled import uses no namespace prefix and the 4m-labs tag', async () => {
    const dir = tempDir('journal-unlabelled');
    writeJournal(dir, '2026-01-01/memory.txt', '[2026-01-01T10:00:00Z] [TYPE:fact] [SOURCE:agent] body\n');
    const records = await parseSource(dir, '');
    expect(records[0].sourcePath).toBe('2026-01-01/memory.txt');
    expect(records[0].tags).toContain('4m-labs');
    expect(records[0].tags).not.toContain('global-shared-memory');
  });

  test('a plain document becomes a context record', async () => {
    const dir = tempDir('doc-only');
    writeFileSync(join(dir, 'brief.md'), '# Brief\nSome prose.\n', 'utf8');
    const records = await parseSource(dir, 'testroot');
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('context');
    expect(records[0].sourceKind).toBe('workspace-document');
  });

  test('two roots with identical relative files produce distinct sourcePaths once labelled differently', async () => {
    const a = tempDir('root-a');
    const b = tempDir('root-b');
    for (const dir of [a, b]) {
      writeJournal(dir, '2026-01-01/memory.txt', '[2026-01-01T10:00:00Z] [TYPE:fact] [SOURCE:agent] shared layout\n');
    }
    const fromA = await parseSource(a, 'alpha');
    const fromB = await parseSource(b, 'beta');
    expect(fromA[0].sourcePath).not.toBe(fromB[0].sourcePath);
    expect(identityFor(fromA[0].sourcePath, fromA[0].timestamp)).not.toBe(identityFor(fromB[0].sourcePath, fromB[0].timestamp));
  });
});

// ─── Label/root collision guard (C2) ─────────────────────────────────────────

function labelState(label: string, roots: string[]) {
  return {
    existingKeys: new Map<string, string>(),
    existingSourceIds: new Map<string, string>(),
    knowledgeSourceIds: new Map(),
    knowledgeMemoryIds: new Set<string>(),
    importMetadata: new Map(),
    existingRows: new Map(),
    labelRoots: new Map([[label, new Set(roots)]]),
    hasKnowledgeTable: false,
  };
}

describe('import-workspace-memory: label/sourceRoot collision guard', () => {
  test('a label already imported from a different root is refused', () => {
    const state = labelState('alpha', ['C:\\root-one']);
    expect(() => assertLabelRootAvailable(state, 'alpha', 'C:\\root-two')).toThrow(/already imported from a different source root/);
  });

  test('the error names the conflicting root and the current root', () => {
    const state = labelState('alpha', ['C:\\root-one']);
    let message = '';
    try {
      assertLabelRootAvailable(state, 'alpha', 'C:\\root-two');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('C:\\root-one');
    expect(message).toContain('C:\\root-two');
  });

  test('re-importing the same root under the same label is allowed', () => {
    expect(() => assertLabelRootAvailable(labelState('alpha', ['C:\\root-one']), 'alpha', 'C:\\root-one')).not.toThrow();
  });

  test('an unlabelled import is never blocked by the guard', () => {
    expect(() => assertLabelRootAvailable(labelState('alpha', ['C:\\root-one']), '', 'C:\\other')).not.toThrow();
  });

  test('a label absent from the database is allowed', () => {
    expect(() => assertLabelRootAvailable(labelState('alpha', ['C:\\root-one']), 'beta', 'C:\\root-two')).not.toThrow();
  });

  test('the two verified collision labels are both rejected before any database write', () => {
    // `!!!` and `日本語` both used to normalise to '-', so a root imported under
    // one and a rerun under the other shared a sourcePath prefix and the repair
    // path overwrote the first root's rows.
    expect(() => normalizeLabel('!!!')).toThrow();
    expect(() => normalizeLabel('日本語')).toThrow();
  });
});

// ─── Import metadata shape ───────────────────────────────────────────────────

describe('import-workspace-memory: import metadata records the source root', () => {
  test('metadata carries sourceRoot so a later run can detect a moved root', () => {
    // The guard depends on every imported row naming its sourceRoot; assert the
    // serializer round-trips the field the guard reads.
    const record: ImportRecord = {
      content: 'body', type: 'fact', tags: ['t'],
      sourcePath: 'alpha/2026-01-01/memory.txt',
      timestamp: '2026-01-01T10:00:00Z', sourceKind: 'fact', sourceKey: 'k',
    };
    const metadata = {
      workspaceMemoryImport: {
        sourceKey: record.sourceKey,
        sourcePath: record.sourcePath,
        sourceLabel: 'alpha',
        sourceRoot: 'C:\\root-alpha',
        sourceTimestamp: record.timestamp,
        sourceKind: record.sourceKind,
      },
    };
    const restored = JSON.parse(serializeMetadata(metadata)!) as typeof metadata;
    expect(restored.workspaceMemoryImport.sourceRoot).toBe('C:\\root-alpha');
    expect(restored.workspaceMemoryImport.sourceLabel).toBe('alpha');
  });
});
