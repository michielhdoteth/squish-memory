const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'was', 'what',
  'when', 'where', 'which', 'who', 'why', 'with',
]);

function terms(value: string): string[] {
  return (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));
}

/** Deterministic query-fragment coverage labels, derived only from the query and returned rows. */
export function findMissingQueryParts(query: string, contents: string[]): string[] {
  const fragments = query
    .split(/\s*,\s*|\s+and\s+|\s+or\s+/i)
    .map((part) => part.replace(/^\s*(?:and|or)\s+/i, '').trim())
    .filter((part) => terms(part).length > 0)
    .slice(0, 6);
  const memoryTerms = contents.map((content) => new Set(terms(content)));

  return fragments
    .filter((fragment) => {
      const fragmentTerms = [...new Set(terms(fragment))];
      const covered = fragmentTerms.some((term) =>
        memoryTerms.some((candidate) => candidate.has(term))
      );
      const matching = fragmentTerms.filter((term) =>
        memoryTerms.some((candidate) => candidate.has(term))
      ).length;
      return !covered || matching / fragmentTerms.length < 0.6;
    })
    .map((fragment) => fragment.slice(0, 60))
    .reduce<string[]>((labels, label) => {
      const remaining = 240 - labels.reduce((total, current) => total + current.length, 0);
      if (remaining <= 0) return labels;
      labels.push(label.slice(0, remaining));
      return labels;
    }, []);
}
