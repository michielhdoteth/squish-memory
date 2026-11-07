/**
 * Tests for the decision layer config getters (ADR-004 env surface).
 *
 * config.ts reads env lazily through getters but settings.json is loaded at
 * module init, so the established pattern is to read config in a spawned
 * subprocess with a controlled environment (same as launch-config.test.ts).
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const runtimeExecutable = process.execPath;

const READ_SCRIPT = `
  import { config } from './config.ts';
  console.log(JSON.stringify({
    decisionLayerEnabled: config.decisionLayerEnabled,
    decisionModelEnabled: config.decisionModelEnabled,
    decisionHostedEgressEnabled: config.decisionHostedEgressEnabled,
    decisionModelProvider: config.decisionModelProvider,
    decisionModelBackend: config.decisionModelBackend,
    decisionSystemOneProvider: config.decisionSystemOneProvider,
    decisionSystemOneBaseUrl: config.decisionSystemOneBaseUrl,
    decisionSystemOneModel: config.decisionSystemOneModel,
    decisionConfidenceThreshold: config.decisionConfidenceThreshold,
    decisionRouteTimeoutMs: config.decisionRouteTimeoutMs,
    decisionClassifyTimeoutMs: config.decisionClassifyTimeoutMs,
    promptGateEnabled: config.promptGateEnabled,
    promptGateModelEscalation: config.promptGateModelEscalation,
    promptGateTimeoutMs: config.promptGateTimeoutMs,
  }));
`;

/** Decision-layer env keys, omitted from the subprocess env unless overridden. */
const DECISION_ENV_KEYS = [
  'SQUISH_DECISION_LAYER_ENABLED',
  'SQUISH_DECISION_MODEL_ENABLED',
  'SQUISH_DECISION_HOSTED_EGRESS_ENABLED',
  'SQUISH_DECISION_MODEL_PROVIDER',
  'SQUISH_DECISION_MODEL_BACKEND',
  'SQUISH_DECISION_SYSTEMONE_PROVIDER',
  'SQUISH_DECISION_SYSTEMONE_BASE_URL',
  'SQUISH_DECISION_SYSTEMONE_MODEL',
  'SQUISH_DECISION_CONFIDENCE_THRESHOLD',
  'SQUISH_DECISION_ROUTE_TIMEOUT_MS',
  'SQUISH_DECISION_CLASSIFY_TIMEOUT_MS',
  'SQUISH_PROMPT_GATE_ENABLED',
  'SQUISH_PROMPT_GATE_MODEL_ESCALATION',
  'SQUISH_PROMPT_GATE_TIMEOUT_MS',
] as const;

function readConfig(envOverrides: Record<string, string>): Record<string, unknown> {
  const tempDataDir = mkdtempSync(join(tmpdir(), 'squish-decision-config-'));
  try {
    // Copy ambient env but drop every decision-layer key: setting them to ''
    // would NOT neutralize them (getBoolean('') is false, getNumber('') is 0),
    // while omitting them restores the config defaults.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    for (const key of DECISION_ENV_KEYS) delete env[key];
    Object.assign(env, { DATABASE_URL: '', SQUISH_DATA_DIR: tempDataDir }, envOverrides);

    const result = spawnSync(
      runtimeExecutable,
      ['-e', READ_SCRIPT],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env,
      },
    );
    if (result.status !== 0) {
      throw new Error(`config read failed: ${result.stderr}`);
    }
    const line = (result.stdout as string).trim().split('\n').pop() ?? '';
    return JSON.parse(line) as Record<string, unknown>;
  } finally {
    try { rmSync(tempDataDir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

describe('decision layer config', () => {
  test('all flags default safe/off, gate toggle defaults true', () => {
    const cfg = readConfig({});
    expect(cfg.decisionLayerEnabled).toBe(false);
    expect(cfg.decisionModelEnabled).toBe(false);
    expect(cfg.decisionHostedEgressEnabled).toBe(false);
    expect(cfg.decisionModelProvider).toBe('auto');
    // Backend default preserves the LLM escalation path (Phase B4).
    expect(cfg.decisionModelBackend).toBe('llm');
    // System One defaults: local ollaya private preset, preset-driven
    // baseUrl/model (empty override = use preset).
    expect(cfg.decisionSystemOneProvider).toBe('ollaya');
    expect(cfg.decisionSystemOneBaseUrl).toBe('');
    expect(cfg.decisionSystemOneModel).toBe('');
    expect(cfg.decisionConfidenceThreshold).toBe(0.7);
    expect(cfg.decisionRouteTimeoutMs).toBe(300);
    expect(cfg.decisionClassifyTimeoutMs).toBe(1000);
    expect(cfg.promptGateEnabled).toBe(true);
    expect(cfg.promptGateModelEscalation).toBe(false);
    expect(cfg.promptGateTimeoutMs).toBe(300);
  });

  test('env vars override defaults', () => {
    const cfg = readConfig({
      SQUISH_DECISION_LAYER_ENABLED: 'true',
      SQUISH_DECISION_MODEL_ENABLED: '1',
      SQUISH_DECISION_HOSTED_EGRESS_ENABLED: 'true',
      SQUISH_DECISION_MODEL_PROVIDER: 'ollama',
      SQUISH_DECISION_MODEL_BACKEND: 'systemone',
      SQUISH_DECISION_SYSTEMONE_PROVIDER: 'openrouter',
      SQUISH_DECISION_SYSTEMONE_BASE_URL: 'https://proxy.internal/v1',
      SQUISH_DECISION_SYSTEMONE_MODEL: 'typesafe/jev-1.13',
      SQUISH_DECISION_CONFIDENCE_THRESHOLD: '0.85',
      SQUISH_DECISION_ROUTE_TIMEOUT_MS: '250',
      SQUISH_DECISION_CLASSIFY_TIMEOUT_MS: '900',
      SQUISH_PROMPT_GATE_ENABLED: 'false',
      SQUISH_PROMPT_GATE_MODEL_ESCALATION: 'true',
      SQUISH_PROMPT_GATE_TIMEOUT_MS: '400',
    });
    expect(cfg.decisionLayerEnabled).toBe(true);
    expect(cfg.decisionModelEnabled).toBe(true);
    expect(cfg.decisionHostedEgressEnabled).toBe(true);
    expect(cfg.decisionModelProvider).toBe('ollama');
    expect(cfg.decisionModelBackend).toBe('systemone');
    expect(cfg.decisionSystemOneProvider).toBe('openrouter');
    expect(cfg.decisionSystemOneBaseUrl).toBe('https://proxy.internal/v1');
    expect(cfg.decisionSystemOneModel).toBe('typesafe/jev-1.13');
    expect(cfg.decisionConfidenceThreshold).toBe(0.85);
    expect(cfg.decisionRouteTimeoutMs).toBe(250);
    expect(cfg.decisionClassifyTimeoutMs).toBe(900);
    expect(cfg.promptGateEnabled).toBe(false);
    expect(cfg.promptGateModelEscalation).toBe(true);
    expect(cfg.promptGateTimeoutMs).toBe(400);
  });

  test('backend=off is accepted explicitly', () => {
    const cfg = readConfig({ SQUISH_DECISION_MODEL_BACKEND: 'off' });
    expect(cfg.decisionModelBackend).toBe('off');
  });

  test('invalid explicit LLM-backed decision provider does not fall back to auto', () => {
    const cfg = readConfig({ SQUISH_DECISION_MODEL_PROVIDER: 'not-a-provider' });
    expect(cfg.decisionModelProvider).toBe('invalid');
  });

  test('invalid explicit backend fails closed to rules-only', () => {
    const cfg = readConfig({ SQUISH_DECISION_MODEL_BACKEND: 'whichever' });
    expect(cfg.decisionModelBackend).toBe('off');
  });

  test('invalid explicit System One provider is rejected instead of selecting ollaya', () => {
    const cfg = readConfig({ SQUISH_DECISION_SYSTEMONE_PROVIDER: 'vercel-but-worse' });
    expect(cfg.decisionSystemOneProvider).toBe('invalid');
  });

  test('systemone provider accepts every registered preset id', () => {
    for (const id of ['ollaya', 'openrouter', 'typesafe', 'laya', 'cloudflare', 'vercel']) {
      const cfg = readConfig({ SQUISH_DECISION_SYSTEMONE_PROVIDER: id });
      expect(cfg.decisionSystemOneProvider).toBe(id);
    }
  });

  test('invalid numbers fall back to defaults', () => {
    const cfg = readConfig({
      SQUISH_DECISION_CONFIDENCE_THRESHOLD: 'abc',
      SQUISH_DECISION_ROUTE_TIMEOUT_MS: 'NaN',
    });
    expect(cfg.decisionConfidenceThreshold).toBe(0.7);
    expect(cfg.decisionRouteTimeoutMs).toBe(300);
  });
});
