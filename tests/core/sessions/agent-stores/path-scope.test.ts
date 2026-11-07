import { describe, expect, it } from 'bun:test';
import { isWithinDirectoryScope, normalizeDirectoryScope, sqliteDirectoryScope } from '../../../../core/sessions/agent-stores/path-scope.js';

describe('session project path scope', () => {
  it('matches a directory and descendants across slash and case differences', () => {
    expect(isWithinDirectoryScope('C:\\Repos\\DecisionBench', 'c:/repos/decisionbench/')).toBe(true);
    expect(isWithinDirectoryScope('C:/Repos/DecisionBench/sub/project', 'c:\\repos\\decisionbench')).toBe(true);
    expect(isWithinDirectoryScope('/work/repos/project/sub', '/work/repos/project')).toBe(true);
  });

  it('does not match sibling names or parent directories', () => {
    expect(isWithinDirectoryScope('C:\\Repos\\DecisionBench-old', 'C:\\Repos\\DecisionBench')).toBe(false);
    expect(isWithinDirectoryScope('C:\\Repos\\DecisionBench', 'C:\\Repos\\DecisionBench\\sub')).toBe(false);
    expect(isWithinDirectoryScope('/work/project-other', '/work/project')).toBe(false);
  });

  it('fails closed for empty scopes and emits segment-bounded SQL', () => {
    expect(normalizeDirectoryScope('///')).toBeNull();
    expect(sqliteDirectoryScope('cwd', '///').clause).toBe('0 = 1');
    const predicate = sqliteDirectoryScope('cwd', 'C:\\Repos\\DecisionBench');
    expect(predicate.clause).toContain('SUBSTR');
    expect(predicate.params).toEqual(['c:/repos/decisionbench', 'c:/repos/decisionbench/', 'c:/repos/decisionbench/']);
  });
});
