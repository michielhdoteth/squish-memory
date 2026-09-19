type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogContext {
  [key: string]: any;
  correlationId?: string;
}

interface StructuredLogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: Record<string, any>;
}

class Logger {
  private prefix: string;
  private debugEnabled: boolean;
  private jsonMode: boolean;

  constructor(prefix: string = 'squish') {
    this.prefix = prefix;
    this.debugEnabled = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
    this.jsonMode = process.env.SQUISH_LOG_FORMAT === 'json';
  }

  private format(level: LogLevel, message: string, context?: LogContext): string {
    if (this.jsonMode) {
      const entry: StructuredLogEntry = {
        timestamp: new Date().toISOString(),
        level: level.toUpperCase(),
        message,
        ...(context && Object.keys(context).length > 0 ? { context } : {}),
      };
      return JSON.stringify(entry);
    }

    const ctx = context ? ` ${JSON.stringify(context)}` : '';
    return `[${this.prefix}:${level}] ${message}${ctx}`;
  }

  private isQuiet(): boolean {
    return process.env.SQUISH_QUIET === 'true' || process.env.SQUISH_QUIET === '1';
  }

  info(message: string, context?: LogContext): void {
    if (this.isQuiet()) {
      return;
    }
    console.error(this.format('info', message, context));
  }

  warn(message: string, context?: LogContext): void {
    if (this.isQuiet()) {
      return;
    }
    console.error(this.format('warn', message, context));
  }

  error(message: string, error?: Error | any, context?: LogContext): void {
    if (this.isQuiet()) {
      return;
    }
    const errorMsg = error instanceof Error ? error.message : error;
    const ctx = { ...context, error: errorMsg };
    console.error(this.format('error', message, ctx));
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  }

  debug(message: string, context?: LogContext): void {
    if (this.debugEnabled && !this.isQuiet()) {
      console.error(this.format('debug', message, context));
    }
  }

  child(prefix: string): Logger {
    return new Logger(`${this.prefix}:${prefix}`);
  }

  createRequestLogger(correlationId: string): RequestLogger {
    return new RequestLogger(this, correlationId);
  }
}

class RequestLogger {
  private logger: Logger;
  private correlationId: string;

  constructor(logger: Logger, correlationId: string) {
    this.logger = logger;
    this.correlationId = correlationId;
  }

  private withCorrelationId(context?: LogContext): LogContext {
    return {
      correlationId: this.correlationId,
      ...context,
    };
  }

  info(message: string, context?: LogContext): void {
    this.logger.info(message, this.withCorrelationId(context));
  }

  warn(message: string, context?: LogContext): void {
    this.logger.warn(message, this.withCorrelationId(context));
  }

  error(message: string, error?: Error | any, context?: LogContext): void {
    this.logger.error(message, error, this.withCorrelationId(context));
  }

  debug(message: string, context?: LogContext): void {
    this.logger.debug(message, this.withCorrelationId(context));
  }
}

export const logger = new Logger();
export { RequestLogger };
