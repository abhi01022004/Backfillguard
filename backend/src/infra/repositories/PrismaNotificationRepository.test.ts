import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { BACKFILL_MODE, DEFAULT_SIMULATION_SETTINGS, JOB_STATUS } from '@bg/shared';
import { PrismaClient } from '../../generated/prisma/client';
import { BACKEND_ROOT, DATABASE_DIR, toPrismaFileUrl } from '../../config/databaseUrl';
import { PrismaNotificationRepository } from './PrismaNotificationRepository';
import { runNotificationRepositoryContract } from './notificationContract';

/**
 * Runs the notification contract against real SQLite.
 *
 * This is the run that actually proves duplicate suppression, because here the uniqueness comes from a database
 * index rather than from an array lookup. The in-memory adapter's version of the same assertion is a consistency
 * check on the two implementations; this one is the guarantee.
 *
 * Same throwaway-database approach as the patient contract: a uniquely named file, never the development one, so
 * running the suite cannot destroy a dataset mid-demo.
 */

const databaseFile = join(DATABASE_DIR, `test-notif-${randomBytes(6).toString('hex')}.db`);
const databaseUrl = toPrismaFileUrl(databaseFile);

let prisma: PrismaClient;

function removeDatabaseFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(`${databaseFile}${suffix}`, { force: true });
  }
}

beforeAll(() => {
  mkdirSync(DATABASE_DIR, { recursive: true });

  // `shell: true` is required on Windows, where npx resolves to npx.cmd. All arguments are static literals.
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

runNotificationRepositoryContract({
  name: 'PrismaNotificationRepository (SQLite)',

  create: async () => {
    await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
    await prisma.notification.deleteMany();
    return new PrismaNotificationRepository(prisma);
  },

  /**
   * Creates the job and patient rows the notification's foreign key requires.
   *
   * The schema enforces a real relation to `Patient`, deliberately: an orphaned notification would be an alert
   * about a record that does not exist. So the contract has to establish the patients first, the same way the
   * running system does.
   */
  seed: async (jobId: string, patientIds: number[]) => {
    await prisma.backfillJob.upsert({
      where: { id: jobId },
      create: {
        id: jobId,
        status: JOB_STATUS.RUNNING,
        mode: BACKFILL_MODE.GUARDED,
        seed: 4242,
        settings: JSON.stringify(DEFAULT_SIMULATION_SETTINGS),
        totalRecords: patientIds.length,
        partitionCount: 1,
        eligibleRecords: patientIds.length,
      },
      update: {},
    });

    for (const id of patientIds) {
      await prisma.patient.upsert({
        where: { id },
        create: {
          id,
          patientCode: `P${String(id).padStart(4, '0')}`,
          name: `Contract Patient ${id}`,
          age: 60,
          bloodPressureSystolic: 120,
          bloodPressureDiastolic: 78,
          heartRate: 80,
          glucose: 110,
          diagnosis: 'NONE',
          partitionIndex: 0,
        },
        update: {},
      });
    }
  },
});
