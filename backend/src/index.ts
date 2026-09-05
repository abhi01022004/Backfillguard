import { createApp } from './app';
import { env, APP_VERSION, envSimulationSettings } from './config/env';
import { logger } from './lib/logger';
import { createSystemClock } from './lib/clock';
import { createRng } from './lib/rng';
import {
  applySqlitePragmas,
  createDatabaseProbe,
  disconnectPrisma,
  getPrismaClient,
} from './infra/db/prisma';
import { InMemoryEventSink } from './infra/events/InMemoryEventSink';
import { PrismaPatientRepository } from './infra/repositories/PrismaPatientRepository';
import { PrismaJobRepository } from './infra/repositories/PrismaJobRepository';
import { SimulationOrchestrator } from './domain/orchestrator/SimulationOrchestrator';
import { OnlineUpdateSimulator } from './domain/online/OnlineUpdateSimulator';

/**
 * Composition root.
 *
 * The only place that wires concrete infrastructure to the domain. Everything downstream receives
 * ports, which is what allows the same engines to run against SQLite here and against an in-memory
 * dataset in tests and in the naive comparison.
 */

async function start(): Promise<void> {
  const prisma = getPrismaClient();
  await applySqlitePragmas(prisma);

  const repository = new PrismaPatientRepository(prisma);
  const jobs = new PrismaJobRepository(prisma);

  const clock = createSystemClock();
  const events = new InMemoryEventSink(clock);

  const rng = createRng(env.SIM_SEED);

  const orchestrator = new SimulationOrchestrator({
    patients: repository,
    jobs,
    events,
    clock,
    rng,
    seed: env.SIM_SEED,
    settings: envSimulationSettings,
  });

  /**
   * A forked stream, so the simulator's draws cannot shift the dataset generator's output or vice
   * versa. Without this, changing how many random values one concern consumes would silently alter the
   * other, and "same seed, same run" would stop holding across unrelated code changes.
   */
  const onlineUpdates = new OnlineUpdateSimulator({
    repository,
    events,
    rng: rng.fork('online-updates'),
  });

  onlineUpdates.configureAuto(envSimulationSettings.onlineUpdateFrequency);
  orchestrator.register(onlineUpdates.asTickParticipant());

  const app = createApp({
    repository,
    orchestrator,
    onlineUpdates,
    health: { probeDatabase: createDatabaseProbe(prisma) },
  });

  const patientCount = await repository.countAll();
  if (patientCount === 0) {
    logger.warn('no patients found — run `npm run db:seed` to generate the synthetic dataset');
  }

  const server = app.listen(env.PORT, () => {
    logger.info('BackfillGuard backend listening', {
      port: env.PORT,
      env: env.NODE_ENV,
      version: APP_VERSION,
      corsOrigin: env.CORS_ORIGIN,
      patients: patientCount,
    });
  });

  /** Graceful shutdown so `npm run dev` restarts cleanly and never leaves the port bound. */
  function shutdown(signal: string): void {
    logger.info(`received ${signal}, shutting down`);

    server.close(async (error) => {
      await disconnectPrisma();
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
}

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

start().catch((error: unknown) => {
  logger.error('failed to start backend', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
