/**
 * Unified Knowledge Extractor
 * 
 * Single pipeline that extracts beliefs, strategies, and memory metadata
 * from conversations, learnings, and existing knowledge.
 */

import type {
  KnowledgeKind,
  KnowledgeType,
  KnowledgeStatus,
  BeliefKnowledgeType,
  StrategyKnowledgeType,
  MemoryKnowledgeType,
  ExtractedBelief,
  ExtractedStrategy,
} from './types.js';

// ─── Extraction Result ───────────────────────────────────────────────────────

/**
 * Unified extraction result — can be a belief or strategy.
 * Memory metadata extraction is handled separately (by the memory subsystem).
 */
export type ExtractedKnowledge =
  | { kind: 'belief'; data: ExtractedBelief }
  | { kind: 'strategy'; data: ExtractedStrategy };

/**
 * Extraction options.
 */
export interface ExtractionOptions {
  projectId?: string;
  sourceType?: 'conversation' | 'learning' | 'belief' | 'trace' | 'memory';
  sourceId?: string;
  /** Minimum confidence threshold to include results */
  minConfidence?: number;
}

// ─── Strategy Patterns ───────────────────────────────────────────────────────

interface StrategyPattern {
  regex: RegExp;
  type: StrategyKnowledgeType;
  extract: (match: RegExpMatchArray) => {
    title: string;
    description: string;
    context: string;
    steps: string[];
  };
}

const STRATEGY_PATTERNS: StrategyPattern[] = [
  {
    // "always do X" / "always use Y" / "always try Z"
    regex: /(?:always|consistently)\s+(?:do|use|try|prefer|start|begin|follow)\s+(.+)/gi,
    type: 'procedure',
    extract: (m) => ({
      title: m[1].trim(),
      description: `Always ${m[1].trim()}`,
      context: 'Established procedure',
      steps: [m[1].trim()],
    }),
  },
  {
    // "never do Y" / "never use Z"
    regex: /(?:never|do not|don't)\s+(?:do|use|try|start|begin|allow|skip)\s+(.+)/gi,
    type: 'constraint',
    extract: (m) => ({
      title: m[1].trim(),
      description: `Never ${m[1].trim()}`,
      context: 'Established constraint',
      steps: [],
    }),
  },
  {
    // "when Z, do W" / "when Z, use W"
    regex: /when\s+(.+?),\s*(?:do|use|try|prefer|apply|run)\s+(.+)/gi,
    type: 'heuristic',
    extract: (m) => ({
      title: `When ${m[1].trim()}, ${m[2].trim()}`,
      description: `When ${m[1].trim()}, do ${m[2].trim()}`,
      context: m[1].trim(),
      steps: [m[2].trim()],
    }),
  },
  {
    // "X works well for Y" / "X works best with Y"
    regex: /(.+?)\s+works?\s+(?:well|great|best|nicely)\s+(?:for|with|when)\s+(.+)/gi,
    type: 'pattern',
    extract: (m) => ({
      title: m[1].trim(),
      description: `${m[1].trim()} works well for ${m[2].trim()}`,
      context: m[2].trim(),
      steps: [],
    }),
  },
  {
    // "workaround for Z" / "workaround to Z"
    regex: /(?:workaround|work-around)\s+(?:for|to)\s+(.+)/gi,
    type: 'workaround',
    extract: (m) => ({
      title: `Workaround for ${m[1].trim()}`,
      description: `Workaround for ${m[1].trim()}`,
      context: 'Discovered workaround',
      steps: [],
    }),
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cleanStatement(input: string): string {
  return input
    .replace(/^(decision:|constraint:|state change:|reject(?:ed)?:|failure:|preference:)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitReason(text: string): { statement: string; reason?: string } {
  const match = text.match(/^(.*?)(?:\s+because\s+|\s+due to\s+)(.+)$/i);
  if (!match) return { statement: cleanStatement(text) };
  return {
    statement: cleanStatement(match[1]),
    reason: cleanStatement(match[2]),
  };
}

function deriveBeliefConfidence(type: BeliefKnowledgeType, hasReason: boolean): number {
  const base =
    type === 'decision' ? 0.84 :
    type === 'preference' ? 0.80 :
    type === 'failure_cause' ? 0.82 :
    type === 'constraint' ? 0.78 :
    type === 'state_change' ? 0.76 :
    0.74;
  return hasReason ? Math.min(0.95, base + 0.05) : base;
}

function deriveStrategyConfidence(type: StrategyKnowledgeType, hasSteps: boolean): number {
  const base =
    type === 'procedure' ? 0.85 :
    type === 'constraint' ? 0.82 :
    type === 'heuristic' ? 0.78 :
    type === 'pattern' ? 0.80 :
    0.72;
  return hasSteps ? Math.min(0.95, base + 0.05) : base;
}

function cleanTitle(input: string): string {
  return input
    .replace(/\s+/g, ' ')
    .replace(/^[,;:.]+/, '')
    .replace(/[,;:.]+$/, '')
    .trim();
}

// ─── Belief Extraction ───────────────────────────────────────────────────────

/**
 * Extract beliefs from memory content or conversation text.
 * Pattern-based extraction (no LLM call).
 */
function extractBeliefsFromText(
  text: string,
  memoryId: string,
  memoryType: string,
  options: ExtractionOptions,
): ExtractedBelief[] {
  const lowered = text.toLowerCase();
  const beliefs: ExtractedBelief[] = [];

  const addBelief = (belief: Omit<ExtractedBelief, 'sourceMemoryIds' | 'confidence'> & { confidence?: number }) => {
    const cleanedStatement = cleanStatement(belief.statement);
    if (!cleanedStatement || cleanedStatement.length < 8) return;
    beliefs.push({
      ...belief,
      statement: cleanedStatement,
      confidence: belief.confidence ?? deriveBeliefConfidence(belief.type, Boolean(belief.reason)),
      sourceMemoryIds: [memoryId],
    });
  };

  // Decision patterns
  if (memoryType === 'decision' || /\b(decision:|decided to|we chose|going with|final decision)\b/i.test(text)) {
    const { statement, reason } = splitReason(text);
    addBelief({
      type: 'decision',
      statement,
      reason,
      status: 'active',
      evidenceSummary: text,
    });
  }

  // Preference patterns
  if (memoryType === 'preference' || /\b(prefers?|likes?|dislikes?|hates?)\b/i.test(text)) {
    const { statement, reason } = splitReason(text);
    addBelief({
      type: 'preference',
      statement,
      reason,
      status: 'active',
      evidenceSummary: text,
    });
  }

  // Failure cause patterns
  const failureMatch = text.match(/\b(?:failed|failure|broke|error)\b.*?(?:because|due to)\s+(.+)/i);
  if (failureMatch) {
    addBelief({
      type: 'failure_cause',
      statement: cleanStatement(text.split(/(?:because|due to)/i)[0] ?? text),
      reason: cleanStatement(failureMatch[1]),
      status: 'active',
      evidenceSummary: text,
    });
  }

  // Constraint patterns
  if (/\b(constraint:|must not|cannot|can't|blocked by|required to|needs to)\b/i.test(text)) {
    addBelief({
      type: 'constraint',
      statement: text,
      status: 'active',
      evidenceSummary: text,
    });
  }

  // State change patterns
  const stateMatch = text.match(/\b(?:state changed from|changed from)\s+(.+?)\s+to\s+(.+?)(?:\s+after\s+(.+))?$/i);
  if (stateMatch) {
    addBelief({
      type: 'state_change',
      statement: `${cleanStatement(stateMatch[1])} -> ${cleanStatement(stateMatch[2])}`,
      reason: stateMatch[3] ? cleanStatement(stateMatch[3]) : undefined,
      status: 'active',
      evidenceSummary: text,
    });
  }

  // Dispute patterns
  const disputePatterns = [
    /\b(reject|rejected|do not use|don't use|instead of)\b/i,
    /\bbandaid\b/i,
  ];
  if (disputePatterns.some((pattern) => pattern.test(text))) {
    const sentence = text.split(/[.!?]/).find((part) => /reject|bandaid|instead of|do not use|don't use/i.test(part)) ?? text;
    addBelief({
      type: 'dispute',
      statement: sentence,
      status: 'disputed',
      evidenceSummary: text,
    });
  }

  // Deduplicate beliefs
  const deduped = new Map<string, ExtractedBelief>();
  for (const belief of beliefs) {
    const key = `${belief.type}:${belief.statement.toLowerCase()}`;
    if (!deduped.has(key)) deduped.set(key, belief);
  }

  // Return empty if no belief signals found
  if (deduped.size === 0 && !/\b(because|due to|prefer|decision|constraint|changed from|reject)\b/.test(lowered)) {
    return [];
  }

  return [...deduped.values()];
}

/**
 * Extract beliefs from a learning entry.
 */
function extractBeliefsFromLearning(
  learning: { content: string; type: string },
  options: ExtractionOptions,
): ExtractedBelief[] {
  const text = learning.content.trim();
  if (!text || text.length < 8) return [];

  // Learnings can have implicit beliefs — extract them as-is
  return extractBeliefsFromText(text, learning.type, learning.type, options);
}

// ─── Strategy Extraction ─────────────────────────────────────────────────────

/**
 * Extract strategies from conversation text using regex patterns.
 */
function extractStrategiesFromText(
  conversation: string,
  options: ExtractionOptions,
): ExtractedStrategy[] {
  const strategies: ExtractedStrategy[] = [];
  const deduped = new Map<string, ExtractedStrategy>();

  for (const pattern of STRATEGY_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.regex.lastIndex = 0;
    let match: RegExpMatchArray | null;

    while ((match = pattern.regex.exec(conversation)) !== null) {
      const extracted = pattern.extract(match);
      const title = cleanTitle(extracted.title);

      if (!title || title.length < 4) continue;

      const key = `${pattern.type}:${title.toLowerCase()}`;
      if (deduped.has(key)) continue;

      const hasSteps = extracted.steps.length > 0;
      const strategy: ExtractedStrategy = {
        strategyType: pattern.type,
        title,
        description: extracted.description,
        context: extracted.context,
        steps: extracted.steps,
        successCriteria: '',
        failureIndicators: '',
        confidence: deriveStrategyConfidence(pattern.type, hasSteps),
        sourceType: options.sourceType ?? 'conversation',
        sourceId: options.sourceId ?? options.projectId ?? 'unknown',
      };

      deduped.set(key, strategy);
      strategies.push(strategy);
    }
  }

  return strategies;
}

/**
 * Extract strategies from a learning entry.
 * Successes become patterns/procedures, failures become constraints.
 */
function extractStrategiesFromLearning(
  learning: { content: string; type: string },
  options: ExtractionOptions,
): ExtractedStrategy[] {
  const strategies: ExtractedStrategy[] = [];
  const text = learning.content.trim();

  if (!text || text.length < 8) return strategies;

  if (learning.type === 'success' || learning.type === 'insight') {
    const hasAction = /\b(always|consistently|tried|used|applied)\b/i.test(text);
    const strategyType: StrategyKnowledgeType = hasAction ? 'procedure' : 'pattern';

    strategies.push({
      strategyType,
      title: text.slice(0, 120),
      description: text,
      context: `Learning from ${learning.type}`,
      steps: [],
      successCriteria: learning.type === 'success' ? text : '',
      failureIndicators: '',
      confidence: deriveStrategyConfidence(strategyType, false),
      sourceType: 'learning',
      sourceId: options.sourceId ?? options.projectId ?? 'unknown',
    });
  }

  if (learning.type === 'failure') {
    const hasWorkaround = /\b(workaround|work-around|instead|fixed by)\b/i.test(text);
    const strategyType: StrategyKnowledgeType = hasWorkaround ? 'workaround' : 'constraint';

    strategies.push({
      strategyType,
      title: text.slice(0, 120),
      description: text,
      context: 'Learning from failure',
      steps: [],
      successCriteria: '',
      failureIndicators: text,
      confidence: deriveStrategyConfidence(strategyType, false),
      sourceType: 'learning',
      sourceId: options.sourceId ?? options.projectId ?? 'unknown',
    });
  }

  if (learning.type === 'fix') {
    strategies.push({
      strategyType: 'procedure',
      title: text.slice(0, 120),
      description: text,
      context: 'Fix applied',
      steps: [text],
      successCriteria: '',
      failureIndicators: '',
      confidence: deriveStrategyConfidence('procedure', true),
      sourceType: 'learning',
      sourceId: options.sourceId ?? options.projectId ?? 'unknown',
    });
  }

  return strategies;
}

/**
 * Extract strategies from a belief.
 * Decisions become procedures, constraints stay constraints.
 */
function extractStrategiesFromBelief(
  belief: { statement: string; beliefType: string },
  options: ExtractionOptions,
): ExtractedStrategy[] {
  const strategies: ExtractedStrategy[] = [];
  const text = belief.statement.trim();

  if (!text || text.length < 8) return strategies;

  if (belief.beliefType === 'decision') {
    strategies.push({
      strategyType: 'procedure',
      title: text.slice(0, 120),
      description: text,
      context: 'Derived from decision belief',
      steps: [],
      successCriteria: '',
      failureIndicators: '',
      confidence: 0.75,
      sourceType: 'belief',
      sourceId: options.sourceId ?? options.projectId ?? 'unknown',
    });
  }

  if (belief.beliefType === 'constraint') {
    strategies.push({
      strategyType: 'constraint',
      title: text.slice(0, 120),
      description: text,
      context: 'Derived from constraint belief',
      steps: [],
      successCriteria: '',
      failureIndicators: text,
      confidence: 0.78,
      sourceType: 'belief',
      sourceId: options.sourceId ?? options.projectId ?? 'unknown',
    });
  }

  if (belief.beliefType === 'preference') {
    strategies.push({
      strategyType: 'heuristic',
      title: text.slice(0, 120),
      description: text,
      context: 'Derived from preference belief',
      steps: [],
      successCriteria: '',
      failureIndicators: '',
      confidence: 0.72,
      sourceType: 'belief',
      sourceId: options.sourceId ?? options.projectId ?? 'unknown',
    });
  }

  return strategies;
}

// ─── Unified Extraction API ──────────────────────────────────────────────────

/**
 * Extract beliefs from a memory.
 * Wraps the belief extraction logic into the unified pipeline.
 */
export function extractBeliefs(
  input: {
    memoryId: string;
    content: string;
    type: string;
    metadata?: Record<string, unknown> | null;
  },
  options: ExtractionOptions = {},
): ExtractedBelief[] {
  const minConf = options.minConfidence ?? 0;
  const beliefs = extractBeliefsFromText(input.content, input.memoryId, input.type, options);
  return beliefs.filter((b) => b.confidence >= minConf);
}

/**
 * Extract strategies from conversation text.
 */
export function extractConversationStrats(
  conversation: string,
  options: ExtractionOptions = {},
): ExtractedStrategy[] {
  const minConf = options.minConfidence ?? 0;
  return extractStrategiesFromText(conversation, options).filter(
    (s) => s.confidence >= minConf,
  );
}

/**
 * Extract strategies from a learning entry.
 */
export function extractLearningStrats(
  learning: { content: string; type: string },
  options: ExtractionOptions = {},
): ExtractedStrategy[] {
  const minConf = options.minConfidence ?? 0;
  return extractStrategiesFromLearning(learning, options).filter(
    (s) => s.confidence >= minConf,
  );
}

/**
 * Extract strategies from a belief.
 */
export function extractBeliefStrats(
  belief: { statement: string; beliefType: string },
  options: ExtractionOptions = {},
): ExtractedStrategy[] {
  const minConf = options.minConfidence ?? 0;
  return extractStrategiesFromBelief(belief, options).filter(
    (s) => s.confidence >= minConf,
  );
}

/**
 * Extract ALL knowledge (beliefs + strategies) from a memory in one call.
 * This is the main entry point for the unified extraction pipeline.
 */
export function knowledgeFromMemory(
  input: {
    memoryId: string;
    content: string;
    type: string;
    metadata?: Record<string, unknown> | null;
  },
  options: ExtractionOptions = {},
): ExtractedKnowledge[] {
  const results: ExtractedKnowledge[] = [];
  const minConf = options.minConfidence ?? 0;

  // Extract beliefs
  const beliefs = extractBeliefsFromText(input.content, input.memoryId, input.type, options);
  for (const belief of beliefs) {
    if (belief.confidence >= minConf) {
      results.push({ kind: 'belief', data: belief });
    }
  }

  // Extract strategies from same text
  const strategies = extractStrategiesFromText(input.content, options);
  for (const strategy of strategies) {
    if (strategy.confidence >= minConf) {
      results.push({ kind: 'strategy', data: strategy });
    }
  }

  return results;
}

/**
 * Extract ALL knowledge from a learning entry.
 */
export function knowledgeFromLearning(
  learning: { content: string; type: string },
  options: ExtractionOptions = {},
): ExtractedKnowledge[] {
  const results: ExtractedKnowledge[] = [];
  const minConf = options.minConfidence ?? 0;

  const beliefs = extractBeliefsFromLearning(learning, options);
  for (const belief of beliefs) {
    if (belief.confidence >= minConf) {
      results.push({ kind: 'belief', data: belief });
    }
  }

  const strategies = extractStrategiesFromLearning(learning, options);
  for (const strategy of strategies) {
    if (strategy.confidence >= minConf) {
      results.push({ kind: 'strategy', data: strategy });
    }
  }

  return results;
}
