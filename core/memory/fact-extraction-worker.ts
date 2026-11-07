import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { callLLMWithContent } from '../llm/client.js';
import { getDbClient } from '../lib/db-client.js';
import {
  extractFacts,
  reconcileFactEntailment,
  type ExtractedFact,
  type FactEntailmentVerifier,
  type FactExtractionResult,
  hasAmbiguousTranscriptRoleLabels,
  userGroundedTranscriptText,
} from './fact-extractor.js';
import { extractBeliefs } from '../knowledge/extractor.js';
import { logger } from '../logger.js';
import { deserializeMetadata } from './serialization.js';
import { signMemoryProvenance, verifyMemoryProvenance } from '../acl/provenance.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { readClaudeTranscript } from '../sessions/agent-stores/claude-code.js';
import { readCodexTranscript } from '../sessions/agent-stores/codex.js';
import { readGeminiTranscript } from '../sessions/agent-stores/gemini.js';
import { readOpenCodeTranscript } from '../sessions/agent-stores/opencode.js';
import { normalizeDirectoryScope } from '../sessions/agent-stores/path-scope.js';
import { normalizeTimestampValue } from '../retrieval/temporal-validity.js';

const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;
const LEASE_SECONDS = 15 * 60;

type AnalysisJob = { id: string; source_memory_id: string; project_id: string; attempts: number; locked_at: number };
type SourceMemory = {
  id: string;
  content: string;
  type: string;
  project_id: string;
  user_id: string | null;
  team_id: string | null;
  metadata: string | null;
  created_at: number;
  valid_from: number | null;
  valid_to: number | null;
  expires_at: number | null;
};

function sourceTemporalState(source: Pick<SourceMemory, 'valid_from' | 'valid_to' | 'expires_at'>, nowSeconds: number): 'not_started' | 'expired' | null {
  const nowMs = nowSeconds * 1000;
  const validFrom = normalizeTimestampValue(source.valid_from);
  if (validFrom !== null && validFrom > nowMs) return 'not_started';
  const validTo = normalizeTimestampValue(source.valid_to);
  const expiresAt = normalizeTimestampValue(source.expires_at);
  return (validTo !== null && validTo <= nowMs) || (expiresAt !== null && expiresAt <= nowMs)
    ? 'expired'
    : null;
}
type HostTranscriptAttestation = {
  version: 1;
  agent: 'codex' | 'claude-code' | 'opencode' | 'gemini';
  sessionId: string;
  role: string;
  messageIndex: number;
  sourceFingerprint: string;
};
export type FactExtractor = (text: string) => Promise<FactExtractionResult>;
export interface ProcessMemoryAnalysisOptions {
  extract?: FactExtractor;
  /** Test seam for the opt-in second-pass entailment verifier. */
  verifyEntailment?: FactEntailmentVerifier;
  limit?: number;
  now?: () => number;
}

async function reconcileExtractedFacts(facts: ExtractedFact[]): Promise<ExtractedFact[]> {
  return reconcileFactEntailment(facts, async (prompt, maxTokens) => {
    const response = await callLLMWithContent({ prompt, maxTokens });
    if (response === null) throw new Error('LLM unavailable');
    return response;
  });
}

const defaultExtractor = async (text: string, authenticatedUserTurn = false): Promise<FactExtractionResult> => {
  const result = await extractFacts(text, async (prompt, maxTokens) => {
    const response = await callLLMWithContent({ prompt, maxTokens });
    if (response === null) throw new Error('LLM unavailable');
    return response;
  }, { authenticatedUserTurn });
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

function sourceHasTrustedProvenance(source: SourceMemory): boolean {
  const metadata = deserializeMetadata(source.metadata);
  const envelope = metadata?.__squishProvenance as { version?: number } | undefined;
  return envelope?.version === 3 && verifyMemoryProvenance({
    content: source.content,
    projectId: source.project_id,
    type: source.type ?? 'note',
    ownerId: source.user_id,
    teamId: source.team_id,
    sourceMemoryId: source.id,
    metadata,
  });
}

function hostTranscriptAttestation(source: SourceMemory): HostTranscriptAttestation | null {
  const value = deserializeMetadata(source.metadata)?.hostTranscript;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const marker = value as Partial<HostTranscriptAttestation>;
  const agents = ['codex', 'claude-code', 'opencode', 'gemini'] as const;
  if (marker.version !== 1 || typeof marker.agent !== 'string' || !agents.includes(marker.agent as HostTranscriptAttestation['agent'])
    || typeof marker.sessionId !== 'string' || !['user', 'assistant', 'system'].includes(String(marker.role))
    || !Number.isInteger(marker.messageIndex)
    || typeof marker.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(marker.sourceFingerprint)) return null;
  return marker as HostTranscriptAttestation;
}

function hostTranscriptStillMatches(source: SourceMemory, marker: HostTranscriptAttestation, sqlite: { prepare: (query: string) => { get: (...params: unknown[]) => unknown } }): boolean {
  const snapshot = marker.agent === 'codex'
    ? readCodexTranscript(marker.sessionId)
    : marker.agent === 'claude-code'
      ? readClaudeTranscript(marker.sessionId)
      : marker.agent === 'opencode'
        ? readOpenCodeTranscript(marker.sessionId)
        : readGeminiTranscript(marker.sessionId);
  if (!snapshot || snapshot.sessionId !== marker.sessionId) return false;
  const current = snapshot.messages.find((message) => message.messageIndex === marker.messageIndex);
  if (!current || current.role !== marker.role || current.content !== source.content
    || current.sourceFingerprint !== marker.sourceFingerprint) return false;
  const project = sqlite.prepare('SELECT path FROM projects WHERE id=?').get(source.project_id) as { path: string } | undefined;
  return Boolean(project && normalizeDirectoryScope(project.path) === normalizeDirectoryScope(snapshot.projectPath));
}

function isCapturedSessionEpisode(source: SourceMemory): boolean {
  const metadata = deserializeMetadata(source.metadata);
  return typeof metadata?.chunk_type === 'string'
    && typeof metadata.session_id === 'string'
    && typeof metadata.agent_session_id === 'string';
}

function hasValidFactEvidence(sourceText: string, fact: FactExtractionResult['facts'][number]): boolean {
  return Number.isInteger(fact.evidenceStart)
    && Number.isInteger(fact.evidenceEnd)
    && fact.evidenceStart >= 0
    && fact.evidenceEnd > fact.evidenceStart
    && fact.evidenceEnd <= sourceText.length
    && sourceText.slice(fact.evidenceStart, fact.evidenceEnd) === fact.evidence;
}

function projectionMetadata(
  source: SourceMemory,
  trustedSource: boolean,
  content: string,
  type: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...fields,
    sourceId: source.id,
    observedAt: new Date(Number(source.created_at) * 1000).toISOString(),
  };
  if (!trustedSource) return metadata;
  const signature = signMemoryProvenance({
    content,
    projectId: source.project_id,
    type,
    ownerId: source.user_id,
    teamId: source.team_id,
    sourceMemoryId: source.id,
    metadata,
  });
  if (!signature) return metadata;
  const signedMetadata = { ...metadata, __squishProvenance: signature };
  return verifyMemoryProvenance({
    content,
    projectId: source.project_id,
    type,
    ownerId: source.user_id,
    teamId: source.team_id,
    sourceMemoryId: source.id,
    metadata: signedMetadata,
  }) ? signedMetadata : metadata;
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
    const source = sqlite.prepare(`SELECT id, content, type, project_id, user_id, team_id, metadata, created_at, valid_from, valid_to, expires_at FROM memories WHERE id=? AND project_id=? AND is_active=1 AND status='active' AND is_encrypted=0 AND content IS NOT NULL AND length(trim(content))>0`).get(job.source_memory_id, job.project_id) as SourceMemory | undefined;
    if (!source) {
      const skippedResult = sqlite.prepare("UPDATE memory_analysis_jobs SET status='skipped', locked_at=NULL, updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?").run(Math.floor(now() / 1000), job.id, job.attempts, job.locked_at, Math.floor(now() / 1000) - LEASE_SECONDS);
      if (skippedResult.changes === 1) skipped++;
      continue;
    }
    const sourceState = sourceTemporalState(source, selectionTime);
    if (sourceState) {
      const errorCode = sourceState === 'expired' ? 'SOURCE_EXPIRED_BEFORE_ANALYSIS' : 'SOURCE_NOT_YET_VALID_BEFORE_ANALYSIS';
      const skippedResult = sqlite.prepare("UPDATE memory_analysis_jobs SET status='skipped', locked_at=NULL, last_error_code=?, updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?")
        .run(errorCode, timestamp, job.id, job.attempts, job.locked_at, selectionTime - LEASE_SECONDS);
      if (skippedResult.changes === 1) skipped++;
      continue;
    }
    const trustedSource = sourceHasTrustedProvenance(source);
    const strict = isStrictTrustPolicy();
    if (strict && !trustedSource) {
      const skippedResult = sqlite.prepare("UPDATE memory_analysis_jobs SET status='skipped', locked_at=NULL, last_error_code='UNTRUSTED_SOURCE_PROVENANCE', updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?")
        .run(Math.floor(now() / 1000), job.id, job.attempts, job.locked_at, Math.floor(now() / 1000) - LEASE_SECONDS);
      if (skippedResult.changes === 1) skipped++;
      continue;
    }
    if (strict) {
      let signingAvailable = false;
      try {
        const probe = signMemoryProvenance({
          content: '', projectId: job.project_id, type: 'fact', ownerId: source.user_id,
          teamId: source.team_id, sourceMemoryId: source.id, metadata: {},
        });
        signingAvailable = Boolean(probe && verifyMemoryProvenance({
          content: '', projectId: job.project_id, type: 'fact', ownerId: source.user_id,
          teamId: source.team_id, sourceMemoryId: source.id, metadata: { __squishProvenance: probe },
        }));
      } catch {
        signingAvailable = false;
      }
      if (!signingAvailable) {
        const skippedResult = sqlite.prepare("UPDATE memory_analysis_jobs SET status='skipped', locked_at=NULL, last_error_code='PROVENANCE_SIGNING_UNAVAILABLE', updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?")
          .run(Math.floor(now() / 1000), job.id, job.attempts, job.locked_at, Math.floor(now() / 1000) - LEASE_SECONDS);
        if (skippedResult.changes === 1) skipped++;
        continue;
      }
    }
    const sourceMetadata = deserializeMetadata(source.metadata);
    let authenticatedHostUserTurn = false;
    if (sourceMetadata && Object.hasOwn(sourceMetadata, 'hostTranscript')) {
      const marker = hostTranscriptAttestation(source);
      const rejection = !trustedSource || !marker
        ? 'HOST_TRANSCRIPT_PROVENANCE_INVALID'
        : marker.role !== 'user'
          ? 'HOST_TRANSCRIPT_NON_USER_ROLE'
          : !hostTranscriptStillMatches(source, marker, sqlite)
            ? 'HOST_TRANSCRIPT_SOURCE_CHANGED'
            : null;
      if (rejection) {
        const skippedResult = sqlite.prepare("UPDATE memory_analysis_jobs SET status='skipped', locked_at=NULL, last_error_code=?, updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?")
          .run(rejection, timestamp, job.id, job.attempts, job.locked_at, selectionTime - LEASE_SECONDS);
        if (skippedResult.changes === 1) skipped++;
        continue;
      }
      authenticatedHostUserTurn = true;
    }
    if (isCapturedSessionEpisode(source)) {
      const skippedResult = sqlite.prepare("UPDATE memory_analysis_jobs SET status='skipped', locked_at=NULL, last_error_code='SESSION_EPISODE_REMAINS_EVIDENCE', updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?")
        .run(timestamp, job.id, job.attempts, job.locked_at, selectionTime - LEASE_SECONDS);
      if (skippedResult.changes === 1) skipped++;
      continue;
    }
    if (!authenticatedHostUserTurn && hasAmbiguousTranscriptRoleLabels(source.content)) {
      const skippedResult = sqlite.prepare("UPDATE memory_analysis_jobs SET status='skipped', locked_at=NULL, last_error_code='AMBIGUOUS_TRANSCRIPT_ROLE_BOUNDARIES', updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?")
        .run(timestamp, job.id, job.attempts, job.locked_at, selectionTime - LEASE_SECONDS);
      if (skippedResult.changes === 1) skipped++;
      continue;
    }
    try {
      const extraction = options.extract
        ? await options.extract(source.content)
        : await defaultExtractor(source.content, authenticatedHostUserTurn);
      const groundedFacts = extraction.facts.filter((fact) => hasValidFactEvidence(source.content, fact));
      const reconciledFacts = options.verifyEntailment
        ? await reconcileFactEntailment(groundedFacts, options.verifyEntailment)
        : config.factEntailmentCheckEnabled
          ? await reconcileExtractedFacts(groundedFacts)
          : groundedFacts;
      const derived = extractBeliefs({
        memoryId: job.source_memory_id,
        content: userGroundedTranscriptText(source.content, authenticatedHostUserTurn),
        type: source.type ?? 'note',
      }, {
        projectId: job.project_id, sourceType: 'memory', sourceId: job.source_memory_id,
      });
      const factMetadata = reconciledFacts.map((fact, index) => projectionMetadata(source, trustedSource, fact.content, 'fact', {
        sourceMemoryId: job.source_memory_id,
        analysisJobId: job.id,
        factIndex: index,
        evidence: fact.evidence,
        evidenceStart: fact.evidenceStart,
        evidenceEnd: fact.evidenceEnd,
        entities: fact.entities,
        ...(fact.relation ? { relation: fact.relation } : {}),
        derivation: {
          kind: 'extracted_fact',
          jobId: job.id,
          index,
          entities: fact.entities,
          relation: fact.relation ?? null,
          confidence: fact.confidence,
          evidence: fact.evidence,
          evidenceStart: fact.evidenceStart,
          evidenceEnd: fact.evidenceEnd,
        },
      }));
      const beliefMetadata = derived.map((belief, index) => projectionMetadata(source, trustedSource, belief.statement, belief.type, {
        sourceMemoryId: job.source_memory_id,
        analysisJobId: job.id,
        projectionKind: 'belief',
        projectionIndex: index,
        derivation: {
          kind: 'extracted_belief',
          jobId: job.id,
          index,
          beliefType: belief.type,
          reason: belief.reason ?? null,
          evidenceSummary: belief.evidenceSummary ?? null,
          confidence: belief.confidence,
          status: belief.status,
        },
      }));
      const committedAt = Math.floor(now() / 1000);
      const commit = sqlite.transaction(() => {
        const owned = sqlite.prepare("SELECT 1 FROM memory_analysis_jobs WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?").get(job.id, job.attempts, job.locked_at, committedAt - LEASE_SECONDS);
        if (!owned) return false;
        const eligibleSource = sqlite.prepare(`SELECT content, type, user_id, team_id, metadata, valid_from, valid_to, expires_at FROM memories WHERE id=? AND project_id=? AND is_active=1 AND status='active' AND is_encrypted=0 AND content IS NOT NULL AND length(trim(content))>0`)
          .get(job.source_memory_id, job.project_id) as { content: string; type: string; user_id: string | null; team_id: string | null; metadata: string | null; valid_from: number | null; valid_to: number | null; expires_at: number | null } | undefined;
        const eligibilityTime = Math.max(committedAt, Math.floor(Date.now() / 1000));
        const eligibleSourceState = eligibleSource ? sourceTemporalState(eligibleSource, eligibilityTime) : null;
        if (eligibleSourceState) {
          const errorCode = eligibleSourceState === 'expired' ? 'SOURCE_EXPIRED_DURING_ANALYSIS' : 'SOURCE_NOT_YET_VALID_DURING_ANALYSIS';
          const skippedResult = sqlite.prepare("UPDATE memory_analysis_jobs SET status='skipped', locked_at=NULL, last_error_code=?, updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?")
            .run(errorCode, committedAt, job.id, job.attempts, job.locked_at, committedAt - LEASE_SECONDS);
          return skippedResult.changes === 1 ? 'skipped' as const : false;
        }
        if (!eligibleSource || eligibleSource.content !== source.content || eligibleSource.type !== source.type || eligibleSource.user_id !== source.user_id || eligibleSource.team_id !== source.team_id || eligibleSource.metadata !== source.metadata || eligibleSource.valid_from !== source.valid_from || eligibleSource.valid_to !== source.valid_to || eligibleSource.expires_at !== source.expires_at) {
          const skippedResult = sqlite.prepare("UPDATE memory_analysis_jobs SET status='skipped', locked_at=NULL, last_error_code='SOURCE_CHANGED_DURING_ANALYSIS', updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?")
            .run(committedAt, job.id, job.attempts, job.locked_at, committedAt - LEASE_SECONDS);
          return skippedResult.changes === 1 ? 'skipped' as const : false;
        }
        for (let index = 0; index < reconciledFacts.length; index++) {
          const fact = reconciledFacts[index]!;
          const id = deterministicFactId(job.id, index);
          const metadata = JSON.stringify(factMetadata[index]);
          const tags = JSON.stringify([...new Set(['extracted-fact', ...fact.entities])]);
          sqlite.prepare(`INSERT OR IGNORE INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, confidence, confidence_level, status, is_active, tags, metadata, valid_from, valid_to, recorded_at, created_at, updated_at) VALUES (?, ?, 'memory', 'fact', ?, ?, 'certain', 'active', 1, ?, ?, ?, ?, ?, ?, ?)`).run(id, job.project_id, fact.content, fact.confidence, tags, metadata, source.valid_from, source.valid_to, committedAt, committedAt, committedAt);
        }
        for (let index = 0; index < derived.length; index++) {
          const belief = derived[index]!;
          const normalizedKey = normalizedBeliefKey(belief.statement);
          const existingQuery = trustedSource
            ? "SELECT id, knowledge_type, content, confidence, status, reason, evidence_summary FROM knowledge WHERE project_id=? AND knowledge_kind='belief' AND normalized_key=? AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId')=? ORDER BY created_at LIMIT 1"
            : "SELECT id, knowledge_type, content, confidence, status, reason, evidence_summary FROM knowledge WHERE project_id=? AND knowledge_kind='belief' AND normalized_key=? ORDER BY created_at LIMIT 1";
          const existing = (trustedSource
            ? sqlite.prepare(existingQuery).get(job.project_id, normalizedKey, source.id)
            : sqlite.prepare(existingQuery).get(job.project_id, normalizedKey)) as { id: string; knowledge_type: string; content: string; confidence: number; status: string; reason: string | null; evidence_summary: string | null } | undefined;
          const id = existing?.id ?? deterministicProjectionId(job.id, 'belief', `${belief.type}:${normalizedKey}`);
          if (!existing) {
            const metadata = JSON.stringify(beliefMetadata[index]);
            sqlite.prepare(`INSERT OR IGNORE INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, confidence, confidence_level, normalized_key, reason, evidence_summary, source_count, status, tags, metadata, created_at, updated_at) VALUES (?, ?, 'belief', ?, ?, ?, 'certain', ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
              .run(id, job.project_id, belief.type, belief.statement, belief.confidence, normalizedKey, belief.reason ?? null, belief.evidenceSummary ?? null, belief.status, JSON.stringify(['auto-extracted']), metadata, committedAt, committedAt);
          }
          const edgeId = deterministicProjectionId(job.id, 'belief-edge', id);
          const sourceEdge = sqlite.prepare(`INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at) VALUES (?, ?, 'knowledge', ?, 'knowledge', 'sourced_from', ?, ?, ?)`)
            .run(edgeId, id, job.source_memory_id, committedAt, committedAt * 1000, committedAt * 1000);
          if (sourceEdge.changes > 0) {
            const nextStatus = belief.type === 'failure_cause' ? 'disputed'
              : existing && existing.knowledge_type !== belief.type && existing.content !== belief.statement ? 'superseded'
              : existing?.status ?? belief.status;
            sqlite.prepare(`UPDATE knowledge SET confidence=MAX(confidence, ?), status=?, reason=COALESCE(?, reason), evidence_summary=COALESCE(?, evidence_summary), source_count=COALESCE(source_count, 0)+1, updated_at=? WHERE id=?`)
              .run(belief.confidence, nextStatus, belief.reason ?? null, belief.evidenceSummary ?? null, committedAt, id);
          }
        }
        const completed = sqlite.prepare("UPDATE memory_analysis_jobs SET status='completed', locked_at=NULL, last_error_code=NULL, updated_at=? WHERE id=? AND status='processing' AND attempts=? AND locked_at=? AND locked_at>?").run(committedAt, job.id, job.attempts, job.locked_at, committedAt - LEASE_SECONDS);
        if (completed.changes !== 1) throw new Error('Lease ownership lost');
        return true;
      });
      const commitResult = commit();
      if (commitResult === true) projected += reconciledFacts.length + derived.length;
      else if (commitResult === 'skipped') skipped++;
    } catch (error) {
      logger.warn('Memory analysis projection failed and will be retried', { jobId: job.id, error });
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
