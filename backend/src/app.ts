import express, { type Express } from 'express';
import cors from 'cors';
import { env } from './config/env';
import type { PatientRepository } from './domain/ports/PatientRepository';
import type { SimulationOrchestrator } from './domain/orchestrator/SimulationOrchestrator';
import { requestLogger } from './api/middleware/requestLogger';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler';
import { createHealthRouter, type HealthDeps } from './api/routes/health';
import { createPatientRouter } from './api/routes/patients';
import { createDatasetRouter } from './api/routes/dataset';
import { createBackfillRouter } from './api/routes/backfill';
import { createOnlineUpdateRouter } from './api/routes/onlineUpdate';
import { createCheckpointRouter } from './api/routes/checkpoint';
import { createVerifyRouter } from './api/routes/verify';
import { createCompareRouter } from './api/routes/compare';
import { createEventRouter } from './api/routes/events';
import type { BufferedDbEventSink } from './infra/events/BufferedDbEventSink';
import type { Clock } from './lib/clock';
import type { OnlineUpdateSimulator } from './domain/online/OnlineUpdateSimulator';

export interface AppDeps {
  repository: PatientRepository;
  orchestrator: SimulationOrchestrator;
  onlineUpdates: OnlineUpdateSimulator;
  clock: Clock;
  events: BufferedDbEventSink;
  health?: HealthDeps;
}

/**
 * Builds the Express app.
 *
 * Kept separate from `index.ts` (the composition root) so tests can construct an app over in-memory
 * repositories with no listening socket and no database.
 */
export function createApp(deps: AppDeps): Express {
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
  app.use('/api/patients', createPatientRouter({ repository: deps.repository }));
  app.use(
    '/api/backfill',
    createBackfillRouter({ orchestrator: deps.orchestrator, repository: deps.repository }),
  );
  app.use('/api/checkpoint', createCheckpointRouter({ orchestrator: deps.orchestrator }));
  app.use('/api/verify', createVerifyRouter({ orchestrator: deps.orchestrator }));
  app.use('/api/compare', createCompareRouter({ clock: deps.clock }));
  app.use('/api/events', createEventRouter({ events: deps.events }));
  app.use(
    '/api/online-update',
    createOnlineUpdateRouter({
      simulator: deps.onlineUpdates,
      orchestrator: deps.orchestrator,
      repository: deps.repository,
    }),
  );
  app.use(
    '/api',
    createDatasetRouter({
      repository: deps.repository,
      // Reseeding is refused while a run owns the data (R2.8). Reset is not, by design.
      isJobRunning: () => deps.orchestrator.isDatasetLocked(),
      resetOrchestrator: () => deps.orchestrator.reset(),
    }),
  );

  // Unmatched routes and all thrown errors funnel into the standard envelope (R1.6, R23.2).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
