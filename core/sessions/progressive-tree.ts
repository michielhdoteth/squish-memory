import { createHash } from 'node:crypto';
import { estimateJsonTokens } from '../lib/tokens.js';

export interface ProgressiveTreeSource {
  id: string;
  createdAt: string | null;
  content: string;
}

export interface ProgressiveTreeNode {
  id: string;
  kind: 'summary' | 'source';
  startAt: string | null;
  endAt: string | null;
  sourceCount: number;
  preview: string;
  childIds?: [string, string];
  sourceId?: string;
  text?: string;
  textTruncated?: boolean;
}

export interface ProgressiveTreeView {
  version: 1;
  rootId: string;
  sourceCount: number;
  detailSourceCount: number;
  budgetTokens: number;
  estimatedTokens: number;
  expandedNodeId?: string;
  items: ProgressiveTreeNode[];
}

interface InternalNode extends ProgressiveTreeNode {
  children?: [InternalNode, InternalNode];
  order: number;
}

const MIN_BUDGET = 128;
const MAX_BUDGET = 20_000;
const SUMMARY_PREVIEW_CHARS = 96;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function estimateTokens(value: unknown): number {
  return estimateJsonTokens(value);
}

function estimateViewTokens(view: Omit<ProgressiveTreeView, 'estimatedTokens'>): number {
  let estimatedTokens = estimateTokens(view);
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = estimateTokens({ ...view, estimatedTokens });
    if (next === estimatedTokens) return next;
    estimatedTokens = next;
  }
  return estimatedTokens;
}

function validTimestamp(value: string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('Summary tree source has an invalid timestamp');
  return timestamp;
}

function extractPreview(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const firstSentence = normalized.match(/^.{1,240}?(?:[.!?](?:\s|$)|$)/)?.[0] ?? normalized;
  return firstSentence.slice(0, SUMMARY_PREVIEW_CHARS);
}

function makeSource(source: ProgressiveTreeSource, order: number): InternalNode {
  if (!source.id.trim() || source.id.length > 256) throw new Error('Summary tree source ID is invalid');
  const timestamp = validTimestamp(source.createdAt);
  return {
    id: `source:${hash(JSON.stringify([source.id, source.createdAt, source.content]))}`,
    kind: 'source',
    startAt: source.createdAt,
    endAt: source.createdAt,
    sourceCount: 1,
    preview: extractPreview(source.content),
    sourceId: source.id,
    text: source.content,
    order: Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY + order,
  };
}

function combine(left: InternalNode, right: InternalNode): InternalNode {
  const startAt = left.startAt;
  const endAt = right.endAt;
  const preview = `${left.preview} | ${right.preview}`.slice(0, SUMMARY_PREVIEW_CHARS);
  const childIds: [string, string] = [left.id, right.id];
  return {
    id: `summary:${hash(JSON.stringify(['progressive-tree-v1', childIds]))}`,
    kind: 'summary',
    startAt,
    endAt,
    sourceCount: left.sourceCount + right.sourceCount,
    preview,
    childIds,
    children: [left, right],
    order: Math.max(left.order, right.order),
  };
}

function buildBalanced(sources: InternalNode[], start = 0, end = sources.length): InternalNode {
  if (end - start === 1) return sources[start]!;
  const middle = start + Math.floor((end - start) / 2);
  return combine(buildBalanced(sources, start, middle), buildBalanced(sources, middle, end));
}

function leafForView(node: InternalNode, budgetTokens: number): ProgressiveTreeNode {
  const rendered: ProgressiveTreeNode = {
    id: node.id,
    kind: 'source',
    startAt: node.startAt,
    endAt: node.endAt,
    sourceCount: 1,
    preview: node.preview,
    sourceId: node.sourceId,
    text: node.text,
  };
  if (estimateTokens(rendered) <= budgetTokens) return rendered;
  return { ...rendered, text: '', textTruncated: true };
}

function visibleNode(node: InternalNode, budgetTokens: number): ProgressiveTreeNode {
  if (node.kind === 'source') return leafForView(node, budgetTokens);
  return {
    id: node.id,
    kind: 'summary',
    startAt: node.startAt,
    endAt: node.endAt,
    sourceCount: node.sourceCount,
    preview: node.preview,
    childIds: node.childIds,
  };
}

function makeView(
  rootId: string,
  selected: InternalNode[],
  sourceCount: number,
  budgetTokens: number,
  expandedNodeId?: string,
): ProgressiveTreeView {
  let items = selected.map((node) => visibleNode(node, budgetTokens));
  const wrap = (current: ProgressiveTreeNode[]): Omit<ProgressiveTreeView, 'estimatedTokens'> => ({
    version: 1 as const,
    rootId,
    sourceCount,
    detailSourceCount: current.filter((node) => node.kind === 'source').length,
    budgetTokens,
    ...(expandedNodeId ? { expandedNodeId } : {}),
    items: current,
  });

  while (estimateViewTokens(wrap(items)) > budgetTokens) {
    const source = items.find((node) => node.kind === 'source' && node.text && node.text.length > 0);
    if (!source) throw new Error('Summary tree metadata exceeds its token budget');
    const internal = selected.find((node) => node.id === source.id);
    if (!internal?.text) throw new Error('Summary tree source text is unavailable');
    const excess = (estimateViewTokens(wrap(items)) - budgetTokens) * 4;
    const currentText = source.text ?? '';
    const replacement: ProgressiveTreeNode = {
      ...source,
      text: currentText.slice(0, Math.max(0, currentText.length - excess - 4)),
      textTruncated: true,
    };
    items = items.map((item) => item.id === source.id ? replacement : item);
    selected = selected.filter((node) => node.id !== source.id);
    selected.push({ ...internal, text: replacement.text });
    if ((replacement.text ?? '').length === 0 && estimateViewTokens(wrap(items)) > budgetTokens) {
      throw new Error('Summary tree metadata exceeds its token budget');
    }
  }

  const orderedItems = [...items].sort((left, right) =>
    (left.startAt ? Date.parse(left.startAt) : Number.NEGATIVE_INFINITY)
      - (right.startAt ? Date.parse(right.startAt) : Number.NEGATIVE_INFINITY)
      || left.id.localeCompare(right.id));
  const view = wrap(orderedItems);
  return { ...view, estimatedTokens: estimateViewTokens(view) };
}

/**
 * Build a derived time-ordered binary summary view from caller-authorized sources.
 * Internal summaries are extractive previews; source memories remain canonical.
 */
export function buildProgressiveTemporalSummaryTree(
  inputSources: readonly ProgressiveTreeSource[],
  budgetTokens: number,
  expandNodeId?: string,
): ProgressiveTreeView {
  if (!Number.isInteger(budgetTokens) || budgetTokens < MIN_BUDGET || budgetTokens > MAX_BUDGET) {
    throw new Error(`Summary tree budget must be between ${MIN_BUDGET} and ${MAX_BUDGET} tokens`);
  }
  if (inputSources.length === 0) {
    throw new Error('Summary tree requires at least one authorized source');
  }
  const ids = new Set<string>();
  const sources = inputSources.map((source, index) => {
    if (ids.has(source.id)) throw new Error('Summary tree source IDs must be unique');
    ids.add(source.id);
    return makeSource(source, index);
  }).sort((left, right) => left.order - right.order || (left.sourceId ?? '').localeCompare(right.sourceId ?? ''));
  const root = buildBalanced(sources);
  const nodes = new Map<string, InternalNode>();
  const collect = (node: InternalNode): void => {
    nodes.set(node.id, node);
    if (node.children) {
      collect(node.children[0]);
      collect(node.children[1]);
    }
  };
  collect(root);

  let selectedRoot = root;
  if (expandNodeId) {
    const target = nodes.get(expandNodeId);
    if (!target?.children) throw new Error('Summary tree node is stale or unavailable');
    selectedRoot = target;
  }

  const selected = new Map<string, InternalNode>([[selectedRoot.id, selectedRoot]]);
  let didExpand = false;
  while (true) {
    const expandable = [...selected.values()]
      .filter((node) => node.children)
      .sort((left, right) => right.order - left.order || left.id.localeCompare(right.id));
    let expanded = false;
    for (const node of expandable) {
      const children = node.children!;
      const trial = new Map(selected);
      trial.delete(node.id);
      trial.set(children[0].id, children[0]);
      trial.set(children[1].id, children[1]);
      try {
        const view = makeView(root.id, [...trial.values()], selectedRoot.sourceCount, budgetTokens, expandNodeId);
        if (view.estimatedTokens <= budgetTokens) {
          selected.clear();
          for (const [id, child] of trial) selected.set(id, child);
          didExpand = true;
          expanded = true;
          break;
        }
      } catch {
        // An expansion that cannot fit leaves its parent summary in the cover.
      }
    }
    if (!expanded) break;
  }
  const ordered = [...selected.values()].sort((left, right) => left.order - right.order || (left.sourceId ?? left.id).localeCompare(right.sourceId ?? right.id));
  return makeView(root.id, ordered, selectedRoot.sourceCount, budgetTokens, didExpand ? expandNodeId : undefined);
}
