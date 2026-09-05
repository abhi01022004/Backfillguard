import { Router } from 'express';
import type { SimulationOrchestrator } from '../../domain/orchestrator/SimulationOrchestrator';

export interface CheckpointRoutesDeps {
  orchestrator: SimulationOrchestrator;
}

/**
 * Checkpoint inspection and destruction (R7.4–R7.6).
 */
export function createCheckpointRouter({ orchestrator }: CheckpointRoutesDeps): Router {
  const router = Router();

  router.get('/', async (_req, res, next) => {
    try {
      const checkpoint = await orchestrator.getCheckpoint();

      res.json({
        /** Non-null only while a trusted resume cursor exists. Null once checkpoints are lost. */
        active: checkpoint.active,
        /**
         * The most recent checkpoint whatever its status. Kept so the UI can still display "last known
         * position" after the checkpoints are destroyed — narration only, never used to resume (R7.5).
         */
        lastKnown: checkpoint.lastKnown,
        createdThisRun: checkpoint.created,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Destroys every checkpoint for the current job.
   *
   * Returns 409 when there is nothing to lose, rather than reporting success for a destructive action
   * that did nothing (R7.6). Committed patient data is untouched: only the job's knowledge of its own
   * position is destroyed.
   */
  router.post('/lose', async (_req, res, next) => {
    try {
      await orchestrator.loseCheckpoint();
      const checkpoint = await orchestrator.getCheckpoint();

      res.json({
        lost: true,
        // Null by construction now — a lost checkpoint must never be readable as a cursor (R7.7).
        active: checkpoint.active,
        lastKnown: checkpoint.lastKnown,
        state: await orchestrator.getState(),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
