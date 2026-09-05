import { env, isProduction } from '../config/env';

/**
 * Minimal structured logger.
 *
 * Deliberately hand-rolled rather than pulling in pino/winston: the project needs levelled,
 * correlated, JSON-in-production logging and nothing more, and this is ~60 lines with zero
 * dependencies (engineering rule: prefer simple code over unnecessary infrastructure).
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[env.LOG_LEVEL];

export interface LogContext {
  /** Correlates a log line back to the request that produced it (R1.6). */
  requestId?: string;
  [key: string]: unknown;
}

const COLORS: Record<Exclude<LogLevel, 'silent'>, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function emit(level: Exclude<LogLevel, 'silent'>, message: string, context?: LogContext): void {
  if (LEVELS[level] < threshold) return;

  const timestamp = new Date().toISOString();

  if (isProduction) {
    // Machine-parseable in production.
    const line = JSON.stringify({ level, timestamp, message, ...context });
    process.stdout.write(`${line}\n`);
    return;
  }

  // Human-readable in development.
  const contextStr =
    context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(
    `${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET} ` +
      `${timestamp.slice(11, 23)} ${message}${contextStr}\n`,
  );
}

export const logger = {
  debug: (message: string, context?: LogContext) => emit('debug', message, context),
  info: (message: string, context?: LogContext) => emit('info', message, context),
  warn: (message: string, context?: LogContext) => emit('warn', message, context),
  error: (message: string, context?: LogContext) => emit('error', message, context),

  /** Returns a logger that stamps every line with the same context, e.g. a requestId. */
  child(bound: LogContext) {
    return {
      debug: (message: string, context?: LogContext) =>
        emit('debug', message, { ...bound, ...context }),
      info: (message: string, context?: LogContext) =>
        emit('info', message, { ...bound, ...context }),
      warn: (message: string, context?: LogContext) =>
        emit('warn', message, { ...bound, ...context }),
      error: (message: string, context?: LogContext) =>
        emit('error', message, { ...bound, ...context }),
    };
  },
};

export type Logger = typeof logger;
