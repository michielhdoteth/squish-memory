import { readFileSync, readdirSync } from 'fs';

// Check score distributions for failures vs successes
let failScores: number[] = [];
let successScores: number[] = [];

for (let ci = 0; ci < 10; ci++) {
  const traceDir = `benchmark/traces/conv${ci}`;
  try {
    const files = readdirSync(traceDir);
    for (const f of files) {
      const trace = JSON.parse(readFileSync(`${traceDir}/${f}`, 'utf-8'));
      if (trace.categoryLabel === 'single-hop') {
        if (trace.f1Score === 0) {
          failScores.push(trace.retrievalHits);
        } else if (trace.f1Score >= 0.8) {
          successScores.push(trace.retrievalHits);
        }
      }
    }
  } catch {}
}

console.log(`Single-hop failures: ${failScores.length}, avg hits: ${(failScores.reduce((a,b)=>a+b,0)/failScores.length).toFixed(1)}`);
console.log(`Single-hop successes: ${successScores.length}, avg hits: ${(successScores.reduce((a,b)=>a+b,0)/successScores.length).toFixed(1)}`);

// Check how many failures have 50 hits (all results returned)
const failWith50 = failScores.filter(s => s === 50).length;
console.log(`Failures with 50 hits (max): ${failWith50}/${failScores.length} (${(failWith50/failScores.length*100).toFixed(1)}%)`);
