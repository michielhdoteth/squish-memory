/** Fraction of scorable questions with at least one expected session in the top K. */
export function calculateSessionHitRate(hits: readonly boolean[]): number | null {
  if (hits.length === 0) return null;
  return hits.filter(Boolean).length / hits.length;
}

export interface LoCoMoExcludedQuestion {
  sampleId: string;
  questionIndex: number;
  category: number;
  reason: 'adversarial_category_excluded_by_protocol';
}

export function getAdversarialQuestionExclusions(
  dataset: readonly { sample_id: string; qa: readonly { category: number }[] }[],
): LoCoMoExcludedQuestion[] {
  return dataset.flatMap(persona => persona.qa.flatMap((question, questionIndex) =>
    question.category === 5 ? [{
      sampleId: persona.sample_id,
      questionIndex,
      category: question.category,
      reason: 'adversarial_category_excluded_by_protocol' as const,
    }] : []
  ));
}
