import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { applySqlitePragmas, disconnectPrisma, getPrismaClient } from '../db/prisma';
import { PrismaPatientRepository } from '../repositories/PrismaPatientRepository';
import { resetSimulation, seedDataset } from './seedRunner';

/**
 * CLI entry point for `npm run db:seed` and `npm run db:reset`.
 *
 * Flags:
 *   --reset            clear job/ledger state and unscore patients, keeping the same dataset
 *   --records <n>      override record count
 *   --partitions <n>   override partition count
 *   --seed <n>         override the generation seed
 */

function numericFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;

  const raw = process.argv[index + 1];
  const value = Number(raw);

  if (!Number.isInteger(value)) {
    throw new Error(`--${name} requires an integer, received "${raw ?? '(missing)'}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  await applySqlitePragmas(prisma);

  const repository = new PrismaPatientRepository(prisma);

  if (process.argv.includes('--reset')) {
    await resetSimulation(repository);
    const total = await repository.countAll();
    logger.info('reset complete', { patientsRetained: total });
    return;
  }

  const result = await seedDataset(repository, {
    totalRecords: numericFlag('records', env.SIM_TOTAL_RECORDS),
    partitionCount: numericFlag('partitions', env.SIM_PARTITION_COUNT),
    seed: numericFlag('seed', env.SIM_SEED),
  });

  const counts = await repository.countByStatus();

  logger.info('seed complete', {
    totalRecords: result.totalRecords,
    partitionCount: result.partitionCount,
    seed: result.seed,
    partitionSizes: result.partitionSizes.join(','),
    statusCounts: counts,
    durationMs: result.durationMs,
  });
}

main()
  .catch((error: unknown) => {
    logger.error('seed failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
