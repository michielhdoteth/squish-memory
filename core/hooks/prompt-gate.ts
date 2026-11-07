/**
 * Prompt Gate -- harness hook decision layer
 *
 * Decides whether memory context should be searched for a user prompt.
 * Runs as part of the `squish gate` CLI command, which the UserPromptSubmit
 * hook spawns in the background so it never blocks the prompt.
 *
 * Rules execute first and are the fallback (target < 50ms, zero cost):
 *  1. Opt-out phrases win immediately: the user asked to NOT use memory.
 *  2. Empty or greeting-only prompts are not tasks: no search.
 *  3. Clear task cues or a substantial prompt: search.
 *  4. Anything else: search (fail open -- memory is additive, a missed
 *     gate only costs tokens while a broken gate loses recall).
 *
 * With model escalation enabled (SQUISH_PROMPT_GATE_MODEL_ESCALATION plus the
 * decision layer flags), only the uncertain rule cases go to the model, and
 * the model decision wins only when confident (>= gate threshold). Any
 * failure, timeout, or malformed output keeps the rules result.
 *
 * Output contract: {search, queryHints, reason, source}. No prompt text is
 * ever logged.
 */

import { config } from '../../config.js';
import { getDecisionRunner } from '../decision-model/backend-factory.js';
import type { DecisionRunner } from '../decision-model/backend-factory.js';
import type { ModelGate } from '../decision-model/prompts.js';
import { throwIfDecisionAborted } from '../decision-model/types.js';

export interface PromptGateInput {
  /** The raw user prompt text. */
  prompt: string;
  /** Working directory the prompt was submitted from (project scope). */
  cwd?: string;
}

export interface PromptGateResult {
  search: boolean;
  queryHints: string[];
  reason: string;
  source: 'rule' | 'model' | 'failopen';
}

export interface PromptGateOptions {
  /** Caller cancellation; the deterministic gate result remains the fallback. */
  signal?: AbortSignal;
  /**
   * Injected model surface for tests. Defaults to the configured decision
   * backend runner. Phase B7: when the runner exposes the fan-out method
   * (System One only), search AND hint domain come from ONE call; clients
   * without it keep the single-question path unchanged.
   */
  client?: Pick<DecisionRunner, 'gatePromptModelOnly'> &
    Partial<Pick<DecisionRunner, 'gateWithHintDomainModelOnly'>>;
}

// ─── Rule patterns ─────────────────────────────────────────----------------

/** Explicit opt-outs, checked before anything else (ADR-004). */
const OPT_OUT_PATTERNS: RegExp[] = [
  /without using memory/i,
  /don'?t use memory/i,
  /\bno memory\b/i,
  /ignore memory/i,
];

/** Prompt is nothing but a greeting or short acknowledgment. */
const GREETING_PATTERN =
  /^(?:hi+|hey+|hello+|yo|sup|gm|good\s+(?:morning|afternoon|evening)|thanks(?:\s+you)?|thank\s+you|thx|ty|ok(?:ay)?|great|nice|cool|perfect|awesome)\b[\s!.,?]*$/i;

/** Prompts at least this long are treated as tasks without needing cues. */
const SUBSTANTIAL_PROMPT_LENGTH = 40;

/** Cues that make a short prompt a clear task. */
const TASK_CUE_PATTERN =
  /\b(what|how|why|when|where|who|which|fix|debug|implement|add|remove|refactor|write|create|update|deploy|test|review|explain|find|show|list|summarize|plan|analyze|build|install|configure|migrate|error|bug|crash|failing|broken)\b/i;

// ─── Hint extraction ───────────────────────────────────────────────────────

/** Max characters for a query hint. */
const MAX_HINT_LENGTH = 200;

/**
 * Build the search hint for the context lookup. V1 keeps the prompt itself
 * (trimmed, punctuation-lightened, capped) -- it is what the user is asking
 * about. No session state is consulted (ADR-004 gate contract).
 */
function buildQueryHint(prompt: string): string[] {
  const cleaned = prompt
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:please\s+)+/i, '')
    .replace(/[.!?;,]+$/, '');
  if (!cleaned) return [];
  if (cleaned.length <= MAX_HINT_LENGTH) return [cleaned];
  return [cleaned.slice(0, MAX_HINT_LENGTH).trimEnd()];
}

// ─── Rules ─────────────────────────────────────────────────----------------

interface RuleOutcome {
  result: PromptGateResult;
  /** True when the rules had no clear signal (model escalation candidate). */
  uncertain: boolean;
}

/**
 * Rules-only gate decision. Pure, synchronous, < 50ms. Used directly by the
 * CLI when model escalation is off, and as the fallback for every model path.
 */
export function gatePromptRules(input: PromptGateInput): PromptGateResult {
  return gatePromptRulesDetailed(input).result;
}

function gatePromptRulesDetailed(input: PromptGateInput): RuleOutcome {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const trimmed = prompt.trim();

  // Rule 1: explicit opt-outs always win.
  for (const pattern of OPT_OUT_PATTERNS) {
    if (pattern.test(prompt)) {
      return {
        result: {
          search: false,
          queryHints: [],
          reason: 'explicit opt-out: prompt asks not to use memory',
          source: 'rule',
        },
        uncertain: false,
      };
    }
  }

  // Rule 2: empty or trivially short prompts are not tasks.
  if (trimmed.length < 2) {
    return {
      result: {
        search: false,
        queryHints: [],
        reason: 'empty or trivial prompt',
        source: 'rule',
      },
      uncertain: false,
    };
  }

  // Rule 3: greeting-only prompts are not tasks.
  if (GREETING_PATTERN.test(trimmed)) {
    return {
      result: {
        search: false,
        queryHints: [],
        reason: 'greeting or acknowledgment only',
        source: 'rule',
      },
      uncertain: false,
    };
  }

  const hints = buildQueryHint(trimmed);

  // Rule 4: clear task cues or a substantial prompt -> search.
  if (TASK_CUE_PATTERN.test(trimmed) || trimmed.length >= SUBSTANTIAL_PROMPT_LENGTH) {
    return {
      result: {
        search: true,
        queryHints: hints,
        reason: 'task prompt (rule match)',
        source: 'rule',
      },
      uncertain: false,
    };
  }

  // Rule 5: uncertain short prompt -> search anyway (fail open).
  return {
    result: {
      search: true,
      queryHints: hints,
      reason: 'no clear signal; failing open to search',
      source: 'rule',
    },
    uncertain: true,
  };
}

/**
 * Full gate decision. Applies the layer toggles around the rules and the
 * optional model escalation. Never throws; every failure mode ends in a
 * well-formed result.
 */
export async function gatePrompt(
  input: PromptGateInput,
  options?: PromptGateOptions,
): Promise<PromptGateResult> {
  throwIfDecisionAborted(options?.signal);
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const trimmed = prompt.trim();

  // Kill switches: the layer master switch or the gate toggle disabled ->
  // fail open to search (the hook's legacy behavior, now with a topic).
  if (!config.decisionLayerEnabled || !config.promptGateEnabled) {
    return {
      search: true,
      queryHints: buildQueryHint(trimmed),
      reason: 'prompt gate disabled; failing open to search',
      source: 'failopen',
    };
  }

  const rulesOutcome = gatePromptRulesDetailed({ prompt, cwd: input.cwd });
  const rulesResult = rulesOutcome.result;

  // Model escalation only when every flag allows it. Opt-outs, greetings,
  // and clearly-cued tasks never pay for a model call.
  const escalationAllowed =
    config.decisionLayerEnabled &&
    config.promptGateModelEscalation &&
    rulesOutcome.uncertain;
  if (!escalationAllowed) return rulesResult;

  const client = options?.client ?? getDecisionRunner();

  // Phase B7 fan-out probe: System One evaluates all questions of one
  // request in a single parallel pass, so a runner that exposes the fan-out
  // method asks search (noul) AND hint domain (choice) together -- one
  // round trip, two decisions on the same state. Clients without it (the
  // LLM backend, rules-only) keep the single-question call unchanged.
  let modelDecision: ModelGate | null = null;
  let hintDomain: string | null = null;
  if (typeof client.gateWithHintDomainModelOnly === 'function') {
    const fanout = await client.gateWithHintDomainModelOnly(trimmed, { signal: options?.signal });
    modelDecision = fanout?.gate ?? null;
    hintDomain = fanout?.hintDomain?.domain ?? null;
  } else {
    modelDecision = await client.gatePromptModelOnly(trimmed, { signal: options?.signal });
  }
  if (!modelDecision) return rulesResult;

  if (!modelDecision.search && modelDecision.queryHints.length === 0) {
    return {
      search: false,
      queryHints: [],
      reason: 'decision model: no relevant memory context for this prompt',
      source: 'model',
    };
  }

  const hints =
    modelDecision.queryHints.length > 0 ? modelDecision.queryHints : rulesResult.queryHints;
  // The domain answer only ever APPENDS a secondary hint (search=true
  // branch): queryHints[0] stays the rule-derived hint the --exec context
  // spawn uses, so fan-out can enrich the signal without changing delivery.
  const queryHints = hintDomain && !hints.includes(hintDomain) ? [...hints, hintDomain] : hints;

  return {
    search: modelDecision.search,
    queryHints,
    reason: 'decision model verdict',
    source: 'model',
  };
}
