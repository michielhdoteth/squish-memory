/**
 * LLM Query Rewriter - Uses LLM to rewrite queries for better memory retrieval
 *
 * Expands abbreviations, adds synonyms, clarifies intent.
 * Falls back to original query on LLM failure.
 *
 * Enabled via SQUISH_LLM_REWRITE=true
 */
interface LLMClient {
    (prompt: string, options?: {
        maxTokens?: number;
        temperature?: number;
    }): Promise<string | null>;
}
/**
 * Rewrite a query using LLM for better memory retrieval.
 * Falls back to original query on any failure.
 */
export declare function rewriteQuery(query: string, callLLM?: LLMClient): Promise<string>;
/**
 * Check if LLM rewriting is enabled
 */
export declare function isLLMRewriteEnabled(): boolean;
export {};
//# sourceMappingURL=llm-query-rewriter.d.ts.map