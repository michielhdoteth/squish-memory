import { buildProgressiveTemporalSummaryTree, type ProgressiveTreeSource, type ProgressiveTreeView } from '../../core/sessions/progressive-tree.js';

export interface FlatContextItem {
  sourceId: string;
  createdAt: string;
  text: string;
  textTruncated?: boolean;
}

export interface FlatContextView {
  budgetTokens: number;
  estimatedTokens: number;
  items: FlatContextItem[];
}

export function estimateSerializedTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

/** Budgeted chronological flat baseline: newest complete sources are preferred. */
export function buildFlatContext(
  sources: readonly ProgressiveTreeSource[],
  budgetTokens: number,
): FlatContextView {
  if (!Number.isInteger(budgetTokens) || budgetTokens < 1) throw new Error('Context budget must be a positive integer');
  const items: FlatContextItem[] = [];
  const ordered = [...sources].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '') || a.id.localeCompare(b.id));
  for (const source of ordered) {
    const full: FlatContextItem = { sourceId: source.id, createdAt: source.createdAt ?? '', text: source.content };
    const withFull = [...items, full];
    if (estimateSerializedTokens({ budgetTokens, items: withFull }) <= budgetTokens) {
      items.push(full);
      continue;
    }
    if (items.length > 0) continue;
    const envelope = { budgetTokens, items: [] as FlatContextItem[] };
    let remainingChars = Math.max(0, budgetTokens * 4 - JSON.stringify(envelope).length - source.id.length - (source.createdAt?.length ?? 0) - 32);
    const partial: FlatContextItem = { sourceId: source.id, createdAt: source.createdAt ?? '', text: source.content.slice(0, remainingChars), textTruncated: true };
    while (remainingChars > 0 && estimateSerializedTokens({ budgetTokens, items: [partial] }) > budgetTokens) {
      remainingChars -= 4;
      partial.text = source.content.slice(0, Math.max(0, remainingChars));
    }
    if (estimateSerializedTokens({ budgetTokens, items: [partial] }) <= budgetTokens) items.push(partial);
  }
  const view = { budgetTokens, items };
  return { ...view, estimatedTokens: estimateSerializedTokens(view) };
}

export interface EvidenceCoverage {
  detailedSourceVisible: boolean;
  evidenceMarkerVisible: boolean;
}

export function scoreFlatEvidence(view: FlatContextView, sourceId: string, marker: string): EvidenceCoverage {
  const item = view.items.find((candidate) => candidate.sourceId === sourceId);
  return {
    detailedSourceVisible: item !== undefined && !item.textTruncated,
    evidenceMarkerVisible: item?.text.includes(marker) ?? false,
  };
}

export function scoreTreeEvidence(view: ProgressiveTreeView, sourceId: string, marker: string): EvidenceCoverage {
  const detail = view.items.find((item) => item.kind === 'source' && item.sourceId === sourceId);
  return {
    detailedSourceVisible: detail?.textTruncated !== true && detail?.text !== undefined,
    evidenceMarkerVisible: view.items.some((item) => item.preview.includes(marker) || item.text?.includes(marker)),
  };
}

export function buildTreeContext(sources: readonly ProgressiveTreeSource[], budgetTokens: number): ProgressiveTreeView {
  return buildProgressiveTemporalSummaryTree(sources, budgetTokens);
}
