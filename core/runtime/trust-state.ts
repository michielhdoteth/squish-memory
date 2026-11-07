import { getDbClient } from '../lib/db-client.js';
import { sql } from 'drizzle-orm';
import { probeSchemaHealth } from '../../db/schema-probe.js';
import { getRecent } from '../memory/memories.js';
import { getMemoryStats } from '../memory/stats.js';
import { explainMemory } from '../memory/explain.js';
import { compactSessionWorkingSet, getLatestProjectWorkingSetSummary, getProjectSignalStats } from '../session/working-set.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';
import { getGraphStats } from '../graph/index.js';
import { ensureProject, getAllProjects, getProjectByPath, requireProject, type ProjectRecord } from '../projects.js';
import { getProjectPlaces } from '../places/places.js';
import { getMemoryPlace } from '../places/memory-places.js';
import { getPlace } from '../places/places.js';
import { config } from '../../config.js';
import { getBeliefsForMemory } from '../knowledge/store.js';
import { applyAclReadGate, buildAutoAclContext } from '../acl/read-gate.js';
import type {
  ContextReportInput,
  CurrentProjectSummary,
  HealthReportInput,
  InspectReportInput,
  StatsReportInput,
} from './trust-report.js';

export interface TrustProjectScope {
  currentProject: CurrentProjectSummary;
  otherProjects: CurrentProjectSummary[];
  nextStep: string | null;
}

function isLegacyPlaceholderProject(project: ProjectRecord, currentWorkspacePath?: string): boolean {
  const normalizedPath = project.path.trim();
  if (normalizedPath === '.') return true;
  if (!currentWorkspacePath) return false;
  return normalizedPath === currentWorkspacePath && String(project.metadata?.source ?? '') === 'mcp';
}

function filterNormalOtherProjects(projects: ProjectRecord[], currentProjectId: string, currentWorkspacePath?: string) {
  return projects.filter((candidate) => {
    if (candidate.id === currentProjectId) return false;
    return !isLegacyPlaceholderProject(candidate, currentWorkspacePath);
  });
}

function inferResolution(
  project: ProjectRecord,
  mode: 'explicit' | 'inferred' | 'auto-created',
): CurrentProjectSummary['resolution'] {
  if (mode !== 'inferred') return mode;
  const source = String(project.metadata?.source ?? '');
  return source === 'mcp' ? 'auto-created' : 'inferred';
}

function toProjectSummary(
  project: ProjectRecord,
  mode: 'explicit' | 'inferred' | 'auto-created',
): CurrentProjectSummary {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    resolution: inferResolution(project, mode),
  };
}

export async function resolveProjectScope(projectPath?: string): Promise<TrustProjectScope> {
  const projects = await getAllProjects();
  const explicitPath = projectPath?.trim();

  if (explicitPath) {
    const project = await requireProject(explicitPath);
    return {
      currentProject: toProjectSummary(project, 'explicit'),
      otherProjects: filterNormalOtherProjects(projects, project.id, explicitPath)
        .map((candidate) => toProjectSummary(candidate, 'inferred')),
      nextStep: null,
    };
  }

  const cwd = process.cwd();
  const cwdProject = await getProjectByPath(cwd);
  if (cwdProject) {
    return {
      currentProject: toProjectSummary(cwdProject, 'inferred'),
      otherProjects: filterNormalOtherProjects(projects, cwdProject.id, cwd)
        .map((candidate) => toProjectSummary(candidate, 'inferred')),
      nextStep: null,
    };
  }

  if (projects.length === 1) {
    return {
      currentProject: toProjectSummary(projects[0], 'inferred'),
      otherProjects: [],
      nextStep: null,
    };
  }

  if (projects.length === 0) {
    // Fresh install with no projects yet. Use the global __squish_global__ project.
    const { ensureGlobalProject } = await import('../places/places.js');
    const globalProject = await ensureGlobalProject();
    const allProjects = await getAllProjects();
    return {
      currentProject: {
        id: globalProject.id,
        name: '__squish_global__',
        path: '__squish_global__',
        resolution: 'auto-created',
      },
      otherProjects: allProjects
        .filter((candidate) => candidate.id !== globalProject.id)
        .map((candidate) => toProjectSummary(candidate, 'inferred')),
      nextStep: 'Initialized global memory project.',
    };
  }

  // Multiple projects exist but none match cwd. Auto-register this directory as a new project.
  const newProject = await ensureProject(cwd);
  const refreshedProjects = await getAllProjects();
  return {
    currentProject: toProjectSummary(newProject!, 'auto-created'),
    otherProjects: filterNormalOtherProjects(refreshedProjects, newProject!.id, cwd)
      .map((candidate) => toProjectSummary(candidate, 'inferred')),
    nextStep: `Auto-registered new project at ${cwd}.`,
  };
}

async function getMemoryPlaceName(memoryId: string): Promise<string | null> {
  if (isStrictTrustPolicy()) return null;
  const placeId = await getMemoryPlace(memoryId);
  if (!placeId) return null;
  const place = await getPlace(placeId);
  return place?.name ?? null;
}

export async function buildContextState(
  projectPath?: string,
  limit: number = 10,
  caller?: { userId?: string; teamIds?: string[] },
  session?: { sessionId?: string },
): Promise<ContextReportInput> {
  if (isStrictTrustPolicy() && caller?.userId !== resolveTrustedCallerId()) {
    throw new TrustBoundaryError('Strict context requires the authenticated caller identity');
  }
  const scope = await resolveProjectScope(projectPath);
  const projectPathResolved = scope.currentProject.path;
  const strict = isStrictTrustPolicy();
  const acl = await buildAutoAclContext(caller?.userId, caller?.teamIds);
  const [sessionSummary, signalSummary, graphStats, recentMemories] = await Promise.all([
    strict && session?.sessionId
      ? compactSessionWorkingSet(session.sessionId, projectPathResolved).then((result) => result.summary)
      : getLatestProjectWorkingSetSummary(projectPathResolved),
    getProjectSignalStats(projectPathResolved),
    strict ? Promise.resolve(null) : getGraphStats(projectPathResolved),
    getRecent(projectPathResolved, strict ? Math.min(500, limit * 10) : limit),
  ]);
  const memories = (strict ? recentMemories : await applyAclReadGate(recentMemories, acl)).slice(0, limit);

  const project = await getProjectByPath(projectPathResolved);
  const places = project && !strict ? await getProjectPlaces(project.id) : [];
  const activePlaces = strict ? [] : places.filter((place) => place.memoryCount > 0).map((place) => place.name);

  const durableMemories = await Promise.all(
    memories.map(async (memory) => ({
      id: memory.id,
      type: memory.type,
      content: memory.content,
      place: strict ? null : await getMemoryPlaceName(memory.id),
    })),
  );
  const beliefRows = strict ? [] : await Promise.all(memories.map((memory) => getBeliefsForMemory(memory.id)));
  const beliefs = beliefRows.flat().slice(0, 6).map((belief) => ({
    type: belief.type,
    statement: belief.statement,
    status: belief.status,
  }));

  return {
    currentProject: scope.currentProject,
    otherProjects: strict ? [] : scope.otherProjects,
    runtime: {
      sessionSummary,
      activePlaces,
      signalSummary: {
        captured: signalSummary?.captured ?? 0,
        suppressed: signalSummary?.suppressed ?? 0,
        sessionOnly: signalSummary?.sessionOnly ?? 0,
        durable: signalSummary?.durable ?? 0,
        durableWithRaw: signalSummary?.durableWithRaw ?? 0,
      },
      graphSummary: strict ? 'withheld by strict trust policy' :
        graphStats && (graphStats.entityCount > 0 || graphStats.relationCount > 0)
          ? `enabled; ${graphStats.entityCount} entities, ${graphStats.relationCount} relations`
          : 'enabled; no graph enrichments yet',
    },
    durableMemories,
    beliefs,
    nextStep: scope.nextStep,
  };
}

export async function buildStatsState(projectPath?: string): Promise<StatsReportInput> {
  const scope = await resolveProjectScope(projectPath);
  const projectPathResolved = scope.currentProject.path;
  const strict = isStrictTrustPolicy();
  const [stats, graphStats, sessionSummary] = await Promise.all([
    strict ? Promise.resolve(null) : getMemoryStats(projectPathResolved),
    strict ? Promise.resolve(null) : getGraphStats(projectPathResolved),
    strict ? Promise.resolve('') : getLatestProjectWorkingSetSummary(projectPathResolved),
  ]);

  const project = strict ? null : await getProjectByPath(projectPathResolved);
  const places = project && !isStrictTrustPolicy() ? await getProjectPlaces(project.id) : [];

  return {
    currentProject: `${scope.currentProject.name} (${scope.currentProject.path})`,
    totals: {
      memories: strict ? 0 : stats!.totalMemories,
      // Live durable count (active memory rows). The previous formula
      // Math.max(totalMemories, signal.durable + signal.durableWithRaw) used
      // the append-only capture counter, which never decrements on
      // delete/merge/supersede and inflated durable past the live total.
      durable: strict ? 0 : stats!.durableMemories ?? stats!.totalMemories,
      sessionLocal: strict ? 0 : stats!.signal?.sessionOnly ?? 0,
    },
    signal: {
      captured: strict ? 0 : stats!.signal?.captured ?? 0,
      suppressed: strict ? 0 : stats!.signal?.suppressed ?? 0,
      sessionOnly: strict ? 0 : stats!.signal?.sessionOnly ?? 0,
      durable: strict ? 0 : stats!.signal?.durable ?? 0,
      durableWithRaw: strict ? 0 : stats!.signal?.durableWithRaw ?? 0,
      tokensSaved: strict ? 0 : stats!.signal?.tokensSaved ?? 0,
      placeRouted: strict ? 0 : stats!.signal?.placeRouted ?? 0,
      graphEnriched: strict ? 0 : stats!.signal?.graphEnriched ?? 0,
    },
    places: {
      active: strict ? 0 : places.filter((place) => place.memoryCount > 0).length,
      named: strict ? [] : places.filter((place) => place.memoryCount > 0).map((place) => place.name),
    },
    graph: {
      status: strict
        ? 'withheld by strict trust policy'
        : graphStats && (graphStats.entityCount > 0 || graphStats.relationCount > 0) ? 'enabled' : 'enabled (idle)',
      enrichments: strict ? 0 : stats!.signal?.graphEnriched ?? 0,
    },
    wakeUp: sessionSummary || 'No working set yet',
    signalNote:
      !strict && stats!.totalMemories > 0 && (stats!.signal?.captured ?? 0) === 0
        ? 'Signal counts cover capture-era writes only. Legacy durable memories may exist without signal telemetry.'
        : strict ? 'Aggregate statistics are withheld by strict trust policy.' : 'Signal counts cover capture-era writes only.',
  };
}

export async function buildHealthState(projectPath?: string): Promise<HealthReportInput> {
  const checks: HealthReportInput['checks'] = [];
  let severity: HealthReportInput['severity'] = 'ok';
  let nextStep: string | null = null;
  let currentProject = projectPath || process.cwd();

  const schemaProbe = await probeSchemaHealth();
  if (schemaProbe.status === 'ok') {
    checks.push({ name: 'database', status: 'ok', detail: 'Database connection succeeded.' });
  } else if (schemaProbe.status === 'drifted') {
    severity = 'degraded';
    nextStep = schemaProbe.remediation ? `Run \`${schemaProbe.remediation}\` to repair the schema.` : nextStep;
    checks.push({ name: 'database', status: 'degraded', detail: schemaProbe.detail });
  } else {
    severity = 'broken';
    nextStep = 'Fix database connectivity before relying on memory reads or writes.';
    checks.push({ name: 'database', status: 'broken', detail: schemaProbe.detail });
  }

  if (schemaProbe.status !== 'ok') {
    checks.push({
      name: 'mode',
      status: 'ok',
      detail: `local mode; embeddings ${config.embeddingsProvider}`,
    });

    return {
      severity,
      currentProject,
      checks,
      nextStep,
    };
  }

  const scope = await resolveProjectScope(projectPath);
  currentProject = `${scope.currentProject.name} (${scope.currentProject.path})`;
  nextStep = scope.nextStep;

  const strict = isStrictTrustPolicy();
  const legacyWikiTableCount = async (): Promise<number> => {
    try {
      const { raw: healthRaw } = await getDbClient();
      const clientType = String((healthRaw as any)?.$clientType ?? '');
      const driverName = String((healthRaw as any)?.$client?.constructor?.name ?? '');
      const isSqlite = clientType === 'sqlite' || /sqlite/i.test(driverName);
      if (isSqlite || !healthRaw || typeof (healthRaw as any).execute !== 'function') return 0;
      const result = (await (healthRaw as any).execute(
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('wiki_pages', 'wiki_links', 'wiki_page_versions')`
      )) as unknown;
      return ((result as { rows?: unknown[] }).rows ?? (Array.isArray(result) ? result : [])).length;
    } catch {
      // Legacy migration diagnostics are best-effort and must not hold up status.
      return 0;
    }
  };
  const safeMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
  const [wikiTableCount, recentResult, sessionResult, activePlaces, graphStats] = await Promise.all([
    legacyWikiTableCount(),
    getRecent(scope.currentProject.path, 1).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })),
    strict
      ? Promise.resolve({ summary: '', error: null as unknown })
      : getLatestProjectWorkingSetSummary(scope.currentProject.path).then(
        (summary) => ({ summary, error: null as unknown }),
        (error: unknown) => ({ summary: '', error }),
      ),
    getProjectByPath(scope.currentProject.path)
      .then((project) => project && !strict ? getProjectPlaces(project.id) : [])
      .then((places) => places.filter((place) => place.memoryCount > 0)),
    strict ? Promise.resolve(null) : getGraphStats(scope.currentProject.path),
  ]);

  if (wikiTableCount > 0) {
    checks.push({
      name: 'legacy wiki tables',
      status: 'degraded',
      detail:
        `${wikiTableCount} legacy wiki table(s) exist in this Postgres database. ` +
        'Run squish-cloud/squish-api/migrations/009-wiki-to-memory.sql to migrate and preserve legacy team-mode wiki data.',
    });
    if (severity === 'ok') severity = 'degraded';
    nextStep = nextStep ?? 'Run squish-cloud/squish-api/migrations/009-wiki-to-memory.sql to migrate legacy team-mode wiki tables.';
  }

  checks.push({
    name: 'project resolution',
    status: 'ok',
    detail: `${scope.currentProject.name} at ${scope.currentProject.path} (${scope.currentProject.resolution})`,
  });

  if (recentResult.ok) {
    checks.push({ name: 'memory write path', status: 'ok', detail: 'Memory store is readable for this project.' });
  } else {
    severity = severity === 'broken' ? 'broken' : 'degraded';
    nextStep = nextStep ?? 'Run `squish doctor` to repair local storage before writing memories.';
    checks.push({
      name: 'memory write path',
      status: 'degraded',
      detail: safeMessage(recentResult.error),
    });
  }

  if (!sessionResult.error) {
    const sessionSummary = sessionResult.summary;
    checks.push({
      name: 'session working set',
      status: sessionSummary ? 'ok' : 'degraded',
      detail: sessionSummary || 'No compact working set has been captured yet.',
    });
    if (!sessionSummary && severity === 'ok') {
      severity = 'degraded';
      nextStep = nextStep ?? 'Run a normal session or memory write so Squish can build a working-set wake-up summary.';
    }
  } else {
    severity = severity === 'broken' ? 'broken' : 'degraded';
    checks.push({
      name: 'session working set',
      status: 'degraded',
      detail: safeMessage(sessionResult.error),
    });
  }

  checks.push({
    name: 'places',
    status: activePlaces.length > 0 ? 'ok' : 'degraded',
    detail:
      activePlaces.length > 0
        ? `${activePlaces.length} active places: ${activePlaces.map((place) => place.name).join(', ')}`
        : 'No populated places yet.',
  });
  if (activePlaces.length === 0 && severity === 'ok') {
    severity = 'degraded';
    nextStep = nextStep ?? 'Store or recall project memories to populate place routing.';
  }

  if (strict) {
    checks.push({ name: 'graph', status: 'ok', detail: 'Graph statistics are withheld by strict trust policy.' });
  } else {
    checks.push({
      name: 'graph',
      status: graphStats && (graphStats.entityCount > 0 || graphStats.relationCount > 0) ? 'ok' : 'degraded',
      detail:
        graphStats && (graphStats.entityCount > 0 || graphStats.relationCount > 0)
          ? `${graphStats.entityCount} entities and ${graphStats.relationCount} relations available.`
          : 'Graph is enabled but has no extracted entities yet.',
    });
    if ((!graphStats || (graphStats.entityCount === 0 && graphStats.relationCount === 0)) && severity === 'ok') {
      severity = 'degraded';
      nextStep = nextStep ?? 'Write or recall durable memories so graph enrichment has material to process.';
    }
  }

  checks.push({
    name: 'mode',
    status: 'ok',
    detail: `local mode; embeddings ${config.embeddingsProvider}`,
  });

  return {
    severity,
    currentProject,
    checks,
    nextStep,
  };
}

export async function buildInspectState(id: string): Promise<InspectReportInput | null> {
  const inspection = await explainMemory(id);
  if (!inspection) return null;

  return {
    id: inspection.id,
    classification: inspection.classification,
    storageReason: inspection.reasons.join('; ') || 'Stored as durable memory.',
    durability: inspection.classification === 'session-only' ? 'session-only' : 'durable',
    place: inspection.place ?? null,
    placeType: inspection.placeType ?? null,
    graphStatus: inspection.graphStatus ?? null,
    rawFallback: inspection.rawFallbackSnapshotId ?? null,
    wakeUpPriority: inspection.nuanceSuppressed ? 'high' : 'normal',
    metadataAvailability: inspection.legacyMetadata
      ? 'Legacy durable record; signal-era metadata is unavailable.'
      : 'Signal metadata available.',
    beliefs: (inspection.beliefs ?? []).map((belief) => ({
      id: belief.id,
      type: belief.type,
      statement: belief.statement,
      status: belief.status,
      confidence: belief.confidence,
    })),
  };
}
