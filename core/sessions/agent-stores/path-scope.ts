/** Normalize a session directory scope without losing POSIX or drive roots. */
export function normalizeDirectoryScope(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /^[\\/]{2,}$/.test(trimmed)) return null;

  let normalized = trimmed.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  if (/^[a-z]:\/$/.test(normalized) || normalized === '/') return normalized;
  normalized = normalized.replace(/\/+$/, '');
  return normalized || null;
}

/** True only for the requested directory or a descendant path. */
export function isWithinDirectoryScope(candidate: string, scope: string): boolean {
  const normalizedCandidate = normalizeDirectoryScope(candidate);
  const normalizedScope = normalizeDirectoryScope(scope);
  if (!normalizedCandidate || !normalizedScope) return false;
  if (normalizedCandidate === normalizedScope) return true;
  const prefix = normalizedScope.endsWith('/') ? normalizedScope : `${normalizedScope}/`;
  return normalizedCandidate.startsWith(prefix);
}

/** Build a case-insensitive SQLite predicate with path-segment boundaries. */
export function sqliteDirectoryScope(column: string, scopeValue: string): { clause: string; params: string[] } {
  const scope = normalizeDirectoryScope(scopeValue);
  if (!scope) return { clause: '0 = 1', params: [] };

  const normalizedColumn = `LOWER(REPLACE(${column}, char(92), '/'))`;
  const prefix = scope.endsWith('/') ? scope : `${scope}/`;
  return {
    clause: `(LOWER(RTRIM(REPLACE(${column}, char(92), '/'), '/')) = ? OR SUBSTR(${normalizedColumn}, 1, LENGTH(?)) = ?)`,
    params: [scope, prefix, prefix],
  };
}
