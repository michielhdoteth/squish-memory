import { describe, expect, test } from 'bun:test';
import { isGeneratedContextEcho } from '../../../core/memory/context-echo.js';

describe('generated context echo detection', () => {
  test('recognizes framed bootstrap and injected context blocks', () => {
    expect(isGeneratedContextEcho('# Session bootstrap\n\n## Verified memories\n- [fact] The service is active (memory:01234567-89ab-cdef-0123-456789abcdef)'))
      .toBe(true);
    expect(isGeneratedContextEcho('# Session bootstrap\r\n\r\n## Verified memories\r\n- [fact] The service is active (memory:01234567-89ab-cdef-0123-456789abcdef)'))
      .toBe(true);
    expect(isGeneratedContextEcho('# Auto-injected context\n\nSession bootstrap from squish (~20/2000 tokens):\n\n# Session bootstrap\n\n## Core memory\n- [fact] The service is active (memory:01234567-89ab-cdef-0123-456789abcdef)'))
      .toBe(true);
    expect(isGeneratedContextEcho('<squish-context>\n## Recent Activity\n- [2026-10-19] A prior session\n</squish-context>'))
      .toBe(true);
  });

  test('does not reject ordinary prose that discusses context framing', () => {
    expect(isGeneratedContextEcho('Remember that the heading "# Session bootstrap" appears in our docs.'))
      .toBe(false);
    expect(isGeneratedContextEcho('# Session bootstrap\n\nThis document explains how the bootstrap format works.'))
      .toBe(false);
    expect(isGeneratedContextEcho(''))
      .toBe(false);
  });
});
