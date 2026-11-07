const os = await import('node:os');
const fs = await import('node:fs');
const debugDataDir = os.tmpdir() + '/squish-debug-' + Date.now();
process.env.SQUISH_DATA_DIR = debugDataDir;
process.env.DATABASE_URL = '';
fs.mkdirSync(debugDataDir, { recursive: true });
const { resetDb, getDb } = await import('../db/index.ts');
const { rememberMemory, search } = await import('../core/memory/memories.ts');
resetDb();
await rememberMemory({ content: 'the quick brown fox jumps over the lazy dog', type: 'observation', tags: ['squish_chunk:summary', 'squish_session:test', 'agent:cli'] });
await rememberMemory({ content: 'router bug fixed by explicit ordering', type: 'note', tags: ['squish_chunk:decision', 'squish_session:test', 'agent:cli'] });

const sqlite1 = (await getDb() as any).$client;
const ftsTest1 = sqlite1.prepare(`SELECT m.id, m.content FROM memories_fts JOIN memories m ON memories_fts.rowid = m.rowid WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`).all('"router"', 10);
console.log('FTS5 manual "router":', ftsTest1);
const ftsTest2 = sqlite1.prepare(`SELECT m.id, m.content FROM memories_fts JOIN memories m ON memories_fts.rowid = m.rowid WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`).all('"router" OR "bug"', 10);
console.log('FTS5 manual "router" OR "bug":', ftsTest2);
const ftsTest3 = sqlite1.prepare(`SELECT m.id, m.content FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`).all('"router"', 10);
console.log('FTS5 just on fts table:', ftsTest3);

const s1 = await search({ query: 'router bug', limit: 10 });
console.log('plain search results:', s1.length, s1.map(x => x.content.slice(0, 50)));
const s2 = await search({ query: 'router bug', limit: 10, tags: ['squish_chunk:'] });
console.log('tagged search results:', s2.length, s2.map(x => x.content.slice(0, 50)));

// This file uses top-level await, so it must be a module: the package is
// `"type": "module"` but nothing above is an import/export declaration.
export {};
