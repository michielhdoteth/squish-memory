export interface SandboxAction {
  conditionField: string;
  conditionValue: string;
  targetField: string;
  targetValue: string;
}

export function parseMemoryAction(content: string): SandboxAction | null {
  const match = content.match(/\bwhen\s+([a-z][a-z0-9_]*)\s+is\s+([a-z0-9_-]+),\s*set\s+([a-z][a-z0-9_]*)\s+to\s+([a-z0-9_-]+)\b/i);
  if (!match) return null;
  const [, conditionField, conditionValue, targetField, targetValue] = match;
  if (!conditionField || !conditionValue || !targetField || !targetValue) return null;
  return { conditionField, conditionValue, targetField, targetValue };
}

/** Apply an allow-listed field assignment to an isolated in-memory task state. */
export function applySandboxAction(
  state: Readonly<Record<string, string>>,
  action: SandboxAction,
): Record<string, string> | null {
  if (state[action.conditionField] !== action.conditionValue) return null;
  return { ...state, [action.targetField]: action.targetValue };
}

export function statesEqual(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}
