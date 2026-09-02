/**
 * SDK Configuration Interface
 * 
 * Defines the configuration options for the SquishClient.
 * All providers are pluggable and optional.
 */

import type { StorageProvider } from './storage.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { LLMProvider } from './llm.js';
import type { EventBus } from './events.js';

export interface SquishConfig {
  /**
   * Data directory path (default: ~/.local/share/squish)
   */
  dataDir?: string;
  
  /**
   * Project path for scoping memories
   */
  project?: string;
  
  /**
   * Pluggable storage provider (default: SQLiteStorageProvider)
   */
  storage?: StorageProvider;
  
  /**
   * Pluggable embedding provider (default: null - no embeddings)
   */
  embeddings?: EmbeddingProvider;
  
  /**
   * Pluggable LLM provider (default: null - no LLM)
   */
  llm?: LLMProvider;
  
  /**
   * Pluggable event bus (default: DefaultEventBus)
   */
  events?: EventBus;
  
  /**
   * Feature flags
   */
  lifecycleEnabled?: boolean;
  graphAutoBuild?: boolean;
  consolidationEnabled?: boolean;
  sessionAutoLoadEnabled?: boolean;
  
  /**
   * Scoring weights for hybrid search
   */
  scoringWeights?: {
    recency?: number;
    relevance?: number;
    importance?: number;
    vectorSim?: number;
    graphBoost?: number;
  };
  
  /**
   * Embedding configuration (used when no custom embedding provider is provided)
   */
  embeddingConfig?: {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  
  /**
   * LLM configuration (used when no custom LLM provider is provided)
   */
  llmConfig?: {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    maxTokens?: number;
    temperature?: number;
  };
}
