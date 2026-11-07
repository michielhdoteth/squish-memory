/**
 * Hash-based duplicate detection filters (Stage 1).
 * Uses SimHash and MinHash for fast approximate matching before semantic analysis.
 */

/**
 * SimHash: Fast fingerprinting for near-duplicate detection.
 * Tokenizes content, weights by frequency, and produces comparable hash fingerprints.
 * Similar documents produce similar hashes with Hamming distance indicating edit distance.
 */
export class SimHashFilter {
  private readonly dimensions = 32; // 32-bit hash

  generateHash(content: string): string {
    if (!content || content.trim().length === 0) {
      return '0'.repeat(16);
    }

    const tokens = content
      .toLowerCase()
      .split(/\W+/)
      .filter((token) => token.length > 0);

    if (tokens.length === 0) {
      return '0'.repeat(16);
    }

    const tokenFreq = new Map<string, number>();
    for (const token of tokens) {
      tokenFreq.set(token, (tokenFreq.get(token) || 0) + 1);
    }

    const hashBits = new Array(this.dimensions).fill(0);

    for (const [token, freq] of tokenFreq.entries()) {
      const tokenHash = this.hashToken(token);
      for (let i = 0; i < this.dimensions; i++) {
        const bitSet = (tokenHash >>> i) & 1;
        hashBits[i] += bitSet === 1 ? freq : -freq;
      }
    }

    let result = 0;
    for (let i = 0; i < this.dimensions; i++) {
      if (hashBits[i] > 0) {
        result |= 1 << i;
      }
    }

    return (result >>> 0).toString(16).padStart(16, '0');
  }

  hammingDistance(hash1: string, hash2: string): number {
    const num1 = BigInt('0x' + hash1);
    const num2 = BigInt('0x' + hash2);
    const xor = num1 ^ num2;
    return this.popcount(xor);
  }

  findCandidates(
    targetHash: string,
    allHashes: Map<string, string>,
    threshold: number
  ): string[] {
    const candidates: string[] = [];

    for (const [memoryId, hash] of allHashes.entries()) {
      const distance = this.hammingDistance(targetHash, hash);
      if (distance <= threshold) {
        candidates.push(memoryId);
      }
    }

    return candidates;
  }

  private hashToken(token: string): number {
    let hash = 2166136261;

    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = (hash * 16777619) & 0xffffffff;
    }

    const high = hash >>> 16;
    const low = hash & 0xffff;
    return (high * 65599 + low) >>> 0;
  }

  private popcount(n: bigint): number {
    let count = 0;
    while (n > 0n) {
      count += Number(n & 1n);
      n = n >> 1n;
    }
    return count;
  }
}

/**
 * MinHash: Estimates Jaccard similarity using character n-grams and multiple hash functions.
 * Keeps minimum hash for each function, resulting in comparable signatures.
 * More effective than SimHash for paraphrases. 128 functions give ~1% error margin.
 */
export class MinHashFilter {
  private readonly numPermutations = 128; // Number of independent hash functions
  private readonly ngramSize = 3; // Character n-gram size

  generateSignature(content: string): number[] {
    if (!content || content.trim().length === 0) {
      return new Array(this.numPermutations).fill(0);
    }

    const ngrams = this.generateNgrams(content.toLowerCase(), this.ngramSize);

    if (ngrams.length === 0) {
      return new Array(this.numPermutations).fill(0);
    }

    const signature = new Array(this.numPermutations).fill(Number.MAX_SAFE_INTEGER);

    for (const ngram of ngrams) {
      for (let i = 0; i < this.numPermutations; i++) {
        const hashValue = this.hashNgramWithSeed(ngram, i);
        signature[i] = Math.min(signature[i], hashValue);
      }
    }

    return signature;
  }

  jaccardSimilarity(sig1: number[], sig2: number[]): number {
    if (sig1.length !== sig2.length) {
      return 0;
    }

    if (sig1.length === 0) {
      return 1;
    }

    let matches = 0;
    for (let i = 0; i < sig1.length; i++) {
      if (sig1[i] === sig2[i]) {
        matches++;
      }
    }

    return matches / sig1.length;
  }

  findCandidates(
    targetSig: number[],
    allSigs: Map<string, number[]>,
    threshold: number
  ): string[] {
    const candidates: string[] = [];

    for (const [memoryId, sig] of allSigs.entries()) {
      const similarity = this.jaccardSimilarity(targetSig, sig);
      if (similarity >= threshold) {
        candidates.push(memoryId);
      }
    }

    return candidates;
  }

  private generateNgrams(content: string, size: number): string[] {
    const ngrams: string[] = [];
    const padded = ' '.repeat(size - 1) + content + ' '.repeat(size - 1);

    for (let i = 0; i <= padded.length - size; i++) {
      ngrams.push(padded.substring(i, i + size));
    }

    return ngrams;
  }

  private hashNgramWithSeed(ngram: string, seed: number): number {
    // Use a seeded FNV-1a hash over the complete n-gram. The former
    // shift/subtract polynomial collapsed many signatures to the same small
    // values, making unrelated documents appear to have perfect similarity.
    let hash = (2166136261 ^ Math.imul(seed + 1, 0x9e3779b9)) >>> 0;

    for (let i = 0; i < ngram.length; i++) {
      hash ^= ngram.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }

    return hash;
  }
}

export interface Stage1CandidatePair {
  memoryId1: string;
  memoryId2: string;
  simhashDistance: number;
  minhashSimilarity: number;
  matched: 'simhash' | 'minhash' | 'both';
}

/**
 * Combine SimHash and MinHash filters using union approach.
 * Candidates pass if they match EITHER filter, casting wider net for stage 2 ranking.
 */
export function findCandidatePairs(
  memories: Map<string, string>,
  allSimhashes: Map<string, string>,
  allMinhashes: Map<string, number[]>,
  options: {
    simhashThreshold?: number;
    minhashThreshold?: number;
  }
): Stage1CandidatePair[] {
  const simhashThreshold = options.simhashThreshold ?? 4;
  const minhashThreshold = options.minhashThreshold ?? 0.7;

  const simhashFilter = new SimHashFilter();
  const minhashFilter = new MinHashFilter();

  const candidatePairs: Stage1CandidatePair[] = [];
  const seen = new Set<string>();

  const memoryIds = Array.from(memories.keys());

  for (let i = 0; i < memoryIds.length; i++) {
    const id1 = memoryIds[i];
    const simhash1 = allSimhashes.get(id1);
    const minhash1 = allMinhashes.get(id1);

    if (!simhash1 || !minhash1) continue;

    for (let j = i + 1; j < memoryIds.length; j++) {
      const id2 = memoryIds[j];
      const simhash2 = allSimhashes.get(id2);
      const minhash2 = allMinhashes.get(id2);

      if (!simhash2 || !minhash2) continue;

      const pairKey = id1 < id2 ? `${id1}:${id2}` : `${id2}:${id1}`;
      if (seen.has(pairKey)) continue;

      const simhashDist = simhashFilter.hammingDistance(simhash1, simhash2);
      const simhashMatch = simhashDist <= simhashThreshold;

      const minhashSim = minhashFilter.jaccardSimilarity(minhash1, minhash2);
      const minhashMatch = minhashSim >= minhashThreshold;

      if (simhashMatch || minhashMatch) {
        seen.add(pairKey);
        candidatePairs.push({
          memoryId1: id1,
          memoryId2: id2,
          simhashDistance: simhashDist,
          minhashSimilarity: minhashSim,
          matched: simhashMatch && minhashMatch ? 'both' : simhashMatch ? 'simhash' : 'minhash',
        });
      }
    }
  }

  return candidatePairs;
}
