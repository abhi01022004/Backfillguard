import { Router } from 'express';
import { z } from 'zod';
import { SIMULATION_BOUNDS } from '@bg/shared';
import type { SimulationOrchestrator } from '../../domain/orchestrator/SimulationOrchestrator';
import type { PatientRepository } from '../../domain/ports/PatientRepository';
import { validate } from '../middleware/validate';

export interface BackfillRoutesDeps {
  orchestrator: SimulationOrchestrator;
  repository: PatientRepository;
}

/**
 * Settings that may be overridden when starting a run.
 *
 * Every bound comes from the shared config, and this is the authoritative check — the client's copy of
 * the same bounds exists only for labels and early feedback (R22.7). Unknown keys are rejected rather
 * than ignored, so a typo in a setting name fails loudly instead of silently running with the default.
 *
 * Notably absent: `partitionCount` and `totalRecords`. Those describe the *dataset*, not the run, so
 * changing them is a reseed rather than a start option; accepting them here would let a run be
 * configured for a shape the data does not have.
 */
const startBodySchema = z
  .strictObject({
    backfillSpeed: z.coerce
      .number()
      .int()
      .min(SIMULATION_BOUNDS.backfillSpeed.min)
      .max(SIMULATION_BOUNDS.backfillSpeed.max)
      .optional(),
    batchSize: z.coerce
      .number()
      .int()
      .min(SIMULATION_BOUNDS.batchSize.min)
      .max(SIMULATION_BOUNDS.batchSize.max)
      .optional(),
    checkpointInterval: z.coerce
      .number()
      .int()
      .min(SIMULATION_BOUNDS.checkpointInterval.min)
      .max(SIMULATION_BOUNDS.checkpointInterval.max)
      .optional(),
    onlineUpdateFrequency: z.coerce
      .number()
      .int()
      .min(SIMULATION_BOUNDS.onlineUpdateFrequency.min)
      .max(SIMULATION_BOUNDS.onlineUpdateFrequency.max)
      .optional(),
    maxReevaluationAttempts: z.coerce
      .number()
      .int()
      .min(SIMULATION_BOUNDS.maxReevaluationAttempts.min)
      .max(SIMULATION_BOUNDS.maxReevaluationAttempts.max)
      .optional(),
  })
  .optional();

type StartBody = z.infer<typeof startBodySchema>;

/**
 * Backfill controls (R17.1).
 *
 * Each control maps to one job-state-machine action. Invoking one from an incompatible state throws
 * `InvalidJobStateError`, which the error handler renders as a 409 naming the current state and the
 * states the action is allowed from — so the UI can explain a disabled control rather than fail on
 * click (R8.7).
 */
export function createBackfillRouter({ orchestrator, repository }: BackfillRoutesDeps): Router {
  const router = Router();

  router.post('/start', validate({ body: startBodySchema }), async (req, res, next) => {
    try {
      const body = (req.validated.body ?? {}) as StartBody;
      await orchestrator.start(body ?? {});
      res.json(await orchestrator.getState());
    } catch (error) {
      next(error);
    }
  });

  router.post('/pause', async (_req, res, next) => {
    try {
      await orchestrator.pause();
      res.json(await orchestrator.getState());
    } catch (error) {
      next(error);
    }
  });

  router.post('/resume', async (_req, res, next) => {
    try {
      await orchestrator.resume();
      res.json(await orchestrator.getState());
    } catch (error) {
      next(error);
    }
  });

  router.get('/state', async (_req, res, next) => {
    try {
      res.json(await orchestrator.getState());
    } catch (error) {
      next(error);
    }
  });

  /**
   * Conflicts for the current job.
   *
   * Served from stored rows rather than an in-memory list, so the count the dashboard shows is the same
   * evidence verification audits (R10.6).
   */
  router.get('/conflicts', async (_req, res, next) => {
    try {
      const state = await orchestrator.getState();
      const conflicts = await repository.listConflicts(state.jobId);
      res.json({
        jobId: state.jobId,
        total: conflicts.length,
        open: conflicts.filter((conflict) => conflict.resolution === 'PENDING').length,
        conflicts,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
