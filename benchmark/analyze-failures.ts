import { readFileSync, readdirSync } from 'fs';
const data = JSON.parse(readFileSync('benchmark/locomo10.json', 'utf-8'));

// Check a few multi-hop failures
let mhFails = 0;
for (let ci = 0; ci < data.length && mhFails < 3; ci++) {
  const traceDir = `benchmark/traces/conv${ci}`;
  const files = readdirSync(traceDir);
  for (const f of files) {
    const trace = JSON.parse(readFileSync(`${traceDir}/${f}`, 'utf-8'));
    if (trace.categoryLabel === 'multi-hop' && trace.f1Score === 0 && mhFails < 3) {
      console.log(`\n=== MULTI-HOP FAIL: conv${ci}/${f} ===`);
      console.log(`Q: ${trace.question}`);
      console.log(`GT: ${trace.groundTruth}`);
      console.log(`Retrieved: ${trace.topKContent.length} items`);
      console.log(`Top 3:`);
      trace.topKContent.slice(0, 3).forEach((c: string) => console.log(`  ${c.slice(0, 120)}`));
      mhFails++;
    }
  }
}

// Check single-hop failures
let shFails = 0;
for (let ci = 0; ci < data.length && shFails < 3; ci++) {
  const traceDir = `benchmark/traces/conv${ci}`;
  const files = readdirSync(traceDir);
  for (const f of files) {
    const trace = JSON.parse(readFileSync(`${traceDir}/${f}`, 'utf-8'));
    if (trace.categoryLabel === 'single-hop' && trace.f1Score === 0 && shFails < 3) {
      console.log(`\n=== SINGLE-HOP FAIL: conv${ci}/${f} ===`);
      console.log(`Q: ${trace.question}`);
      console.log(`GT: ${trace.groundTruth}`);
      console.log(`Retrieved: ${trace.topKContent.length} items`);
      console.log(`Top 3:`);
      trace.topKContent.slice(0, 3).forEach((c: string) => console.log(`  ${c.slice(0, 120)}`));
      shFails++;
    }
  }
}
