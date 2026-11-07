const GENERATED_BOOTSTRAP_SECTION = /^## (?:Core memory|Verified memories|Caller-scoped working set|Beliefs|Pinned memories|Recent decisions)$/m;
const GENERATED_CONTEXT_REFERENCE = /\(memory:[0-9a-f-]{36}\)/i;

/** Recognize complete, system-framed context blocks so recalled context is not learned as new user memory. */
export function isGeneratedContextEcho(content: string): boolean {
  const text = content.trim().replace(/\r\n?/g, '\n');
  if (!text) return false;

  const isBootstrap = text.startsWith('# Session bootstrap\n')
    && GENERATED_BOOTSTRAP_SECTION.test(text)
    && (GENERATED_CONTEXT_REFERENCE.test(text)
      || /\(no (?:verified )?context available(?: yet)?\)/i.test(text));
  if (isBootstrap) return true;

  const isInjectedBootstrap = /^# Auto-injected context\n[\s\S]*?Session bootstrap from squish\b/i.test(text)
    && GENERATED_BOOTSTRAP_SECTION.test(text)
    && GENERATED_CONTEXT_REFERENCE.test(text);
  if (isInjectedBootstrap) return true;

  return /^<squish-context>[\s\S]*<\/squish-context>$/.test(text)
    || /^<squish-folder-context>[\s\S]*<\/squish-folder-context>$/.test(text);
}
