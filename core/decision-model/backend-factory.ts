/**
 * Decision backend factory (Phase B10)
 *
 * Single seam that routes the four production escalation sites (write-type
 * override, contradiction relation veto, query-router route escalation,
 * prompt-gate model escalation) to the backend selected by
 * SQUISH_DECISION_MODEL_BACKEND:
 *
 *   off       -> rules only: every model query returns null immediately.
 *   llm       -> the existing DecisionModelClient (DEFAULT: byte-identical
 *                behavior, all existing tests keep running through it).
 *   systemone -> SystemOneDecisionBackend (TypeSafe wire; provider presets
 *                in systemone-providers.ts).
 *
 * The runner interface is exactly the *ModelOnly contract the sites already
 * consume, so both backends and the rules-only stub are drop-in compatible.
 * Config is read LIVE per call (the backend instances re-resolve their
 * endpoint on each request), so env changes take effect without restart --
 * and tests never construct stale singletons.
 *
 * Egress guard (Phase B5): when systemone is selected and the resolved
 * provider is a hosted surface, a single info log states that decision
 * content (max 2000 chars) leaves the machine. ollaya (default) stays on
 * localhost. Gated/misconfigured providers are surfaced by the backend's own
 * once-per-message warning at first use.
 */

import { config } from '../../config.js';
import { logger } from '../logger.js';
import { decisionModelClient } from './provider.js';
import type { ModelGate } from './prompts.js';
import type { ClassificationDecision, DecisionCallOptions, RelationDecision, RetrievalDecision } from './types.js';
import { throwIfDecisionAborted } from './types.js';
import { SystemOneDecisionBackend } from './systemone-backend.js';
import type { GateDecisionFanOut, WriteDecisionFanOut } from './systemone-backend.js';
import { describeDecisionEgress, resolveSystemOneFromConfig } from './systemone-providers.js';

/**
 * The model-only decision surface every wiring site consumes. Structurally
 * satisfied by DecisionModelClient (its *ModelOnly primitives) and by
 * SystemOneDecisionBackend.
 *
 * Phase B7: the two fan-out members are OPTIONAL. Sites probe for them at
 * runtime (`typeof client.X === 'function'`); only SystemOne implements
 * them because Jev evaluates all questions of one request in parallel, so
 * two decisions on the same state cost a single round trip. The LLM client
 * and the rules-only runner keep their single-question behavior unchanged.
 */
export interface DecisionRunner {
  classifyMemoryTypeModelOnly(text: string, options?: DecisionCallOptions): Promise<ClassificationDecision | null>;
  judgeRelationModelOnly(newContent: string, existingContent: string, options?: DecisionCallOptions): Promise<RelationDecision | null>;
  routeQueryModelOnly(query: string, options?: DecisionCallOptions): Promise<RetrievalDecision | null>;
  gatePromptModelOnly(promptText: string, options?: DecisionCallOptions): Promise<ModelGate | null>;
  /** Write-site fan-out: type choice + discard noul in one call. */
  classifyWithDiscardModelOnly?(text: string, options?: DecisionCallOptions): Promise<WriteDecisionFanOut | null>;
  /** Gate-site fan-out: search noul + hint-domain choice in one call. */
  gateWithHintDomainModelOnly?(promptText: string, options?: DecisionCallOptions): Promise<GateDecisionFanOut | null>;
}

/** backend=off: null everywhere, which means "rules stand" at all sites. */
export const RULES_ONLY_DECISION_RUNNER: DecisionRunner = {
  async classifyMemoryTypeModelOnly(_text, options): Promise<ClassificationDecision | null> {
    throwIfDecisionAborted(options?.signal);
    return null;
  },
  async judgeRelationModelOnly(_newContent, _existingContent, options): Promise<RelationDecision | null> {
    throwIfDecisionAborted(options?.signal);
    return null;
  },
  async routeQueryModelOnly(_query, options): Promise<RetrievalDecision | null> {
    throwIfDecisionAborted(options?.signal);
    return null;
  },
  async gatePromptModelOnly(_promptText, options): Promise<ModelGate | null> {
    throwIfDecisionAborted(options?.signal);
    return null;
  },
};

const announcedDecisionEgress = new Set<string>();

function announceSystemOneEgressOnce(): void {
  try {
    const resolved = resolveSystemOneFromConfig();
    const hostedMessage = describeDecisionEgress(resolved);
    if (hostedMessage) {
      const announcementKey = `hosted:${resolved.preset?.id ?? 'unknown'}:${resolved.endpoint}:${config.decisionHostedEgressEnabled ? 'enabled' : 'disabled'}`;
      if (announcedDecisionEgress.has(announcementKey)) return;
      announcedDecisionEgress.add(announcementKey);
      if (!config.decisionHostedEgressEnabled) {
        logger.info(
          `Hosted decision-model egress is disabled for provider '${resolved.preset?.id ?? 'unknown'}'; no decision content will be sent unless SQUISH_DECISION_HOSTED_EGRESS_ENABLED=true`,
        );
        return;
      }
      logger.info(hostedMessage);
      return;
    }
    if (resolved.preset?.local) {
      const announcementKey = `local:${resolved.preset.id}`;
      if (announcedDecisionEgress.has(announcementKey)) return;
      announcedDecisionEgress.add(announcementKey);
      logger.debug(
        'Decision backend: System One via local provider; requests stay on localhost (no third-party egress)',
      );
      return;
    }
    // Configuration errors are logged once by the backend at first use.
  } catch {
    // The guard must never break the decision path.
  }
}

/**
 * Resolve the configured decision backend. Pure config read; invalid explicit
 * values fail closed to rules-only instead of redirecting to the LLM writer.
 */
export function getDecisionRunner(): DecisionRunner {
  const backend = config.decisionModelBackend;
  if (backend === 'off') return RULES_ONLY_DECISION_RUNNER;
  if (backend === 'systemone') {
    announceSystemOneEgressOnce();
    return new SystemOneDecisionBackend();
  }
  return decisionModelClient;
}

/** Test seam: reset the once-per-process egress announcement flag. */
export function resetDecisionEgressAnnouncementForTests(): void {
  announcedDecisionEgress.clear();
}
