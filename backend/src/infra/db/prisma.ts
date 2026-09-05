import { PrismaClient } from '../../generated/prisma/client';
import { env, isTest } from '../../config/env';
import { logger } from '../../lib/logger';
import type { DatabaseProbeResult } from '../../api/routes/health';

/**
 * Prisma client construction and SQLite tuning.
 *
 * WAL mode and a busy timeout are the mitigation for write contention (design risk #3): the engine
 * writes patient rows and ledger entries while the API serves reads, and in SQLite's default rollback
 * journal mode those readers and the writer block each other, which would surface as intermittent
 * SQLITE_BUSY errors mid-demo.
 */

/**
 * Builds the client with event-based logging.
 *
 * Prisma derives the `$on` event union from the `log` option at the constructor call site, so the
 * client's type must be *inferred* here. Annotating the variable as plain `PrismaClient` erases that
 * generic and collapses `$on`'s parameter to `never` — hence the factory plus `ReturnType` below
 * rather than an explicit annotation.
 */
function buildClient() {
  return new PrismaClient({
    datasourceUrl: env.DATABASE_URL,
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });
}

export type AppPrismaClient = ReturnType<typeof buildClient>;

let client: AppPrismaClient | null = null;

export function getPrismaClient(): AppPrismaClient {
  if (client) return client;

  client = buildClient();

  // Route database diagnostics through our own logger instead of Prisma's raw stdout output.
  client.$on('warn', (event) => {
    if (!isTest) logger.warn(`prisma: ${event.message}`);
  });
  client.$on('error', (event) => {
    if (!isTest) logger.error(`prisma: ${event.message}`);
  });

  return client;
}

/**
 * Applies SQLite pragmas.
 *
 * - `journal_mode=WAL` lets readers proceed during a write, which matters because the dashboard polls
 *   while the backfill is writing.
 * - `busy_timeout` makes a blocked statement wait rather than fail immediately.
 * - `synchronous=NORMAL` is a deliberate durability-for-speed trade, safe here because the entire
 *   dataset is regenerable from a seed.
 * - `foreign_keys=ON` is required for the schema's cascade deletes to actually cascade; SQLite
 *   disables foreign keys by default, so without this the reset path would leave orphaned rows.
 */
export async function applySqlitePragmas(prisma: PrismaClient): Promise<void> {
  // `$queryRawUnsafe`, not `$executeRawUnsafe`: several pragmas return a row reporting the value they
  // set (`journal_mode` returns "wal"), and Prisma rejects a result set from an execute call on
  // SQLite with "Execute returned results, which is not allowed". The query variant handles both
  // returning and non-returning pragmas.
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
  await prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON;');

  // Read back rather than assume: if WAL failed to apply we want that visible in the logs, because
  // the symptom otherwise shows up much later as intermittent SQLITE_BUSY under load.
  const rows = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode;');
  const journalMode = rows[0]?.journal_mode ?? 'unknown';

  if (journalMode.toLowerCase() !== 'wal') {
    logger.warn('sqlite is not in WAL mode; concurrent reads may block during backfill writes', {
      journalMode,
    });
  } else {
    logger.info('sqlite configured', { journalMode });
  }
}

/** Health probe injected into the health route, so that route never imports Prisma (R1.3). */
export function createDatabaseProbe(prisma: PrismaClient) {
  return async function probeDatabase(): Promise<DatabaseProbeResult> {
    try {
      const patientCount = await prisma.patient.count();
      return { connected: true, patientCount };
    } catch (error) {
      logger.error('database probe failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { connected: false, patientCount: null };
    }
  };
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
