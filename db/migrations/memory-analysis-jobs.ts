import type { Database } from 'better-sqlite3';

export async function runMemoryAnalysisJobsMigrations(sqlite: Database): Promise<void> {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory_analysis_jobs (
      id TEXT PRIMARY KEY,
      source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      job_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      locked_at INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(source_memory_id, job_kind)
    );
    CREATE INDEX IF NOT EXISTS memory_analysis_jobs_status_available_idx
      ON memory_analysis_jobs(status, available_at);
    CREATE INDEX IF NOT EXISTS memory_analysis_jobs_project_idx
      ON memory_analysis_jobs(project_id);
  `);
}
