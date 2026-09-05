import { Router } from 'express';
import { JOB_STATUS } from '@bg/shared';
import type { PatientRepository } from '../../domain/ports/PatientRepository';
import { env } from '../../config/env';
import { InvalidJobStateError } from '../../lib/errors';
import { resetSimulation, seedDataset } from '../../infra/seed/seedRunner';
import { validate } from '../middleware/validate';
import { seedRequestSchema, type SeedRequest } from '../schemas/patientSchemas';

export interface DatasetRoutesDeps {
  repository: PatientRepository;
  /**
   * Guards destructive operations while a job is running. Wired to the orchestrator in task 5;
   * until then nothing can be running, so the default permits the operation.
   */
  isJobRunning?: () => boolean;
}

/**
 * Dataset lifecycle: reseed and reset (R2.8, R17.5).
 *
 * Both are destructive, so both refuse to run while a backfill is in progress — regenerating the
 * dataset under a running engine would invalidate its in-flight state and make any coverage claim
 * meaningless.
 */
export function createDatasetRouter({ repository, isJobRunning }: DatasetRoutesDeps): Router {
  const router = Router();

  function assertNotRunning(action: string): void {
    if (isJobRunning?.()) {
      throw new InvalidJobStateError(action, JOB_STATUS.RUNNING, [
        JOB_STATUS.IDLE,
        JOB_STATUS.COMPLETED,
        JOB_STATUS.VERIFIED_SAFE,
        JOB_STATUS.VERIFICATION_FAILED,
        JOB_STATUS.FAILED,
      ]);
    }
  }

  router.post('/seed', validate({ body: seedRequestSchema }), async (req, res, next) => {
    try {
      assertNotRunning('reseed the dataset');

      const body = (req.validated.body ?? {}) as SeedRequest;

      const result = await seedDataset(repository, {
        totalRecords: body.totalRecords ?? env.SIM_TOTAL_RECORDS,
        partitionCount: body.partitionCount ?? env.SIM_PARTITION_COUNT,
        seed: body.seed ?? env.SIM_SEED,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/reset', async (_req, res, next) => {
    try {
      assertNotRunning('reset the simulation');

      await resetSimulation(repository);
      const patientCount = await repository.countAll();

      res.json({ reset: true, patientCount });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
