// LoCoMo dataset types

export interface LocomoQA {
  question: string;
  answer?: string;
  adversarial_answer?: string;
  evidence: string[];
  category: number; // 1=single-hop, 2=temporal, 3=multi-hop, 4=open-domain, 5=adversarial
}

export interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  img_url?: string[];
  blip_caption?: string;
  query?: string;
}

export interface LocomoConversation {
  qa: LocomoQA[];
  conversation: {
    speaker_a: string;
    speaker_b: string;
    session_1_date_time: string;
    [key: string]: any;
  };
}

export interface QuestionResult {
  question: string;
  groundTruth: string;
  predicted: string;
  category: number;
  categoryLabel: string;
  f1Score: number;
  precision: number;
  recall: number;
  correct: boolean;
  retrievalHits: number;
  topKContent: string[];
}

export interface CategoryResult {
  category: number;
  label: string;
  totalQuestions: number;
  averageF1: number;
  accuracy: number;
  correct: number;
  partial: number;
  incorrect: number;
}

export interface BenchmarkResult {
  mode: 'retrieval-only' | 'with-llm';
  model?: string;
  totalQuestions: number;
  overallF1: number;
  categories: CategoryResult[];
  questions: QuestionResult[];
  duration: number;
  timestamp: string;
}

export const CATEGORY_LABELS: Record<number, string> = {
  1: 'single-hop',
  2: 'temporal',
  3: 'multi-hop',
  4: 'open-domain',
  5: 'adversarial',
};
