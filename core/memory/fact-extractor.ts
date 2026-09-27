import type { RememberInput } from './memories.js';

export interface ExtractedFact {
  content: string;
  confidence: number;
  entities: string[];
  relation?: string;
}

export interface FactExtractionResult {
  facts: ExtractedFact[];
  summary: string;
  entities: string[];
}

/**
 * Extract facts from conversation text using Claude API
 * 
 * This function returns valid facts or a valid empty extraction, or throws on malformed output.
 * NO FALLBACKS - we need real extraction to reach 90% accuracy.
 */
export async function extractFacts(
  text: string,
  callClaude: (prompt: string, maxTokens: number) => Promise<string>
): Promise<FactExtractionResult> {
  if (!text || text.length < 50) {
    // Too short for meaningful extraction - return as single fact
    return {
      facts: [{ content: text.trim(), confidence: 1.0, entities: [] }],
      summary: text.trim(),
      entities: []
    };
  }

  const prompt = `Extract atomic facts from this conversation. 

Requirements:
- Extract specific, verifiable facts (names, dates, numbers, relationships)
- Each fact should be a standalone statement
- Identify entities (people, organizations, projects, locations)
- Note temporal information and relationships

Return ONLY valid JSON in this exact format:
{"facts":[{"content":"fact statement","confidence":0.95,"entities":["Name"],"relation":"optional"}],"summary":"brief summary","entities":["all","entities"]}

Text to analyze:
${text.substring(0, 4000)}`;

  const response = await callClaude(prompt, 2000);
  
  // Extract JSON - look for the first { and last }
  const startIdx = response.indexOf('{');
  const endIdx = response.lastIndexOf('}');
  
  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    throw new Error(`Fact extraction failed: No valid JSON found in response. Response: ${response.substring(0, 200)}`);
  }
  
  const jsonStr = response.substring(startIdx, endIdx + 1);
  
  let parsed: FactExtractionResult;
  try {
    parsed = JSON.parse(jsonStr) as FactExtractionResult;
  } catch (parseError) {
    throw new Error(`Fact extraction failed: JSON parse error. JSON: ${jsonStr.substring(0, 200)}`);
  }
  
  // Validate facts array exists and has content
  if (!parsed.facts || !Array.isArray(parsed.facts)) {
    throw new Error(`Fact extraction failed: Missing 'facts' array in response. Keys: ${Object.keys(parsed).join(', ')}`);
  }
  
  // Filter and clean facts
  const validFacts = parsed.facts
    .filter((f: any) => f && typeof f.content === 'string' && f.content.trim().length > 10)
    .map((f: any) => ({
      content: f.content.trim(),
      confidence: Math.max(0, Math.min(1, typeof f.confidence === 'number' ? f.confidence : 0.8)),
      entities: Array.isArray(f.entities) ? f.entities.filter((e: any) => typeof e === 'string') : [],
      relation: typeof f.relation === 'string' ? f.relation : undefined
    }));
  
  if (parsed.facts.length > 0 && validFacts.length === 0) {
    throw new Error(`Fact extraction failed: No valid facts after filtering. Original count: ${parsed.facts.length}`);
  }
  
  return {
    facts: validFacts,
    summary: typeof parsed.summary === 'string' && parsed.summary.trim() 
      ? parsed.summary.trim() 
      : text.substring(0, 200),
    entities: Array.isArray(parsed.entities) 
      ? parsed.entities.filter((e: any) => typeof e === 'string')
      : []
  };
}

/**
 * Convert extracted facts to memory inputs
 */
export function factsToMemoryInputs(
  sourceMemory: RememberInput,
  extraction: FactExtractionResult,
  sourceId: string
): RememberInput[] {
  return extraction.facts.map((fact, index) => ({
    content: fact.content,
    type: 'fact' as const,
    metadata: {
      sourceMemoryId: sourceId,
      extractedAt: new Date().toISOString(),
      entities: fact.entities,
      relation: fact.relation,
      confidence: Math.floor(fact.confidence * 100),
      factIndex: index
    },
    tags: [...(sourceMemory.tags || []), 'extracted-fact', ...fact.entities],
    project: sourceMemory.project
  }));
}
