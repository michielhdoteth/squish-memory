import { createHash } from 'node:crypto';
import { callLLMWithContent } from '../llm/client.js';
import { getDbClient } from '../lib/db-client.js';
import { extractFacts, type FactExtractionResult } from './fact-extractor.js';
import { knowledgeFromMemory } from '../knowledge/extractor.js';

const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;
const LEASE_SECONDS = 15 * 60;

type AnalysisJob = { id: string; source_memory_id: string; project_id: string; attempts: number; locked_at: number };
type SourceMemory = { content: string; type: string };
export type FactExtractor = (text: string) => Promise<FactExtractionResult>;
export interface ProcessMemoryAnalysisOptions {
  extract?: FactExtractor;
  limit?: number;
  now?: () => number;
}

const defaultExtractor: FactExtractor = async (text) => {
  const result = await extractFacts(text, async (prompt, maxTokens) => {
    const response = await callLLMWithContent({ prompt, maxTokens });
    if (response === null) throw new Error('LLM unavailable');
    return response;
  });
  return result;
};

function deterministicFactId(jobId: string, factIndex: number): string {
  return createHash('sha256').update(`${jobId}:${factIndex}`).digest('hex');
}

function deterministicProjectionId(jobId: string, kind: string, key: string): string {
  return createHash('sha256').update(`${jobId}:${kind}:${key}`).digest('hex');
}

function normalizedBeliefKey(statement: string): string {
  return statement.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export async function processMemoryAnalysisJobs(options: ProcessMemoryAnalysisOptions = {}): Promise<{ processed: number; projected: number; skipped: number; retried: number }> {
  const { raw } = await getDbClient();
  const sqlite = raw.$client;
  const now = options.now ?? Date.now;
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 10)));
  const timestamp = Math.floor(now() / 1000);
  const selectionTime = Math.max(timestamp, Math.floor(Date.now() / 1000));
  sqlite.prepare("UPDATE memory_analysis_jobs SET status='failed', locked_at=NULL, last_error_code='FACT_EXTRACTION_ATTEMPTS_EXHAUSTED', updated_at=? WHERE status='processing' AND locked_at<=? AND attempts>=? AND job_kind='analyze_memory'")
    .run(timestamp, selectionTime - LEASE_SECONDS, MAX_ATTEMPTS);
  const selected = sqlite.prepare(`SELECT id FROM memory_analysis_jobs
    WHERE ((status='pending' AND available_at<=?) OR (status='processing' AND locked_at<=?))
      AND job_kind='analyze_memory' ORDER BY available_at, created_at LIMIT ?`).all(selectionTime, selectionTime - LEASE_SECONDS, limit) as Array<{ id: string }>;
  const jobs: AnalysisJob[] = [];
  for (const candidate of selected) {
    const claim = sqlite.prepare("UPDATE memory_analysis_jobs SET status='processing', locked_at=?, attempts=attempts+1, updated_at=? WHERE id=? AND attempts<? AND ((status='pending' AND available_at<=?) OR (status='processing' AND locked_at<=?))")
      .run(timestamp, timestamp, candidate.id, MAX_ATTEMPTS, selectionTime, selectionTime - LEASE_SECONDS);
    if (claim.changes !== 1) continue;
    const claimed = sqlite.prepare('SELECT id, source_memory_id, project_id, attempts, locked_at FROM memory_analysis_jobs WHERE id=?').get(candidate.id) as AnalysisJob | undefined;
    if (!claimed) continue;
    jobs.push(claimed);
  }
  let projected = 0;
  let skipped = 0;
  let retried = 0;

  for (const job of jobs) {
    const source = sqlite.prepare(`SELECT content, type FROM memories WHERE id=? AND project_id=? AND is_active=1 AND status='active' AND is_encrypted=0 AND content IS NOT NULL AND length(trim(content))>0`).get(job.source_memory_id, job.project_id) as SourceMemory | undefined;
    if (!source) {
      const skippedResult = sqlite.prepare("UPDATE memory_analysis_jobs SET status='skipped', locked_at=NULL, updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?").run(Math.floor(now() / 1000), job.id, job.attempts, job.locked_at, Math.floor(now() / 1000) - LEASE_SECONDS);
      if (skippedResult.changes === 1) skipped++;
      continue;
    }
    try {
      const extraction = await (options.extract ?? defaultExtractor)(source.content);
      const derived = knowledgeFromMemory({ memoryId: job.source_memory_id, content: source.content, type: source.type ?? 'note' }, {
        projectId: job.project_id, sourceType: 'memory', sourceId: job.source_memory_id,
      });
      const committedAt = Math.floor(now() / 1000);
      const commit = sqlite.transaction(() => {
        const owned = sqlite.prepare("SELECT 1 FROM memory_analysis_jobs WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?").get(job.id, job.attempts, job.locked_at, committedAt - LEASE_SECONDS);
        if (!owned) return false;
        const eligibleSource = sqlite.prepare(`SELECT 1 FROM memories WHERE id=? AND project_id=? AND is_active=1 AND status='active' AND is_encrypted=0 AND content IS NOT NULL AND length(trim(content))>0`).get(job.source_memory_id, job.project_id);
        if (!eligibleSource) {
          const skippedResult = sqlite.prepare("UPDATE memory_analysis_jobs SET status='skipped', locked_at=NULL, updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?")
            .run(committedAt, job.id, job.attempts, job.locked_at, committedAt - LEASE_SECONDS);
          return skippedResult.changes === 1 ? 'skipped' as const : false;
        }
        for (let index = 0; index < extraction.facts.length; index++) {
          const fact = extraction.facts[index]!;
          const id = deterministicFactId(job.id, index);
          const metadata = JSON.stringify({ sourceMemoryId: job.source_memory_id, analysisJobId: job.id, factIndex: index, entities: fact.entities, ...(fact.relation ? { relation: fact.relation } : {}) });
          const tags = JSON.stringify([...new Set(['extracted-fact', ...fact.entities])]);
          sqlite.prepare(`INSERT OR IGNORE INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, confidence, confidence_level, status, is_active, tags, metadata, created_at, updated_at) VALUES (?, ?, 'memory', 'fact', ?, ?, 'certain', 'active', 1, ?, ?, ?, ?)`).run(id, job.project_id, fact.content, fact.confidence, tags, metadata, committedAt, committedAt);
        }
        for (let index = 0; index < derived.length; index++) {
          const projection = derived[index]!;
          if (projection.kind === 'belief') {
            const belief = projection.data;
            const normalizedKey = normalizedBeliefKey(belief.statement);
            const existing = sqlite.prepare("SELECT id, knowledge_type, content, confidence, status, reason, evidence_summary FROM knowledge WHERE project_id=? AND knowledge_kind='belief' AND normalized_key=? ORDER BY created_at LIMIT 1")
              .get(job.project_id, normalizedKey) as { id: string; knowledge_type: string; content: string; confidence: number; status: string; reason: string | null; evidence_summary: string | null } | undefined;
            const id = existing?.id ?? deterministicProjectionId(job.id, 'belief', `${belief.type}:${normalizedKey}`);
            if (!existing) {
              const metadata = JSON.stringify({ sourceMemoryId: job.source_memory_id, analysisJobId: job.id, projectionKind: 'belief', projectionIndex: index });
              sqlite.prepare(`INSERT OR IGNORE INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, confidence, confidence_level, normalized_key, reason, evidence_summary, source_count, status, tags, metadata, created_at, updated_at) VALUES (?, ?, 'belief', ?, ?, ?, 'certain', ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
                .run(id, job.project_id, belief.type, belief.statement, belief.confidence, normalizedKey, belief.reason ?? null, belief.evidenceSummary ?? null, belief.status, JSON.stringify(['auto-extracted']), metadata, committedAt, committedAt);
            }
            const edgeId = deterministicProjectionId(job.id, 'belief-edge', id);
            const sourceEdge = sqlite.prepare(`INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, created_at) VALUES (?, ?, 'knowledge', ?, 'knowledge', 'sourced_from', ?)`)
              .run(edgeId, id, job.source_memory_id, committedAt);
            if (sourceEdge.changes === 1) {
              const nextStatus = belief.type === 'failure_cause' ? 'disputed'
                : existing && existing.knowledge_type !== belief.type && existing.content !== belief.statement ? 'superseded'
                : existing?.status ?? belief.status;
              sqlite.prepare(`UPDATE knowledge SET confidence=MAX(confidence, ?), status=?, reason=COALESCE(?, reason), evidence_summary=COALESCE(?, evidence_summary), source_count=COALESCE(source_count, 0)+1, updated_at=? WHERE id=?`)
                .run(belief.confidence, nextStatus, belief.reason ?? null, belief.evidenceSummary ?? null, committedAt, id);
            }
          } else {
            const strategy = projection.data;
            const id = deterministicProjectionId(job.id, 'strategy', `${strategy.strategyType}:${strategy.title}:${index}`);
            const metadata = JSON.stringify({ sourceMemoryId: job.source_memory_id, analysisJobId: job.id, projectionKind: 'strategy', projectionIndex: index });
            sqlite.prepare(`INSERT OR IGNORE INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, confidence, confidence_level, title, description, steps, success_criteria, failure_indicators, status, tags, metadata, created_at, updated_at) VALUES (?, ?, 'strategy', ?, ?, ?, 'certain', ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
              .run(id, job.project_id, strategy.strategyType, strategy.description, strategy.confidence, strategy.title, strategy.description, JSON.stringify(strategy.steps), strategy.successCriteria, strategy.failureIndicators, JSON.stringify(['auto-extracted']), metadata, committedAt, committedAt);
            const edgeId = deterministicProjectionId(job.id, 'strategy-edge', id);
            sqlite.prepare(`INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, created_at) VALUES (?, ?, 'knowledge', ?, 'knowledge', 'sourced_from', ?)`)
              .run(edgeId, id, job.source_memory_id, committedAt);
          }
        }
        const completed = sqlite.prepare("UPDATE memory_analysis_jobs SET status='completed', locked_at=NULL, last_error_code=NULL, updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?").run(committedAt, job.id, job.attempts, job.locked_at, committedAt - LEASE_SECONDS);
        if (completed.changes !== 1) throw new Error('Lease ownership lost');
        return true;
      });
      const commitResult = commit();
      if (commitResult === true) projected += extraction.facts.length + derived.length;
      else if (commitResult === 'skipped') skipped++;
    } catch {
      const failedAt = Math.floor(now() / 1000);
      const attempts = job.attempts;
      const delay = Math.min(MAX_BACKOFF_SECONDS, 30 * (2 ** Math.min(attempts - 1, 20)));
      const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      const result = sqlite.prepare("UPDATE memory_analysis_jobs SET status=?, available_at=?, locked_at=NULL, last_error_code=?, updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?")
        .run(status, failedAt + delay, 'FACT_EXTRACTION_FAILED', failedAt, job.id, job.attempts, job.locked_at, failedAt - LEASE_SECONDS);
      if (result.changes === 1 && status === 'pending') retried++;
    }
  }
  return { processed: jobs.length, projected, skipped, retried };
}
