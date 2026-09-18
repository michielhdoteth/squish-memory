/**
 * Re-embedding worker (Batch 4).
 *
 * Finds memories whose embedding_model stamp differs from the CURRENT
 * embedding configuration ("pending reembed" rows - conceptually marked via
 * model-stamp mismatch) and re-embeds their content, writing the fresh
 * L2-normalized blob + JSON + stamps.
 *
 * Batched (500), resumable by construction: every processed row gets the
 * current stamp, so an interrupted run simply continues where it stopped.
 *
 * Usage:
 *   bun scripts/reembed.ts --dry-run          # count + breakdown only
 *   bun scripts/reembed.ts                    # migrate everything stale
 *   bun scripts/reembed.ts --batch 250        # custom batch size
 *   bun scripts/reembed.ts --wait-model 180   # seconds to wait for bundled model
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function argFlag(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

const dryRun = process.argv.includes('--dry-run');
const batchSize = Math.max(1, parseInt(argFlag('--batch', '500'), 10) || 500);
const waitModelSec = Math.max(0, parseInt(argFlag('--wait-model', '30'), 10) || 0);

// Isolated-ish environment is NOT applied here on purpose: this operates on
// the REAL data dir. DATABASE_URL passthrough enables team-mode runs.
delete process.env.SQUISH_VECTOR_SCAN; // irrelevant for writes

async function main(): Promise<void> {
  const { getEmbedding, activeEmbeddingModel, ensureLocalModelReady, embeddingDim } =
    await import('../core/embeddings/embeddings.js');
  const { enrichContent } = await import('../core/retrieval/contextual-enrichment.js');
  const { prepareEmbedding } = await import('../core/lib/utils.js');

  // Block until the real model is available (writes must not mix models).
  if (waitModelSec > 0) {
    process.stdout.write(`waiting up to ${waitModelSec}s for bundled model...\n`);
    const ready = await ensureLocalModelReady(waitModelSec * 1000);
    if (!ready && !dryRun) {
      console.warn('warning: bundled model not ready; proceeding with current provider resolution');
    }
  }

  const currentModel = activeEmbeddingModel();
  console.log(`current embedding model: ${currentModel} (dim=${embeddingDim()})`);

  // getDbClient (not raw getDb) so pre-Batch-4 databases go through the
  // schema-drift auto-heal that adds embedding_blob/model/dim columns.
  const { getDbClient } = await import('../core/lib/db-client.js');
  const { raw } = await getDbClient();
  const sqlite = (raw as any).$client ?? raw;

  const countStmt = sqlite.prepare(
    'SELECT COUNT(*) AS c FROM memories WHERE content IS NOT NULL AND content != \'\' AND (embedding_model IS NULL OR embedding_model != ?)'
  );
  const totalPending = (countStmt.get(currentModel) as { c: number }).c;

  if (totalPending === 0) {
    console.log('nothing to do: all memory embeddings match the current model.');
    return;
  }

  const breakdown = sqlite.prepare(
    'SELECT COALESCE(embedding_model, \'(null)\') AS model, COUNT(*) AS c FROM memories ' +
    'WHERE content IS NOT NULL AND content != \'\' AND (embedding_model IS NULL OR embedding_model != ?) GROUP BY model ORDER BY c DESC'
  ).all(currentModel) as Array<{ model: string; c: number }>;

  console.log(`\npending reembed: ${totalPending} row(s)`);
  for (const b of breakdown) {
    console.log(`  ${b.model.padEnd(48)} ${b.c}`);
  }

  if (dryRun) {
    console.log('\ndry-run: no changes written. Re-run without --dry-run to migrate.');
    return;
  }

  const selectStmt = sqlite.prepare(
    'SELECT id, type, tags, content FROM memories WHERE content IS NOT NULL AND content != \'\' AND (embedding_model IS NULL OR embedding_model != ?) LIMIT ?'
  );
  const updateStmt = sqlite.prepare(
    'UPDATE memories SET embedding_json = ?, embedding_blob = ?, embedding_model = ?, embedding_dim = ?, updated_at = updated_at WHERE id = ?'
  );

  let processed = 0;
  let failed = 0;
  const startedAt = Date.now();

  while (processed + failed < totalPending) {
    const rows = selectStmt.all(currentModel, batchSize) as Array<{
      id: string; type: string | null; tags: string | null; content: string;
    }>;
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        const enriched = enrichContent(row.content, {
          type: row.type ?? undefined,
          tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : undefined,
        });
        const vector = await getEmbedding(enriched.enriched);
        if (!vector || vector.length === 0) {
          failed += 1;
          continue;
        }
        const values = prepareEmbedding(vector, { model: currentModel });
        updateStmt.run(values.embeddingJson, values.embeddingBlob, values.embeddingModel, values.embeddingDim, row.id);
        processed += 1;
      } catch (error) {
        failed += 1;
        console.warn(`failed to re-embed ${row.id}: ${(error as Error).message}`);
      }
    }

    const done = processed + failed;
    const rate = done / ((Date.now() - startedAt) / 1000);
    process.stdout.write(`\rprogress: ${done}/${totalPending} (${rate.toFixed(1)} rows/s)   `);
  }

  console.log(`\n\ndone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${processed} re-embedded, ${failed} failed`);
}

const isDirectRun = typeof Bun !== 'undefined'
  ? import.meta.main
  : process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
