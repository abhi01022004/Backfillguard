import { SIMULATION_BOUNDS } from '@bg/shared';
import type { PatientRepository } from '../../domain/ports/PatientRepository';
import { logger } from '../../lib/logger';
import { ValidationError } from '../../lib/errors';
import { generatePatients, partitionSizes } from './patientGenerator';

/**
 * Dataset seeding and reset (R2.7, R2.8).
 *
 * Written against the repository port, so the same code seeds SQLite in the app and an in-memory
 * dataset in tests and in the naive comparison.
 */

export interface SeedOptions {
  totalRecords: number;
  partitionCount: number;
  seed: number;
}

export interface SeedResult {
  totalRecords: number;
  partitionCount: number;
  seed: number;
  partitionSizes: number[];
  durationMs: number;
}

/** Validates against the shared bounds, so an out-of-range request is refused server-side (R17.2). */
function assertWithinBounds(options: SeedOptions): void {
  const checks: [keyof typeof SIMULATION_BOUNDS, number][] = [
    ['totalRecords', options.totalRecords],
    ['partitionCount', options.partitionCount],
  ];

  for (const [key, value] of checks) {
    const bound = SIMULATION_BOUNDS[key];
    if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
      throw new ValidationError(
        `${bound.label} must be an integer between ${bound.min} and ${bound.max}, received ${value}.`,
        { field: key, value, min: bound.min, max: bound.max },
      );
    }
  }

  if (options.partitionCount > options.totalRecords) {
    throw new ValidationError(
      `Partition count (${options.partitionCount}) cannot exceed record count ` +
        `(${options.totalRecords}); every partition must hold at least one record.`,
      { partitionCount: options.partitionCount, totalRecords: options.totalRecords },
    );
  }
}

/**
 * Regenerates the dataset from scratch.
 *
 * Also clears all simulation state, because a dataset and the job history describing it must never
 * disagree: leaving old ledger rows behind would make coverage measured against a dataset that no
 * longer exists.
 */
export async function seedDataset(
  repository: PatientRepository,
  options: SeedOptions,
): Promise<SeedResult> {
  assertWithinBounds(options);

  const startedAt = Date.now();

  const patients = generatePatients(options);
  await repository.replaceAll(patients);
  await repository.clearSimulationState();

  const sizes = partitionSizes(options.totalRecords, options.partitionCount);
  const durationMs = Date.now() - startedAt;

  logger.info('dataset seeded', {
    totalRecords: options.totalRecords,
    partitionCount: options.partitionCount,
    seed: options.seed,
    durationMs,
  });

  return {
    totalRecords: options.totalRecords,
    partitionCount: options.partitionCount,
    seed: options.seed,
    partitionSizes: sizes,
    durationMs,
  };
}

/**
 * Returns the existing dataset to an unscored baseline without regenerating it (R2.8).
 *
 * Distinct from seeding: the patients and their clinical values stay exactly as they are, so a demo
 * can be replayed against an identical starting dataset.
 */
export async function resetSimulation(repository: PatientRepository): Promise<void> {
  await repository.clearSimulationState();
  logger.info('simulation state cleared');
}
