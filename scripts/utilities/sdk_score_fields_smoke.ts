/**
 * Smoke test: SDK search results must expose finalScore + scoreBreakdown
 * (Batch 3-5 review, minor hardening).
 */
process.env.SQUISH_DATA_DIR = process.env.SQUISH_DATA_DIR || '.squish-sdk-smoke-' + Date.now();
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
process.env.DATABASE_URL = '';
process.env.SQUISH_RERANKER_ENABLED = 'false';
process.env.SQUISH_MMR_ENABLED = 'false';

const { SquishClient } = await import('../../packages/core-sdk/src/index.js');
const { closeAllDbs } = await import('../../db/index.js');

const client = new SquishClient();
await client.remember('Deploy checklist: verify migrations before shipping the API');
const results = await client.search('deploy checklist api', { limit: 3 });

if (results.length === 0) throw new Error('no results');
const r = results[0];
console.log('score:', r.score?.toFixed(4));
console.log('finalScore:', r.finalScore?.toFixed(4));
console.log('semanticScore:', r.semanticScore?.toFixed(4));
console.log('boostScore:', r.boostScore?.toFixed(4));
console.log('scoreBreakdown:', JSON.stringify(r.scoreBreakdown));

if (typeof r.finalScore !== 'number') throw new Error('finalScore missing on SDK result');
if (typeof r.scoreBreakdown !== 'object') throw new Error('scoreBreakdown missing on SDK result');
if (Math.abs(r.score - r.finalScore) > 1e-9) throw new Error('score != finalScore');

await closeAllDbs();
console.log('SDK SMOKE OK');
