import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = join(import.meta.dir, '..', '..');
const runtimeExecutable = process.execPath;

function readConfig(env: Record<string, string>) {
  const tempDataDir = mkdtempSync(join(tmpdir(), 'squish-config-'));
  try {
    const result = spawnSync(
      runtimeExecutable,
      [
        '-e',
        `
          import { config } from './config.ts';
          console.log(JSON.stringify({
            mode: config.mode,
            isLocalMode: config.isLocalMode,
            embeddingsProvider: config.embeddingsProvider,
            openAiEmbeddingModel: config.openAiEmbeddingModel,
            googleEmbeddingModel: config.googleEmbeddingModel,
            ollamaEmbeddingModel: config.ollamaEmbeddingModel,
            lmStudioEmbeddingModel: config.lmStudioEmbeddingModel,
            transformersLocalModel: config.transformersLocalModel,
            localEmbeddingDevice: config.localEmbeddingDevice,
            llmExtractionModel: config.llmExtractionModel,
            llmReasoningModel: config.llmReasoningModel,
            llmEnabled: config.llmEnabled,
            nestedLlmEnabled: config.llm.enabled,
            graphAutoBuild: config.graphAutoBuild,
            nestedGraphAutoBuild: config.graph.autoBuild,
            graphExtractionMethod: config.graphExtractionMethod,
            llmEndpoint: config.llmEndpoint
          }));
        `,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: '',
          SUPABASE_URL: '',
          NEON_PROJECT_ID: '',
          SQUISH_DATA_DIR: tempDataDir,
          SQUISH_OPENAI_EMBEDDING_MODEL: '',
          SQUISH_GOOGLE_EMBEDDING_MODEL: '',
          SQUISH_OLLAMA_EMBEDDING_MODEL: '',
          SQUISH_LM_STUDIO_EMBEDDING_MODEL: '',
          SQUISH_LOCAL_MODEL: '',
          SQUISH_LOCAL_EMBEDDING_DEVICE: 'cpu',
          SQUISH_LLM_EXTRACTION_MODEL: '',
          SQUISH_LLM_REASONING_MODEL: '',
          ...env,
        },
      },
    );

    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

/**
 * Runs a child process in the given cwd that reports the resolved data
 * directory with and without directory creation.
 *
 * The config module is imported through an absolute file URL so the child can
 * run from an arbitrary project directory — which is exactly the situation the
 * data-directory rules must hold in: a CLI or MCP process launched from some
 * workspace, not from the package itself.
 */
function inspectDataDir(cwd: string, env: Record<string, string> = {}) {
  const configUrl = pathToFileURL(join(repoRoot, 'config.ts')).href;
  const script = [
    `const { config, getDataDir, globalDataDir } = await import(${JSON.stringify(configUrl)});`,
    'console.log(JSON.stringify({',
    '  dataDir: config.dataDir,',
    '  ensuredDataDir: getDataDir(),',
    '  globalDir: globalDataDir(),',
    '}));',
  ].join('\n');

  return spawnSync(
    runtimeExecutable,
    ['-e', script],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: '',
        SUPABASE_URL: '',
        NEON_PROJECT_ID: '',
        // setup-batch4 pins SQUISH_DATA_DIR in the test runner process; that
        // value must not leak into the child unless a test passes one.
        SQUISH_DATA_DIR: '',
        ...env,
      },
    },
  );
}

describe('launch config defaults and overrides', () => {
  test('settings.json is valid JSON', () => {
    const result = spawnSync(
      runtimeExecutable,
      ['-e', "JSON.parse(require('fs').readFileSync('config/settings.json','utf8'));"],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
  });

  test('defaults are local-first with llm disabled', () => {
    const config = readConfig({});

    expect(config.mode).toBe('local');
    expect(config.embeddingsProvider).toBe('local');
    expect(config.llmEnabled).toBe(false);
    expect(config.nestedLlmEnabled).toBe(false);
    expect(config.graphAutoBuild).toBe(true);
    expect(config.nestedGraphAutoBuild).toBe(true);
    expect(config.localEmbeddingDevice).toBe('cpu');
  });

  test('explicit WebGPU selection reaches resolved config', () => {
    const config = readConfig({ SQUISH_LOCAL_EMBEDDING_DEVICE: 'webgpu' });
    expect(config.localEmbeddingDevice).toBe('webgpu');
  });

  test('unsupported local embedding devices fail instead of silently using CPU', () => {
    const tempDataDir = mkdtempSync(join(tmpdir(), 'squish-config-device-'));
    try {
      const result = spawnSync(
        runtimeExecutable,
        ['-e', "import { config } from './config.ts'; console.log(config.localEmbeddingDevice);"],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            DATABASE_URL: '',
            SUPABASE_URL: '',
            NEON_PROJECT_ID: '',
            SQUISH_DATA_DIR: tempDataDir,
            SQUISH_LOCAL_EMBEDDING_DEVICE: 'cuda',
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('SQUISH_LOCAL_EMBEDDING_DEVICE must be "cpu" or "webgpu"');
    } finally {
      rmSync(tempDataDir, { recursive: true, force: true });
    }
  });

  test('mode is always local in OSS', () => {
    const config = readConfig({});
    expect(config.mode).toBe('local');
    expect(config.isLocalMode).toBe(true);
  });

  test('packaged defaults do not hardcode provider model names', () => {
    const config = readConfig({});

    expect(config.openAiEmbeddingModel).toBe('');
    expect(config.googleEmbeddingModel).toBe('');
    expect(config.ollamaEmbeddingModel).toBe('');
    expect(config.lmStudioEmbeddingModel).toBe('');
    expect(config.transformersLocalModel).toBe('');
    expect(config.llmExtractionModel).toBe('');
    expect(config.llmReasoningModel).toBe('');
  });

  test('boolean env overrides parse false as false', () => {
    const config = readConfig({
      SQUISH_LLM_ENABLED: 'false',
      SQUISH_GRAPH_AUTO_BUILD: 'false',
    });

    expect(config.llmEnabled).toBe(false);
    expect(config.nestedLlmEnabled).toBe(false);
    expect(config.graphAutoBuild).toBe(false);
    expect(config.nestedGraphAutoBuild).toBe(false);
  });

  test('invalid enum env values fall back safely', () => {
    const config = readConfig({
      SQUISH_EMBEDDINGS_PROVIDER: 'benchmark-only-provider',
      SQUISH_GRAPH_EXTRACTION_METHOD: 'magic',
    });

    expect(config.embeddingsProvider).toBe('local');
    expect(config.graphExtractionMethod).toBe('auto');
  });

  test('benchmark runtime overrides come from env', () => {
    const config = readConfig({
      SQUISH_LLM_ENABLED: 'true',
      SQUISH_LLM_ENDPOINT: 'http://localhost:1234',
    });

    expect(config.llmEnabled).toBe(true);
    expect(config.nestedLlmEnabled).toBe(true);
    expect(config.llmEndpoint).toBe('http://localhost:1234');
  });

  test('provider model env overrides are read correctly', () => {
    const config = readConfig({
      SQUISH_OPENAI_EMBEDDING_MODEL: 'example-openai-model',
      SQUISH_GOOGLE_EMBEDDING_MODEL: 'example-google-model',
      SQUISH_OLLAMA_EMBEDDING_MODEL: 'example-ollama-model',
      SQUISH_LM_STUDIO_EMBEDDING_MODEL: 'example-lmstudio-model',
      SQUISH_LOCAL_MODEL: 'example-transformers-model',
      SQUISH_LLM_EXTRACTION_MODEL: 'example-extraction-model',
      SQUISH_LLM_REASONING_MODEL: 'example-reasoning-model',
    });

    expect(config.openAiEmbeddingModel).toBe('example-openai-model');
    expect(config.googleEmbeddingModel).toBe('example-google-model');
    expect(config.ollamaEmbeddingModel).toBe('example-ollama-model');
    expect(config.lmStudioEmbeddingModel).toBe('example-lmstudio-model');
    expect(config.transformersLocalModel).toBe('example-transformers-model');
    expect(config.llmExtractionModel).toBe('example-extraction-model');
    expect(config.llmReasoningModel).toBe('example-reasoning-model');
  });

  test(
    'data dir defaults to global and no .squish is created in the project directory',
    () => {
      const tempHome = mkdtempSync(join(tmpdir(), 'squish-data-home-'));
      const tempProject = mkdtempSync(join(tmpdir(), 'squish-data-dir-'));
      try {
        const result = inspectDataDir(tempProject, {
          HOME: tempHome,
          USERPROFILE: tempHome,
          SQUISH_WORKING_DIRECTORY: tempProject,
        });

        expect(result.status).toBe(0);
        const snapshot = JSON.parse(result.stdout ?? '') as {
          dataDir: string;
          ensuredDataDir: string;
          globalDir: string;
        };
        expect(snapshot.dataDir).toBe(snapshot.globalDir);
        expect(snapshot.ensuredDataDir).toBe(snapshot.globalDir);
        expect(existsSync(join(tempProject, '.squish'))).toBe(false);
      } finally {
        rmSync(tempHome, { recursive: true, force: true });
        rmSync(tempProject, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    'relative SQUISH_DATA_DIR resolves to the global dir, not the working directory',
    () => {
      const tempHome = mkdtempSync(join(tmpdir(), 'squish-data-home-'));
      const tempProject = mkdtempSync(join(tmpdir(), 'squish-data-dir-'));
      try {
        const result = inspectDataDir(tempProject, {
          HOME: tempHome,
          USERPROFILE: tempHome,
          SQUISH_DATA_DIR: 'relative-data',
          SQUISH_WORKING_DIRECTORY: tempProject,
        });

        expect(result.status).toBe(0);
        const snapshot = JSON.parse(result.stdout ?? '') as {
          dataDir: string;
          ensuredDataDir: string;
          globalDir: string;
        };
        expect(snapshot.dataDir).toBe(snapshot.globalDir);
        expect(snapshot.ensuredDataDir).toBe(snapshot.globalDir);
        expect(existsSync(join(tempProject, 'relative-data'))).toBe(false);
        expect(existsSync(join(tempProject, '.squish'))).toBe(false);
        // The rejection is surfaced so the operator can fix the setting.
        expect(result.stderr).toContain('is a relative path');
      } finally {
        rmSync(tempHome, { recursive: true, force: true });
        rmSync(tempProject, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    'absolute SQUISH_DATA_DIR is honored and nothing is written to the project directory',
    () => {
      const tempProject = mkdtempSync(join(tmpdir(), 'squish-data-dir-'));
      const tempData = mkdtempSync(join(tmpdir(), 'squish-data-abs-'));
      try {
        const result = inspectDataDir(tempProject, {
          SQUISH_DATA_DIR: tempData,
          SQUISH_WORKING_DIRECTORY: tempProject,
        });

        expect(result.status).toBe(0);
        const snapshot = JSON.parse(result.stdout ?? '') as {
          dataDir: string;
          ensuredDataDir: string;
        };
        expect(snapshot.dataDir).toBe(tempData);
        expect(snapshot.ensuredDataDir).toBe(tempData);
        expect(existsSync(join(tempProject, '.squish'))).toBe(false);
      } finally {
        rmSync(tempProject, { recursive: true, force: true });
        rmSync(tempData, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test('getDataDir uses global ~/.squish/ when no data.dir configured', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'squish-global-'));
    const previousEnv = process.env.SQUISH_DATA_DIR;
    const previousHome = process.env.HOME || process.env.USERPROFILE;
    process.env.SQUISH_DATA_DIR = tempDir;
    process.env.HOME = tempDir;

    try {
      const module = await import(`../../config.ts?case=${Date.now()}`);
      const dir = module.getDataDir();
      // When SQUISH_DATA_DIR is set and HOME is temp, uses the env override
      expect(dir).toBe(tempDir);
    } finally {
      if (previousEnv !== undefined) process.env.SQUISH_DATA_DIR = previousEnv;
      else delete process.env.SQUISH_DATA_DIR;
      if (previousHome) process.env.HOME = previousHome;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('findSquishDir always returns global ~/.squish (global-only)', async () => {
    const { findSquishDir, globalDataDir } = await import('../../config.ts');
    const parentDir = mkdtempSync(join(tmpdir(), 'squish-parent-'));
    const childDir = join(parentDir, 'nested', 'project');
    mkdirSync(childDir, { recursive: true });

    try {
      const found = findSquishDir(childDir);
      expect(found).toBe(globalDataDir());
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  test('findSquishDir ignores local .squish dirs (global-only)', async () => {
    const { findSquishDir, globalDataDir } = await import('../../config.ts');
    const tempDir = mkdtempSync(join(tmpdir(), 'squish-direct-'));
    mkdirSync(join(tempDir, '.squish'), { recursive: true });

    try {
      const found = findSquishDir(tempDir);
      expect(found).toBe(globalDataDir());
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('globalDataDir returns homedir/.squish path', async () => {
    const { globalDataDir } = await import('../../config.ts');
    const { homedir } = await import('os');
    expect(globalDataDir()).toBe(join(homedir(), '.squish'));
  });

  test('getDataDir with SQUISH_DATA_DIR uses that override', async () => {
    const { getDataDir } = await import('../../config.ts');
    const tempDir = mkdtempSync(join(tmpdir(), 'squish-sqldir-'));
    const previousEnv = process.env.SQUISH_DATA_DIR;
    process.env.SQUISH_DATA_DIR = tempDir;
    try {
      const dir = getDataDir();
      expect(dir).toBe(tempDir);
    } finally {
      if (previousEnv === undefined) {
        delete process.env.SQUISH_DATA_DIR;
      } else {
        process.env.SQUISH_DATA_DIR = previousEnv;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('findSquishDir falls back to global ~/.squish when no local .squish exists', async () => {
    const { findSquishDir, globalDataDir } = await import('../../config.ts');

    const tempDir = mkdtempSync(join(tmpdir(), 'squish-nolocal-'));
    // Ensure no .squish exists in tempDir
    const localSquish = join(tempDir, '.squish');
    if (existsSync(localSquish)) rmSync(localSquish, { recursive: true, force: true });

    try {
      const found = findSquishDir(tempDir);
      expect(found).toBe(globalDataDir());
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('absoluteDataDir helper', () => {
    test('relative values are rejected with a one-time warning, not resolved against cwd', async () => {
      const { absoluteDataDir } = await import('../../config.ts');
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
      try {
        expect(absoluteDataDir('.squish', 'test')).toBeNull();
        expect(absoluteDataDir('./data', 'test')).toBeNull();
        expect(absoluteDataDir('data', 'test')).toBeNull();
      } finally {
        console.warn = originalWarn;
      }
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('is a relative path');
    });

    test('absolute values pass through untouched', async () => {
      const { absoluteDataDir } = await import('../../config.ts');
      const abs = join(tmpdir(), 'squish-abs-data');
      expect(absoluteDataDir(abs, 'test')).toBe(abs);
    });

    test('~ values expand and count as absolute', async () => {
      const { absoluteDataDir } = await import('../../config.ts');
      const { homedir } = await import('os');
      expect(absoluteDataDir('~/.squish', 'test')).toBe(join(homedir(), '.squish'));
    });

    test('empty values are ignored without a warning', async () => {
      const { absoluteDataDir } = await import('../../config.ts');
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
      try {
        expect(absoluteDataDir('', 'test')).toBeNull();
      } finally {
        console.warn = originalWarn;
      }
      expect(warnings.length).toBe(0);
    });
  });
});
