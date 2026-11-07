import { describe, expect, it } from 'bun:test';
import { applySandboxAction, parseMemoryAction, statesEqual } from '../../benchmark/scoring/action-task.js';

describe('sandbox action task contract', () => {
  it('parses an ordinary memory instruction into a constrained field assignment', () => {
    expect(parseMemoryAction('Procedure: When release_status is blocked, set release_channel to manual.'))
      .toEqual({ conditionField: 'release_status', conditionValue: 'blocked', targetField: 'release_channel', targetValue: 'manual' });
  });

  it('does not execute an action whose stated condition is false', () => {
    const action = parseMemoryAction('When retention_state is expired, set retention_action to quarantine.');
    expect(action).not.toBeNull();
    expect(applySandboxAction({ retention_state: 'valid', retention_action: 'keep' }, action!)).toBeNull();
  });

  it('applies only an in-memory state change and scores exact outcomes', () => {
    const state = { approval: 'pending', publication: 'ready' };
    const action = parseMemoryAction('When approval is pending, set publication to hold.');
    const result = action ? applySandboxAction(state, action) : null;
    expect(result).toEqual({ approval: 'pending', publication: 'hold' });
    expect(state.publication).toBe('ready');
    expect(statesEqual(result ?? {}, { approval: 'pending', publication: 'hold' })).toBe(true);
    expect(statesEqual(result ?? {}, { approval: 'approved', publication: 'hold' })).toBe(false);
  });
});
