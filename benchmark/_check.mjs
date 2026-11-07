import Database from 'better-sqlite3';
const db = new Database('benchmark/.bench-data/squish.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));
const memCount = db.prepare("SELECT COUNT(*) as n FROM memories").get().n;
const projCount = db.prepare("SELECT COUNT(*) as n FROM projects").get().n;
const entCount = db.prepare("SELECT COUNT(*) as n FROM entities").get().n;
console.log(`Memories: ${memCount}, Projects: ${projCount}, Entities: ${entCount}`);
// Check edges table
try {
  const edgeCount = db.prepare("SELECT COUNT(*) as n FROM edges").get().n;
  console.log(`Edges: ${edgeCount}`);
} catch(e) {
  console.log('No edges table:', e.message);
}
db.close();
