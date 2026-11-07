import { getDbClient } from '../lib/db-client.js';

export interface SupersessionAuditEdge {
  id: string;
  fromId: string;
  toId: string;
  edgeType: 'updates' | 'supersedes';
}

export interface SupersessionCycle {
  nodeIds: string[];
  edgeIds: string[];
}

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  edge_type: 'updates' | 'supersedes';
  recorded_at: number;
  recorded_to: number | null;
}

interface SqliteApi {
  prepare: (sql: string) => {
    all: (...params: Array<string | number>) => EdgeRow[];
    run: (...params: Array<string | number>) => { changes: number };
  };
  exec: (sql: string) => void;
}

export function findSupersessionCycles(edges: SupersessionAuditEdge[]): SupersessionCycle[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const next = adjacency.get(edge.fromId) ?? [];
    next.push(edge.toId);
    adjacency.set(edge.fromId, next);
    if (!adjacency.has(edge.toId)) adjacency.set(edge.toId, []);
  }

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const enter = (node: string): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex++);
    stack.push(node);
    onStack.add(node);
  };

  for (const node of adjacency.keys()) {
    if (indices.has(node)) continue;
    enter(node);
    const frames: Array<{ node: string; parent: string | null; nextNeighbor: number }> = [
      { node, parent: null, nextNeighbor: 0 },
    ];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const neighbors = adjacency.get(frame.node) ?? [];
      if (frame.nextNeighbor < neighbors.length) {
        const neighbor = neighbors[frame.nextNeighbor++]!;
        if (!indices.has(neighbor)) {
          enter(neighbor);
          frames.push({ node: neighbor, parent: frame.node, nextNeighbor: 0 });
        } else if (onStack.has(neighbor)) {
          lowLinks.set(frame.node, Math.min(lowLinks.get(frame.node)!, indices.get(neighbor)!));
        }
        continue;
      }

      frames.pop();
      if (frame.parent !== null) {
        lowLinks.set(frame.parent, Math.min(lowLinks.get(frame.parent)!, lowLinks.get(frame.node)!));
      }
      if (lowLinks.get(frame.node) !== indices.get(frame.node)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.node);
      components.push(component.sort());
    }
  }

  const componentByNode = new Map<string, number>();
  components.forEach((nodes, componentIndex) => {
    for (const member of nodes) componentByNode.set(member, componentIndex);
  });
  const edgeIdsByComponent = new Map<number, string[]>();
  const hasSelfLoop = new Set<number>();
  for (const edge of edges) {
    const fromComponent = componentByNode.get(edge.fromId);
    if (fromComponent === undefined || fromComponent !== componentByNode.get(edge.toId)) continue;
    const componentEdges = edgeIdsByComponent.get(fromComponent) ?? [];
    componentEdges.push(edge.id);
    edgeIdsByComponent.set(fromComponent, componentEdges);
    if (edge.fromId === edge.toId) hasSelfLoop.add(fromComponent);
  }

  return components.flatMap((nodes, componentIndex) => {
    if (nodes.length === 1 && !hasSelfLoop.has(componentIndex)) return [];
    return [{ nodeIds: nodes, edgeIds: (edgeIdsByComponent.get(componentIndex) ?? []).sort() }];
  }).sort((left, right) => left.nodeIds[0]!.localeCompare(right.nodeIds[0]!));
}

function readCurrentEdges(sqlite: SqliteApi, at: number): EdgeRow[] {
  return sqlite.prepare(`
    SELECT id, from_id, to_id, edge_type, recorded_at, recorded_to
    FROM knowledge_edges
    WHERE from_kind = 'knowledge' AND to_kind = 'knowledge'
      AND edge_type IN ('updates', 'supersedes')
      AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
      AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)
  `).all(at, at, at, at);
}

function asAuditEdges(rows: EdgeRow[]): SupersessionAuditEdge[] {
  return rows.map((row) => ({ id: row.id, fromId: row.from_id, toId: row.to_id, edgeType: row.edge_type }));
}

/** Find active cycles in canonical update/supersession edges at one instant. */
export async function auditSupersessionCycles(asOf = new Date()): Promise<SupersessionCycle[]> {
  const { raw } = await getDbClient();
  const sqlite = (raw as { $client?: SqliteApi }).$client;
  if (!sqlite) throw new Error('SQLite knowledge store is unavailable');
  return findSupersessionCycles(asAuditEdges(readCurrentEdges(sqlite, asOf.getTime())));
}

export interface RepairSupersessionCyclesOptions {
  /** Apply only after reviewing the dry-run cycle and edge IDs. Defaults false. */
  apply?: boolean;
  recordedAt?: Date;
}

export interface RepairSupersessionCyclesResult {
  ok: boolean;
  applied: boolean;
  cyclesBefore: SupersessionCycle[];
  cyclesAfter: SupersessionCycle[];
  retractedEdgeIds: string[];
  error?: string;
}

/**
 * Dry-run-first cycle repair. The caller selects the edges to retract; this
 * function refuses a selection that leaves any cycle or includes unrelated
 * edges. Retraction closes recorded-time assertions and keeps history intact.
 */
export async function repairSupersessionCycles(
  edgeIds: string[],
  options: RepairSupersessionCyclesOptions = {},
): Promise<RepairSupersessionCyclesResult> {
  const selectedIds = [...new Set(edgeIds)].sort();
  const empty: RepairSupersessionCyclesResult = {
    ok: false, applied: false, cyclesBefore: [], cyclesAfter: [], retractedEdgeIds: [],
  };
  if (selectedIds.length === 0) return { ...empty, error: 'Select at least one cycle edge to retract' };

  const { raw } = await getDbClient();
  const sqlite = (raw as { $client?: SqliteApi }).$client;
  if (!sqlite) throw new Error('SQLite knowledge store is unavailable');

  const auditAt = options.recordedAt?.getTime() ?? Date.now();
  if (!Number.isFinite(auditAt)) return { ...empty, error: 'Repair timestamp is invalid' };
  const readCycles = (at: number): { rows: EdgeRow[]; cycles: SupersessionCycle[] } => {
    const rows = readCurrentEdges(sqlite, at);
    return { rows, cycles: findSupersessionCycles(asAuditEdges(rows)) };
  };

  const initial = readCycles(auditAt);
  const cycleEdgeIds = new Set(initial.cycles.flatMap((cycle) => cycle.edgeIds));
  const unrelated = selectedIds.filter((id) => !cycleEdgeIds.has(id));
  if (unrelated.length > 0) {
    return { ...empty, cyclesBefore: initial.cycles, cyclesAfter: initial.cycles, error: `Selected edges are not part of an active cycle: ${unrelated.join(', ')}` };
  }
  const remaining = initial.rows.filter((edge) => !selectedIds.includes(edge.id));
  const afterDryRun = findSupersessionCycles(asAuditEdges(remaining));
  if (afterDryRun.length > 0) {
    return { ...empty, cyclesBefore: initial.cycles, cyclesAfter: afterDryRun, error: 'Selected edges do not break every active cycle' };
  }
  if (!options.apply) {
    return { ok: true, applied: false, cyclesBefore: initial.cycles, cyclesAfter: [], retractedEdgeIds: selectedIds };
  }

  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const locked = readCycles(auditAt);
    const lockedCycleIds = new Set(locked.cycles.flatMap((cycle) => cycle.edgeIds));
    if (selectedIds.some((id) => !lockedCycleIds.has(id))) throw new Error('Cycle edges changed during repair; rerun the audit');
    const lockedAfter = findSupersessionCycles(asAuditEdges(locked.rows.filter((edge) => !selectedIds.includes(edge.id))));
    if (lockedAfter.length > 0) throw new Error('Selected edges do not break every active cycle');

    const maxRecorded = Math.max(...locked.rows.filter((edge) => selectedIds.includes(edge.id)).map((edge) => edge.recorded_at));
    const requested = options.recordedAt?.getTime() ?? Date.now();
    const recordedAt = Math.max(requested, maxRecorded + 1);
    if (options.recordedAt && recordedAt !== requested) throw new Error('Repair timestamp must be later than every selected edge assertion');
    const update = sqlite.prepare('UPDATE knowledge_edges SET recorded_to = ? WHERE id = ? AND recorded_to IS NULL');
    for (const id of selectedIds) {
      const result = update.run(recordedAt, id) as { changes: number };
      if (result.changes !== 1) throw new Error(`Cycle edge changed during repair: ${id}`);
    }
    const after = readCycles(recordedAt + 1).cycles;
    if (after.length > 0) throw new Error('Cycle remained after repair transaction');
    sqlite.exec('COMMIT');
    return { ok: true, applied: true, cyclesBefore: initial.cycles, cyclesAfter: after, retractedEdgeIds: selectedIds };
  } catch (error) {
    sqlite.exec('ROLLBACK');
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, cyclesBefore: initial.cycles, cyclesAfter: initial.cycles, error: message };
  }
}
