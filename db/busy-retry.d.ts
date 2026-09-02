/**
 * SQLite busy/locked retry helper.
 *
 * Under concurrent access (multiple agent processes sharing one SQLite file)
 * writes can fail transiently with SQLITE_BUSY / SQLITE_LOCKED even with
 * WAL mode and a busy_timeout configured. This helper wraps write operations
 * with a bounded retry using short exponential backoff.
 *
 * Only busy-class errors are retried; everything else propagates immediately.
 */
export interface BusyRetryOptions {
    /** Number of retries after the initial attempt. Default: 3 */
    maxRetries?: number;
    /** Base backoff delay in ms (doubled each retry). Default: 50 */
    baseDelayMs?: number;
    /** Human-readable label for log lines. */
    label?: string;
}
export declare function isSqliteBusyError(error: unknown): boolean;
export declare function withBusyRetry<T>(operation: () => Promise<T>, options?: BusyRetryOptions): Promise<T>;
//# sourceMappingURL=busy-retry.d.ts.map