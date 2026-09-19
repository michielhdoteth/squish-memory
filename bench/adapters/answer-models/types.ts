/**
 * Answer adapter interface.
 *
 * Each provider (OpenAI, NVIDIA, Ollama, local) implements this.
 * The adapter takes a query + retrieved context and returns an answer string.
 */

export interface AnswerInput {
  /** The user query */
  query: string;
  /** Retrieved memory contents as context strings */
  context: string[];
}

export interface AnswerResult {
  /** The generated answer */
  answer: string;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Provider used */
  provider: string;
  /** Model used */
  model: string;
  /** Token usage if available */
  tokens?: { prompt: number; completion: number };
}

export interface AnswerAdapter {
  /** Human-readable name (e.g., "openai:gpt-4o-mini") */
  name: string;
  /** Generate an answer from query + context */
  answer(input: AnswerInput): Promise<AnswerResult>;
}
