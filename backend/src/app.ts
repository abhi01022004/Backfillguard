import express, { type Express } from 'express';
import cors from 'cors';
import { env } from './config/env';
import { requestLogger } from './api/middleware/requestLogger';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler';
import { createHealthRouter, type HealthDeps } from './api/routes/health';

export interface AppDeps {
  health?: HealthDeps;
}

/**
 * Builds the Express app.
 *
 * Kept separate from `index.ts` (the composition root) so tests can construct an app with stub
 * dependencies and no listening socket.
 */
export function createApp(deps: AppDeps = {}): Express {
  const app = express();

  // Behind a proxy the request logger should see the real client address.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // CORS is restricted to the configured frontend origin rather than '*' (R22.8).
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: false,
      methods: ['GET', 'POST'],
    }),
  );

  // Bounded body size, so the API cannot be handed an arbitrarily large payload (R22.8).
  app.use(express.json({ limit: env.BODY_LIMIT }));

  app.use(requestLogger);

  app.use('/api/health', createHealthRouter(deps.health));

  // Unmatched routes and all thrown errors funnel into the standard envelope (R1.6, R23.2).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
