/**
 * Global bun-test preload (Batch 4, extended Batch 5).
 *
 * Pins network-dependent features OFF for the whole suite so runs stay
 * deterministic and offline:
 *
 * - SQUISH_LOCAL_BUNDLED_MODEL=off: the local embedding provider's background
 *   bundled-model loader would attempt a network download during tests and -
 *   on machines with a warm HF cache - silently switch the corpus to 384-dim
 *   vectors mid-run, making dimension-sensitive assertions nondeterministic.
 *
 * - SQUISH_RERANKER_ENABLED=false: the cross-encoder reranker is default-ON
 *   in production since Batch 5; left enabled it would attempt an ~80MB model
 *   download inside every search-using test. Default-flip tests exercise the
 *   production defaults via explicit env objects instead.
 *
 * - SQUISH_DATA_DIR: always pinned to a fresh per-process temp directory,
 *   replacing any inherited value. Without this the data dir can resolve to the global
 *   `~/.squish`, and any test that reaches `getDb()` / `getSchema()` without
 *   pinning its own `SQUISH_DATA_DIR` opens the developer's LIVE memory
 *   database read-write. Tests that pin their own temp dir still win: they
 *   assign `process.env.SQUISH_DATA_DIR` after this preload has run.
 * - DATABASE_URL: always blanked before imports. Tests that need a disposable
 *   PostgreSQL instance must configure it explicitly after the preload.
 * - Hosted model access: provider keys are cleared and hosted decision egress
 *   is disabled. Tests can opt into a local stub within the test itself.
 *
 * Individual tests that exercise these paths can override the variables
 * explicitly before importing product modules.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
process.env.SQUISH_RERANKER_ENABLED = 'false';
process.env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED = 'false';

// Never trust inherited paths: a relative SQUISH_DATA_DIR is rejected by the
// runtime and would otherwise silently fall back to the operator's ~/.squish.
// Bun runs this preload before test modules, so every file starts isolated.
process.env.SQUISH_DATA_DIR = mkdtempSync(join(tmpdir(), 'squish-test-'));
process.env.DATABASE_URL = '';

for (const key of Object.keys(process.env)) {
  if (/(?:API_KEY|API_TOKEN)$/.test(key)) delete process.env[key];
}
