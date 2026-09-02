/**
 * Error hierarchy for @squish/sdk.
 *
 * Every failure mode is normalized into one of these classes so consumers
 * can switch on `err.code` instead of parsing transport-specific messages.
 */

/**
 * Base error class for all SDK errors.
 */
export class SquishError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SquishError';
  }
}

/**
 * Network-level failure: connection refused, DNS, timeout, or the response
 * could not be read. `code` is TRANSPORT_ERROR or TIMEOUT_ERROR.
 */
export class SquishTransportError extends SquishError {
  constructor(message: string, code: 'TRANSPORT_ERROR' | 'TIMEOUT_ERROR' = 'TRANSPORT_ERROR', cause?: unknown) {
    super(message, code, cause);
    this.name = 'SquishTransportError';
  }
}

/**
 * The server answered with a non-2xx HTTP status. `code` is `HTTP_<status>`
 * (e.g. HTTP_401 for a bad API key, HTTP_429 for rate limiting).
 */
export class SquishHttpError extends SquishError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message, `HTTP_${status}`);
    this.name = 'SquishHttpError';
  }
}

/**
 * The server answered 2xx but the JSON-RPC envelope carried an error.
 * `code` is `RPC_<jsonrpcCode>` (e.g. RPC_-32601 for unknown method).
 */
export class SquishRpcError extends SquishError {
  constructor(
    message: string,
    public readonly rpcCode: number,
    public readonly data?: unknown,
  ) {
    super(message, `RPC_${rpcCode}`);
    this.name = 'SquishRpcError';
  }
}

/**
 * The tool executed and reported failure (isError: true in the MCP result).
 * The message carries the server-provided error text.
 */
export class SquishToolError extends SquishError {
  constructor(message: string) {
    super(message, 'TOOL_ERROR');
    this.name = 'SquishToolError';
  }
}
