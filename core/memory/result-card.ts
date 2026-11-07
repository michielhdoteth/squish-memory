/** Compact search-result cards inspired by Leviathan's cited result cards. */
export interface ResultCard {
  id: string;
  title: string | null;
  date: string | null;
  snippet: string | null;
  rank: number | null;
  relevance: number | null;
}

/** Return the sentence containing the most distinct query-term matches. */
export function buildSnippet(content: string, queryWords: string[], maxChars = 300): string | null {
  const terms = [...new Set(queryWords.map(word => word.toLocaleLowerCase()).filter(Boolean))];
  if (!terms.length || maxChars < 1) return null;

  const sentences = content.match(/[^.!?;]+[.!?;]?(?=\s|$)/gu) ?? [];
  let best: { text: string; hits: number } | null = null;
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const lower = sentence.toLocaleLowerCase();
    const hits = terms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
    if (hits > 0 && (!best || hits > best.hits)) best = { text: sentence, hits };
  }

  if (!best) return null;
  if (best.text.length <= maxChars) return best.text;

  const lower = best.text.toLocaleLowerCase();
  const firstMatch = Math.min(...terms.map(term => lower.indexOf(term)).filter(index => index >= 0));
  const start = Math.max(0, Math.min(firstMatch - 40, best.text.length - maxChars));
  const end = Math.min(best.text.length, start + maxChars);
  const excerpt = best.text.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${end < best.text.length ? '…' : ''}`;
}

export function buildResultCard(
  result: { id: string; content: string; summary?: string | null; createdAt?: string | null },
  queryWords: string[],
  rank: number | null = null,
  relevance: number | null = null
): ResultCard {
  return {
    id: result.id,
    title: result.summary ?? null,
    date: result.createdAt ?? null,
    snippet: buildSnippet(result.content, queryWords),
    rank,
    relevance,
  };
}
