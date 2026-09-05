import { createApp } from './app';
import { env, APP_VERSION } from './config/env';
import { logger } from './lib/logger';

/**
 * Composition root.
 *
 * This is the only place that wires concrete dependencies together. Domain modules receive ports;
 * they never reach for infrastructure themselves.
 */

const app = createApp({
  // Database probe is registered here in task 2, once the persistence layer exists.
});

const server = app.listen(env.PORT, () => {
  logger.info(`BackfillGuard backend listening`, {
    port: env.PORT,
    env: env.NODE_ENV,
    version: APP_VERSION,
    corsOrigin: env.CORS_ORIGIN,
  });
});

/** Graceful shutdown so `npm run dev` restarts cleanly and never leaves the port bound. */
function shutdown(signal: string): void {
  logger.info(`received ${signal}, shutting down`);
  server.close((error) => {
    if (error) {
      logger.error('error during shutdown', { error: error.message });
      process.exit(1);
    }
    process.exit(0);
  });

  // Don't hang forever if a connection refuses to close.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Never let a failure disappear silently (R23.3).
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});
