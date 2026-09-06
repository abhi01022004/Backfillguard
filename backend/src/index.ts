import { createServer } from 'node:http';
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
import { BufferedDbEventSink } from './infra/events/BufferedDbEventSink';
import { LiveEventBroadcaster } from './infra/events/LiveEventBroadcaster';
import { createLiveServer } from './infra/events/liveServer';
import { PrismaPatientRepository } from './infra/repositories/PrismaPatientRepository';
import { PrismaJobRepository } from './infra/repositories/PrismaJobRepository';
import { PrismaNotificationRepository } from './infra/repositories/PrismaNotificationRepository';
import { NotifyingPatientRepository } from './infra/repositories/NotifyingPatientRepository';
import { NotificationService } from './domain/notification/NotificationService';
import { selectWhatsAppProvider } from './infra/notification/selectWhatsAppProvider';
import { SimulationOrchestrator } from './domain/orchestrator/SimulationOrchestrator';
import { OnlineUpdateSimulator } from './domain/online/OnlineUpdateSimulator';
import { ScenarioManager } from './domain/scenario/ScenarioManager';
import { reseedToBaseline } from './infra/seed/seedRunner';

/**
 * Composition root.
 *
 * The only place that wires concrete infrastructure to the domain. Everything downstream receives ports,
 * which is what lets the same engines run against SQLite here and against in-memory stores in tests and in
 * the naive comparison.
 */

async function start(): Promise<void> {
  const prisma = getPrismaClient();
  await applySqlitePragmas(prisma);

  const basePatients = new PrismaPatientRepository(prisma);
  const jobs = new PrismaJobRepository(prisma);
  const notificationStore = new PrismaNotificationRepository(prisma);

  const clock = createSystemClock();
  const rng = createRng(env.SIM_SEED);

  /**
   * The event sink is assembled as three layers, each with one job:
   *
   *   InMemoryEventSink     assigns gap-free sequence numbers, keeps the recent window
   *   BufferedDbEventSink   batches the durable log so the engine's hot path stays clean
   *   LiveEventBroadcaster  forwards significant events immediately, coalesces the rest
   *
   * The domain only ever sees the outermost one as an `EventSink`, so none of this is visible to the
   * engines. The broadcaster needs the socket server and the socket server needs a state getter, so the
   * layers are stitched together after the orchestrator exists.
   */
  const baseSink = new InMemoryEventSink(clock);
  const persistedSink = new BufferedDbEventSink(baseSink, prisma);

  // Assigned once the orchestrator is constructed; the closures below read it lazily.
  let orchestratorRef: SimulationOrchestrator | null = null;
  const getJobState = async () => (orchestratorRef ? orchestratorRef.getState() : null);

  const httpServer = createServer();
  const io = createLiveServer({ httpServer, events: persistedSink, getJobState });
  const events = new LiveEventBroadcaster(persistedSink, { io, getJobState });

  /**
   * Risk notifications, assembled around the repository rather than inside the engines.
   *
   * `NotifyingPatientRepository` wraps the real store and observes guarded writes. Every safe commit in the system
   * already funnels through `applyGuarded`, so wrapping the port covers the initial pass, conflict re-evaluation
   * and both recovery paths at once — with no change to any engine, and with the naive comparison engine excluded
   * automatically because it writes through the unguarded method instead.
   *
   * Wired only here. Tests and the comparison harness construct plain repositories, so they get no notification
   * behaviour unless they explicitly ask for it.
   */
  const notifications = new NotificationService({
    notifications: notificationStore,
    provider: selectWhatsAppProvider(),
    events,
  });

  const repository = new NotifyingPatientRepository(basePatients, notifications);

  const orchestrator = new SimulationOrchestrator({
    patients: repository,
    jobs,
    events,
    clock,
    rng,
    seed: env.SIM_SEED,
    settings: envSimulationSettings,
  });
  orchestratorRef = orchestrator;

  /**
   * A forked stream, so the simulator's draws cannot shift the dataset generator's output or vice versa.
   * Without this, changing how many random values one concern consumes would silently alter the other, and
   * "same seed, same run" would stop holding across unrelated code changes.
   */
  const onlineUpdates = new OnlineUpdateSimulator({
    repository,
    events,
    rng: rng.fork('online-updates'),
  });

  onlineUpdates.configureAuto(envSimulationSettings.onlineUpdateFrequency);
  orchestrator.register(onlineUpdates.asTickParticipant());

  /**
   * Registered once, for the process's lifetime.
   *
   * Participant registration survives both `start()` and `reset()`, so the manager stays wired across
   * repeated demo runs. Its tick hook is inert unless a demo is actually running.
   */
  const scenarios = new ScenarioManager({
    orchestrator,
    simulator: onlineUpdates,
    repository,
    events,
    clock,
    /**
     * Restores the dataset to its generated baseline before each demo run.
     *
     * Wired here rather than inside the manager because regenerating patients is an infrastructure concern.
     * Without it a repeated demo starts from data the previous run mutated, so it is a different run with the
     * same configuration rather than the same run again — and the demo makes the stronger claim on screen.
     */
    prepareDataset: async () => {
      await reseedToBaseline(repository, env.SIM_SEED);
    },
  });
  orchestrator.register(scenarios);

  const app = createApp({
    repository,
    orchestrator,
    onlineUpdates,
    scenarios,
    clock,
    events: persistedSink,
    notifications,
    health: { probeDatabase: createDatabaseProbe(prisma) },
  });

  // Express handles requests that are not Socket.IO handshakes on the same port.
  httpServer.on('request', app);

  const patientCount = await repository.countAll();
  if (patientCount === 0) {
    logger.warn('no patients found — run `npm run db:seed` to generate the synthetic dataset');
  }

  /**
   * Restore a finished run, so a restart does not make its audit unreachable.
   *
   * Without this the database keeps the job row, every ledger and all the scored patients while the process
   * reports IDLE — and verification, which is only permitted from a settled state, refuses to run against
   * data that is sitting right there.
   */
  const restored = await orchestrator.restore();
  if (restored) {
    logger.info('restored previous run from storage', { status: restored });
  }

  httpServer.listen(env.PORT, () => {
    logger.info('BackfillGuard backend listening', {
      port: env.PORT,
      env: env.NODE_ENV,
      version: APP_VERSION,
      corsOrigin: env.CORS_ORIGIN,
      patients: patientCount,
      livePath: '/live',
    });
  });

  /** Graceful shutdown so `npm run dev` restarts cleanly and never leaves the port bound. */
  function shutdown(signal: string): void {
    logger.info(`received ${signal}, shutting down`);

    void (async () => {
      // Flush any queued events before closing, so the durable log is not left short.
      await persistedSink.flush().catch(() => undefined);
      await io.close();

      httpServer.close(async (error) => {
        await disconnectPrisma();
        if (error) {
          logger.error('error during shutdown', { error: error.message });
          process.exit(1);
        }
        process.exit(0);
      });
    })();

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
