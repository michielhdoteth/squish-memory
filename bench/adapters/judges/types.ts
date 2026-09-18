/**
 * Judge adapter interface.
 *
 * Separate from the answer model to avoid self-evaluation bias.
 * The judge evaluates answer correctness, groundedness, staleness, and abstention.
 */

export interface JudgeInput {
  /** The original query */
  query: string;
  /** The answer to evaluate */
  answer: string;
  /** The expected/reference answer */
  expected: string;
  /** The retrieved context used to generate the answer */
  context: string[];
}

export interface JudgeResult {
  /** Whether the answer is correct */
  correct: boolean;
  /** Whether the answer is grounded in the retrieved context */
  grounded: boolean;
  /** Whether the answer contradicts newer/updated information */
  stale: boolean;
  /** Whether the system should have abstained (unanswerable query) */
  shouldAbstain: boolean;
  /** Judge confidence in its assessment (0-1) */
  confidence: number;
  /** Judge reasoning (for debugging) */
  reasoning?: string;
  /** Latency in milliseconds */
  latencyMs: number;
}

export interface JudgeAdapter {
  /** Human-readable name */
  name: string;
  /** Evaluate an answer */
  judge(input: JudgeInput): Promise<JudgeResult>;
}
