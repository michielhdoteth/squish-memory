import { sqlLifecycleBound } from '../lib/timestamps.js';

interface SqliteClient {
  prepare(sql: string): { all(...parameters: unknown[]): Array<{ id: string }> };
}

interface PostgresClient {
  query(sql: string, parameters: unknown[]): Promise<{ rows: Array<{ id: string }> }>;
}

interface GraphSourceMemory {
  id: string;
  content: string;
}

/** Filter graph sources against their stored lifecycle values before projection. */
export async function filterGraphSourceMemories<T extends GraphSourceMemory>(
  client: SqliteClient | PostgresClient,
  projectId: string,
  memories: T[],
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<T[]> {
  let eligibleRows: Array<{ id: string }>;
  if ('prepare' in client && typeof client.prepare === 'function') {
    eligibleRows = client.prepare(`
      SELECT id FROM memories
      WHERE project_id = ? AND status = 'active' AND is_active = 1
        AND ${sqlLifecycleBound('valid_from', '<=')}
        AND ${sqlLifecycleBound('valid_to', '>')}
        AND ${sqlLifecycleBound('expires_at', '>')}
    `).all(projectId, nowSeconds, nowSeconds, nowSeconds);
  } else if ('query' in client && typeof client.query === 'function') {
    const result = await client.query(`
      SELECT id FROM memories
      WHERE project_id = $1 AND status = 'active' AND is_active = TRUE
        AND (valid_from IS NULL OR valid_from <= NOW())
        AND (valid_to IS NULL OR valid_to > NOW())
        AND (expires_at IS NULL OR expires_at > NOW())
    `, [projectId]);
    eligibleRows = result.rows;
  } else {
    throw new Error('Graph rebuild requires a supported database client for source lifecycle checks');
  }

  const eligibleIds = new Set(eligibleRows.map((row) => row.id));
  return memories.filter((memory) => eligibleIds.has(memory.id));
}
