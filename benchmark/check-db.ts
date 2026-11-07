import Database from 'bun:sqlite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(resolve(__dirname, '.bench-data/squish.db'));

const memoryCount = db.query('SELECT count(*) as c FROM memories').get() as any;
console.log('Memories:', memoryCount.c);

const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
console.log('Tables:', tables.map((t: any) => t.name).join(', '));

try {
  const ec = db.query('SELECT count(*) as c FROM knowledge_entities').get() as any;
  console.log('Knowledge entities:', ec.c);
} catch { console.log('knowledge_entities: NOT FOUND'); }

try {
  const rc = db.query('SELECT count(*) as c FROM knowledge_relations').get() as any;
  console.log('Knowledge relations:', rc.c);
} catch { console.log('knowledge_relations: NOT FOUND'); }

// Check projects
try {
  const projects = db.query("SELECT id, name FROM projects WHERE name LIKE 'locomo-bench%'").all() as any[];
  console.log('Benchmark projects:', projects.length);
  for (const p of projects) {
    const memCount = db.query('SELECT count(*) as c FROM memories WHERE project_id = ?').get(p.id) as any;
    console.log(`  ${p.name}: ${memCount.c} memories`);
  }
} catch (e) { console.log('projects query failed:', e); }

// Check embeddings
try {
  const withEmbeddings = db.query("SELECT count(*) as c FROM memories WHERE embedding_json IS NOT NULL AND embedding_json != ''").get() as any;
  console.log('Memories with embeddings:', withEmbeddings.c);
} catch { console.log('embedding check failed'); }

db.close();
