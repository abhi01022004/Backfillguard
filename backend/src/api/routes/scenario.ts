import { Router } from 'express';
import type { ScenarioManager } from '../../domain/scenario/ScenarioManager';
import type { SimulationOrchestrator } from '../../domain/orchestrator/SimulationOrchestrator';
import { logger } from '../../lib/logger';
import { ScenarioFailedError } from '../../lib/errors';

export interface ScenarioRoutesDeps {
  scenarios: ScenarioManager;
  orchestrator: SimulationOrchestrator;
}

/**
 * The one-click demo (R18.1, R18.6).
 *
 * ## Why start returns immediately
 *
 * The full sequence takes tens of seconds of wall clock — deliberately, so it can be watched. Holding the
 * HTTP request open for its duration would mean a browser or proxy timeout could kill the demo halfway
 * through, and the client would learn nothing until the very end anyway.
 *
 * So this accepts the run and returns the initial step list. Everything that happens afterwards arrives
 * over the live event stream, which is the surface the dashboard is already watching. The run's outcome is
 * not lost on failure either: a scenario that throws emits `SCENARIO_ABORTED` with the reason, so the
 * client sees the failure on the same channel it sees progress.
 */
export function createScenarioRouter({ scenarios, orchestrator }: ScenarioRoutesDeps): Router {
  const router = Router();

  router.post('/demo', async (_req, res, next) => {
    try {
      if (scenarios.isRunning()) {
        throw new ScenarioFailedError(
          'start the demo',
          'a demo run is already in progress. Abort it or wait for it to finish.',
        );
      }

      /**
       * Fire and forget, with the rejection handled here rather than left floating.
       *
       * An unhandled rejection would be logged by the process-level handler as an anonymous failure. This
       * way the log names the scenario, and the client has already been told to watch the event stream.
       */
      void scenarios.run().catch((error: unknown) => {
        logger.error('scripted demo failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      res.status(202).json({
        accepted: true,
        message:
          'Demo started. Progress arrives on the live event stream; the step tracker updates as each ' +
          'step fires.',
        scenario: scenarios.getState(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/abort', async (_req, res, next) => {
    try {
      scenarios.abort();

      res.json({
        aborted: true,
        message:
          'Abort requested. The demo stops at the next record boundary rather than mid-recovery, so ' +
          'the job is left in a state the dashboard can describe.',
        scenario: scenarios.getState(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/state', async (_req, res, next) => {
    try {
      res.json({
        scenario: scenarios.getState(),
        job: await orchestrator.getState(),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
