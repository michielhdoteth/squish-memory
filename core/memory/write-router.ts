/**
 * Write routing - one rule set for both write surfaces.
 *
 * History: the MCP `squish_remember` handler and the CLI `squish remember`
 * command each carried their own copy of the content-pattern router, and the
 * copies had already drifted (FIXME/XXX lived in the hack pattern on one side
 * only, the task branch gated differently, note detection was ungated on the
 * CLI). Both surfaces now call this module, so one input gets one routing.
 *
 * The MCP rule set is the one kept: it is the later, narrower evolution - the
 * task branch requires BOTH a fact suggestion and task-ish content, and note
 * detection requires an observation suggestion, so weak signals stop
 * mis-routing memories.
 */

export type WriteRouting = 'memory' | 'learning' | 'note';

export interface WriteRoutingSignals {
  /** Type proposed by the trigger detector, when one exists. */
  suggestedType?: string | null;
}

export interface WriteRoutingResult {
  routing: WriteRouting;
  routingReason: string;
}

/** Lesson-shaped prose: retrospectives, post-mortems, root-cause writeups. */
export const LESSON_PATTERN =
  /(\bfailed\s+because\b|\blesson\s+learned\b|\bnext\s+time\b|\broot\s+cause\b|\bsuccess\b.*\bbecause\b|\bi\s+learned\b|\binsight\b)/i;

/** Explicit learning vocabulary, independent of lesson prose. */
export const LEARNING_TYPE_PATTERN = /(\bsuccess\b|\bfailure\b|\bfix\b|\binsight\b)/i;

/** Code-hygiene markers that belong in the learning store. */
export const CODE_PATTERN = /(\bHACK\b|\bworkaround\b|\btemporary\s+fix\b)/i;

/** Defect markers, including the "bug ... fix" phrasing. */
export const FIXME_PATTERN = /(\bFIXME\b|\bXXX\b|\bbug\b.*\bfix\b)/i;

const TASK_CONTENT_PATTERN = /\b(TODO|FIXME|HACK|fix|task)\b/i;
const NOTE_CONTENT_PATTERN = /\b(note|note\s+that|log|remember)\b/i;

/** Route a write from its content and detector signals. */
export function detectWriteRouting(
  content: string,
  signals: WriteRoutingSignals = {},
): WriteRoutingResult {
  const suggestedType = signals.suggestedType ?? null;
  const hasHackPattern = CODE_PATTERN.test(content);
  const hasFixmePattern = FIXME_PATTERN.test(content);

  if (
    LESSON_PATTERN.test(content) ||
    LEARNING_TYPE_PATTERN.test(content) ||
    hasHackPattern ||
    hasFixmePattern
  ) {
    return {
      routing: 'learning',
      routingReason:
        hasHackPattern || hasFixmePattern
          ? 'Detected code pattern (HACK/FIXME)'
          : 'Detected learning pattern in content',
    };
  }
  if (suggestedType === 'fact' && TASK_CONTENT_PATTERN.test(content)) {
    return { routing: 'memory', routingReason: 'Detected TODO pattern' };
  }
  if (suggestedType === 'observation' && NOTE_CONTENT_PATTERN.test(content)) {
    return { routing: 'note', routingReason: 'Detected note pattern' };
  }
  return { routing: 'memory', routingReason: `Detected as ${suggestedType ?? 'memory'}` };
}
