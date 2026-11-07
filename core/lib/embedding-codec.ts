/**
 * Embedding codec - Float32 little-endian BLOB storage for embeddings.
 *
 * Batch 4: embeddings move from JSON text (embedding_json) to a compact BLOB
 * (embedding_blob) as the primary storage format. JSON remains written for
 * compat during the migration window; readers prefer the blob and fall back
 * to JSON (then the legacy `embedding` column) for un-migrated rows.
 *
 * Storage invariant: vectors are L2-normalized at write time, so cosine
 * similarity == dot product. The full-corpus scan relies on this to skip
 * norm computation entirely.
 */

import { normalizeVector } from '../utils/vector-operations.js';

/** Little-endian float32 byte length of an N-dim vector. */
export function embeddingByteLength(dim: number): number {
  return dim * 4;
}

/**
 * Encode a vector as a little-endian float32 BLOB.
 * L2-normalizes first so dot == cosine downstream.
 * Returns null for null/empty/zero input (nothing useful to store).
 */
export function encodeEmbeddingBlob(vector: number[] | Float32Array | null | undefined): Buffer | null {
  if (!vector || vector.length === 0) return null;

  // Reject non-finite elements: normalizeVector alone would map them through
  // and produce an all-zero vector where the old codec returned null.
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) return null;
  }
  const normalized = normalizeVector(Array.from(vector) as number[]);
  if (!normalized) return null;

  const buf = Buffer.allocUnsafe(embeddingByteLength(normalized.length));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < normalized.length; i++) {
    view.setFloat32(i * 4, normalized[i], true);
  }
  return buf;
}

/**
 * Decode a stored BLOB back into a Float32Array.
 *
 * Accepts Buffer / Uint8Array as returned by better-sqlite3 (and drizzle).
 * Returns null for anything that is not a well-formed float32 payload
 * (wrong byte length, empty, non-finite values). Never throws.
 */
export function decodeEmbeddingBlob(data: unknown): Float32Array | null {
  if (!data) return null;

  let bytes: Uint8Array;
  if (Buffer.isBuffer(data)) {
    bytes = data;
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    return null;
  }

  const rem = bytes.byteLength % 4;
  const usable = bytes.byteLength - rem;
  if (usable < 4) return null;

  // Fast path: buffer is 4-byte aligned within its ArrayBuffer, and every
  // runtime we support is little-endian (verified once below). Otherwise
  // fall back to an explicit DataView read which handles any offset and
  // guarantees little-endian semantics per spec. Every element is validated:
  // a single NaN/Inf anywhere would poison dot products downstream.
  if (LITTLE_ENDIAN_HOST && bytes.byteOffset % 4 === 0 && usable === bytes.byteLength) {
    try {
      const out = new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        usable / 4,
      );
      return allFinite(out) ? out : null;
    } catch {
      // RangeError on exotic views - fall through to DataView path
    }
  }
  return slowDecode(bytes, usable);
}

/** Cheap full-array finite check (rejects NaN/Inf in ANY element). */
function allFinite(vec: Float32Array): boolean {
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) return false;
  }
  return true;
}

function slowDecode(bytes: Uint8Array, usable: number): Float32Array | null {
  const out = new Float32Array(usable / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) return null;
    out[i] = v;
  }
  return out;
}

const LITTLE_ENDIAN_HOST: boolean = (() => {
  try {
    return new Uint8Array(new Float32Array([1]).buffer)[0] === 1;
  } catch {
    return false;
  }
})();

/**
 * Normalize a plain array to unit length (returns a NEW array; never mutates
 * the input). Zero vectors are returned unchanged (all zeros) rather than
 * null so callers keep dimension information.
 */
export function normalizeForStorage(vector: number[]): number[] {
  if (!vector || vector.length === 0) return vector;
  const normalized = normalizeVector(vector);
  return normalized ?? vector;
}
