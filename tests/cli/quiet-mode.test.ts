/**
 * Tests for the CLI quiet-mode helper.
 *
 * The 15 command files that used to carry hand-written save/restore blocks are
 * the reason this helper exists; these tests pin the semantics those blocks had
 * to get right by hand, especially the failure modes that were invisible:
 * restoring an unset variable (must delete, not set ''), restoring a prior
 * value, and never touching the environment when quiet mode is not requested.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { suppressQuietMode } from '../../cli/quiet-mode.js';

const KEY = 'SQUISH_QUIET';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
  delete process.env[KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe('suppressQuietMode', () => {
  it('sets SQUISH_QUIET while active', () => {
    const restore = suppressQuietMode(true);
    expect(process.env[KEY]).toBe('1');
    restore();
  });

  it('deletes the variable on restore when it was unset', () => {
    const restore = suppressQuietMode(true);
    expect(process.env[KEY]).toBe('1');
    restore();
    expect(process.env[KEY]).toBeUndefined();
    expect(KEY in process.env).toBe(false);
  });

  it('restores the previous value instead of deleting it', () => {
    process.env[KEY] = '0';
    const restore = suppressQuietMode(true);
    expect(process.env[KEY]).toBe('1');
    restore();
    expect(process.env[KEY]).toBe('0');
  });

  it('does not touch the environment when quiet is false', () => {
    const restore = suppressQuietMode(false);
    expect(KEY in process.env).toBe(false);
    restore();
    expect(KEY in process.env).toBe(false);
  });

  it('leaves a pre-existing value alone when quiet is false', () => {
    process.env[KEY] = '1';
    const restore = suppressQuietMode(false);
    expect(process.env[KEY]).toBe('1');
    restore();
    expect(process.env[KEY]).toBe('1');
  });

  it('ignores a second restore call', () => {
    process.env[KEY] = '0';
    const restore = suppressQuietMode(true);
    restore();
    expect(process.env[KEY]).toBe('0');
    // A stray second call must not resurrect or delete the key.
    restore();
    expect(process.env[KEY]).toBe('0');
  });

  it('restores the captured value, not the live one', () => {
    // The value is captured when the helper is called. An overwrite made after
    // that is reverted, which is the behaviour the hand-written blocks had.
    const restore = suppressQuietMode(true);
    process.env[KEY] = 'manually-overwritten';
    restore();
    expect(process.env[KEY]).toBeUndefined();
  });
});
