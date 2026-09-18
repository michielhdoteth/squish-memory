/**
 * Error classes for @squish/core-sdk.
 *
 * Extracted from index.ts for maintainability. All error classes share a
 * common `SquishError` base with a machine-readable `code` field.
 */

/**
 * Base error class for all SDK errors.
 */
export class SquishError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'SquishError';
  }
}

/**
 * Thrown when the SDK is not properly configured.
 */
export class ConfigError extends SquishError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFIG_ERROR', cause);
    this.name = 'ConfigError';
  }
}

/**
 * Thrown when a storage operation fails.
 */
export class StorageError extends SquishError {
  constructor(message: string, cause?: Error) {
    super(message, 'STORAGE_ERROR', cause);
    this.name = 'StorageError';
  }
}

/**
 * Thrown when an embedding operation fails.
 */
export class EmbeddingError extends SquishError {
  constructor(message: string, cause?: Error) {
    super(message, 'EMBEDDING_ERROR', cause);
    this.name = 'EmbeddingError';
  }
}

/**
 * Thrown when an LLM operation fails.
 */
export class LLMError extends SquishError {
  constructor(message: string, cause?: Error) {
    super(message, 'LLM_ERROR', cause);
    this.name = 'LLMError';
  }
}

/**
 * Thrown when a resource is not found.
 */
export class NotFoundError extends SquishError {
  constructor(resource: string, id: string) {
    super(`${resource} with id '${id}' not found`, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}
