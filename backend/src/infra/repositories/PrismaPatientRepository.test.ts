import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { BACKFILL_MODE, DEFAULT_SIMULATION_SETTINGS, JOB_STATUS } from '@bg/shared';
import { PrismaClient } from '../../generated/prisma/client';
import { BACKEND_ROOT, DATABASE_DIR, toPrismaFileUrl } from '../../config/databaseUrl';
import { PrismaPatientRepository } from './PrismaPatientRepository';
import { runPatientRepositoryContract } from './repositoryContract';

/**
 * Runs the shared repository contract against real SQLite.
 *
 * The test database is a uniquely-named throwaway file, never the development one, so running the
 * suite can't destroy a dataset mid-demo. The connection string goes through `toPrismaFileUrl` for
 * the reason documented there: the schema engine and the query engine accept different URL forms on
 * Windows, and only that one satisfies both.
 *
 * Schema is created with `prisma db push`, which applies the current schema directly and does not
 * need the migration history.
 */

const databaseFile = join(DATABASE_DIR, `test-${randomBytes(6).toString('hex')}.db`);
const databaseUrl = toPrismaFileUrl(databaseFile);

let prisma: PrismaClient;

function removeDatabaseFiles(): void {
  // WAL mode leaves -wal and -shm sidecars alongside the database.
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(`${databaseFile}${suffix}`, { force: true });
  }
}

beforeAll(() => {
  mkdirSync(DATABASE_DIR, { recursive: true });

  // `shell: true` is required on Windows, where npx resolves to npx.cmd and a direct spawn fails
  // with EINVAL. Every argument here is a static literal, so there is no injection surface.
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--force-reset'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
    shell: true,
  });

  prisma = new PrismaClient({ datasourceUrl: databaseUrl });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  removeDatabaseFiles();
});

runPatientRepositoryContract({
  name: 'PrismaPatientRepository (SQLite)',

  create: async () => {
    // SQLite disables foreign keys by default, and the schema's cascade deletes depend on them.
    // Enabling them here also means the contract exercises referential integrity for real.
    await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
    return new PrismaPatientRepository(prisma);
  },

  ensureJob: async (jobId: string) => {
    await prisma.backfillJob.upsert({
      where: { id: jobId },
      create: {
        id: jobId,
        status: JOB_STATUS.RUNNING,
        mode: BACKFILL_MODE.GUARDED,
        seed: 4242,
        settings: JSON.stringify(DEFAULT_SIMULATION_SETTINGS),
        totalRecords: 30,
        partitionCount: 3,
        eligibleRecords: 30,
      },
      update: {},
    });
  },
});
