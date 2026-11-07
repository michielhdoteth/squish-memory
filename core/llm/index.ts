/**
 * LLM Module — Barrel Export
 *
 * Auto-registers all providers on import. Import from here to use the LLM system.
 */

export { callLLM, callLLMWithContent, registerProvider, getActiveProviderName } from './client.js';
export type { LLMCallOptions, LLMContentPart, LLMProvider, LLMTokenUsage } from './types.js';

// Auto-register all providers
import { registerProvider } from './client.js';
import { openaiProvider } from './providers/openai.js';
import { anthropicProvider } from './providers/anthropic.js';
import { googleProvider } from './providers/google.js';
import { ollamaProvider } from './providers/ollama.js';
import { lmstudioProvider } from './providers/lmstudio.js';

registerProvider('openai', openaiProvider);
registerProvider('anthropic', anthropicProvider);
registerProvider('google', googleProvider);
registerProvider('ollama', ollamaProvider);
registerProvider('lmstudio', lmstudioProvider);
// 'local' is an alias for lmstudio in the config
registerProvider('local', lmstudioProvider);
