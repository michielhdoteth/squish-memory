export interface MemorySignals {
  explicitTriggers: string[];
  implicit: {
    decision: boolean;
    correction: boolean;
    preference: boolean;
    workflowRule: boolean;
    lesson: boolean;
    // New: Code rationale patterns
    note: boolean;
    important: boolean;
    hack: boolean;
    why: boolean;
    todo: boolean;
    fixme: boolean;
  };
  suggestedType: 'observation' | 'fact' | 'decision' | 'context' | 'preference' | 'note';
  priority: 'normal' | 'high';
  // New: Confidence indicator
  confidence: 'certain' | 'speculative' | 'inferred';
}

const EXPLICIT_TRIGGER_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'remember', regex: /\bremember\b/i },
  { label: 'dont-forget', regex: /\b(?:don'?t\s+forget|do\s+not\s+forget)\b/i },
  { label: 'keep-in-mind', regex: /\bkeep\s+in\s+mind\b/i },
  { label: 'note-that', regex: /\bnote\s+that\b/i },
  { label: 'from-now-on', regex: /\bfrom\s+now\s+on\b/i },
  { label: 'going-forward', regex: /\bgoing\s+forward\b/i },
  { label: 'save-this', regex: /\bsave\s+this\b/i },
  { label: 'log-this', regex: /\blog\s+this\b/i },
  { label: 'important', regex: /\bimportant\s*:/i },
  // New: Rationale comment triggers
  { label: 'NOTE', regex: /NOTE:/i },
  { label: 'IMPORTANT', regex: /IMPORTANT:/i },
  { label: 'HACK', regex: /HACK:/i },
  { label: 'WHY', regex: /WHY:/i },
  { label: 'TODO', regex: /TODO:/i },
  { label: 'FIXME', regex: /FIXME:/i },
  { label: 'XXX', regex: /XXX:/i },
  { label: 'DEPRECATED', regex: /DEPRECATED:/i },
];

export function detectMemorySignals(content: string): MemorySignals {
  const text = content.trim();
  const explicitTriggers = EXPLICIT_TRIGGER_PATTERNS.filter((p) => p.regex.test(text)).map((p) => p.label);

  const implicit = {
    decision:
      /\b(?:decided|choose|chose|going with|picked|selected|final decision)\b/i.test(text) ||
      /\b(?:x over y|option\s+[a-z0-9]+\s+over)\b/i.test(text),
    correction: /\b(?:no,?\s+i\s+meant|actually,?\s+that'?s\s+not|correction:|i\s+meant)\b/i.test(text),
    preference:
      /\b(?:i\s+like|i\s+don'?t\s+like|i\s+hate|my\s+preference\s+is|prefer)\b/i.test(text) ||
      /\b(?:always|never)\b/i.test(text),
    workflowRule: /\b(?:let'?s\s+always\s+do\s+it\s+this\s+way|standard\s+workflow|runbook)\b/i.test(text),
    lesson:
      /\b(?:failed\s+because|lesson\s+learned|next\s+time|do\s+not\s+repeat|root\s+cause)\b/i.test(text),
    // New: Rationale patterns from code comments
    note: /NOTE:/i.test(text),
    important: /IMPORTANT:/i.test(text),
    hack: /HACK:/i.test(text),
    why: /WHY:/i.test(text),
    todo: /TODO:/i.test(text),
    fixme: /FIXME:/i.test(text),
  };

  let suggestedType: MemorySignals['suggestedType'] = 'observation';
  
  // Priority order: decision > preference > lesson > workflowRule > rationale > fact
  if (implicit.decision) suggestedType = 'decision';
  else if (implicit.preference) suggestedType = 'preference';
  else if (implicit.workflowRule || implicit.lesson) suggestedType = 'context';
  else if (implicit.todo) suggestedType = 'fact';
  else if (!implicit.decision && !implicit.preference && /\b(?:is|are|was|were|uses|has|have)\b/i.test(text)) {
    suggestedType = 'fact';
  }
  
  // Override for specific rationale markers
  if (implicit.note || implicit.important) suggestedType = 'note';
  if (implicit.why) suggestedType = 'context';

  // Determine confidence based on signal strength
  let confidence: MemorySignals['confidence'] = 'certain';
  if (implicit.note || implicit.todo) confidence = 'speculative';
  if (implicit.hack || implicit.fixme) confidence = 'certain';  // Known issues are certain

  const priority: MemorySignals['priority'] = 
    explicitTriggers.length > 0 || 
    implicit.correction || 
    implicit.important || 
    implicit.hack || 
    implicit.fixme 
      ? 'high' 
      : 'normal';

  return {
    explicitTriggers,
    implicit,
    suggestedType,
    priority,
    confidence,
  };
}
