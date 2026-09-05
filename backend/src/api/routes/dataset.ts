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
  /** Guards destructive operations while a job owns the data. */
  isJobRunning?: () => boolean;
  /**
   * Clears the orchestrator's in-memory state.
   *
   * Required, not optional: clearing the database alone leaves the previous run's job status and
   * verification report cached in memory, so the dashboard would keep presenting an audited result for a run
   * whose data no longer exists.
   */
  resetOrchestrator: () => Promise<void>;
}

/**
 * Dataset lifecycle: reseed and reset (R2.8, R17.5).
 *
 * Both are destructive, so both refuse to run while a backfill is in progress — regenerating the
 * dataset under a running engine would invalidate its in-flight state and make any coverage claim
 * meaningless.
 */
export function createDatasetRouter({
  repository,
  isJobRunning,
  resetOrchestrator,
}: DatasetRoutesDeps): Router {
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
      // Deliberately not gated by `assertNotRunning`: reset is the escape hatch and must work even from a
      // job wedged mid-run. The orchestrator stops its loop as part of resetting.
      await resetOrchestrator();
      await resetSimulation(repository);

      const patientCount = await repository.countAll();

      res.json({ reset: true, patientCount });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
