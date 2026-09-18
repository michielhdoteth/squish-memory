/** Response Analyzer - Analyze LLM responses for memory references (Echo/Fizzle tracking) */

import { logger } from '../logger.js';

export interface AnalysisResult {
  referencedMemoryIds: string[];
  referenceCount: number;
  hasReferences: boolean;
}

const REFERENCE_PATTERNS = [
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
  /as (?:i |we )?(?:mentioned|noted|remembered|recalled|stored|saved)/gi,
  /(?:based|drawing) on (?:my|our|the) (?:memory|previous|earlier)/gi,
  /(?:i |we )?(?:recall|remember|noted) (?:that |earlier )?/gi,
  /from (?:my|our|the) (?:memory|notes|records)/gi,
];

export function findMemoryRefs(
  responseText: string,
  injectedMemoryIds: string[],
  injectedMemoryContent: Map<string, string>
): AnalysisResult {
  const referencedMemoryIds: string[] = [];
  const responseLower = responseText.toLowerCase();

  for (const memoryId of injectedMemoryIds) {
    if (responseText.includes(memoryId)) {
      referencedMemoryIds.push(memoryId);
      logger.debug(`[ResponseAnalyzer] Direct reference found: ${memoryId}`);
    }
  }

  for (const [memoryId, content] of injectedMemoryContent) {
    if (referencedMemoryIds.includes(memoryId)) continue;

    const contentWords = content.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (contentWords.length < 5) continue;

    let matchCount = 0;
    for (const word of contentWords) {
      if (responseLower.includes(word)) {
        matchCount++;
      }
    }

    const matchRatio = matchCount / contentWords.length;
    if (matchRatio > 0.5) {
      referencedMemoryIds.push(memoryId);
      logger.debug(`[ResponseAnalyzer] Content match (${(matchRatio * 100).toFixed(0)}%): ${memoryId}`);
    }
  }

  for (const pattern of REFERENCE_PATTERNS) {
    const matches = responseText.match(pattern);
    if (matches && matches.length > 0) {
      logger.debug(`[ResponseAnalyzer] Reference pattern found: ${matches.length} matches`);
    }
  }

  const result: AnalysisResult = {
    referencedMemoryIds: [...new Set(referencedMemoryIds)],
    referenceCount: referencedMemoryIds.length,
    hasReferences: referencedMemoryIds.length > 0,
  };

  if (result.hasReferences) {
    logger.info(`[ResponseAnalyzer] Found ${result.referenceCount} memory references`);
  }

  return result;
}

export function hasMemoryRefs(responseText: string): boolean {
  const responseLower = responseText.toLowerCase();
  const quickPatterns = [
    'remember', 'recall', 'mentioned', 'noted', 'earlier',
    'previous', 'as i', 'as we', 'from my', 'from our',
  ];
  return quickPatterns.some(pattern => responseLower.includes(pattern));
}
