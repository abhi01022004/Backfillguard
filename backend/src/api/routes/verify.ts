import { Router } from 'express';
import { DISCLAIMER } from '@bg/shared';
import type { SimulationOrchestrator } from '../../domain/orchestrator/SimulationOrchestrator';
import { NotFoundError } from '../../lib/errors';

export interface VerifyRoutesDeps {
  orchestrator: SimulationOrchestrator;
}

/**
 * Verification and report export (R11.8, R20.5).
 */
export function createVerifyRouter({ orchestrator }: VerifyRoutesDeps): Router {
  const router = Router();

  /**
   * Runs the audit.
   *
   * Refused from a running job by the state machine, which returns 409 naming the allowed states. That
   * restriction is deliberate rather than defensive: auditing a moving target would produce numbers
   * describing no particular moment.
   */
  router.post('/', async (_req, res, next) => {
    try {
      const report = await orchestrator.runVerification();
      res.json(report);
    } catch (error) {
      next(error);
    }
  });

  router.get('/latest', async (_req, res, next) => {
    try {
      const report = orchestrator.getLastReport();

      if (!report) {
        // An explicit 404 rather than an empty shell, so the report page can offer to run verification
        // instead of rendering zeros that look like measurements (R20.7).
        throw new NotFoundError(
          'Verification has not been run for this job yet. POST /api/verify to run it.',
        );
      }

      res.json(report);
    } catch (error) {
      next(error);
    }
  });

  /** JSON export: the full metric set and every check result, as a downloadable attachment. */
  router.get('/latest/export.json', async (_req, res, next) => {
    try {
      const report = orchestrator.getLastReport();

      if (!report) {
        throw new NotFoundError('Verification has not been run for this job yet.');
      }

      const filename = `backfillguard-verification-${report.jobId}-${report.verdict}.json`;

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      res.send(
        JSON.stringify(
          {
            ...report,
            disclaimer: DISCLAIMER.LONG,
            generatedBy: 'BackfillGuard verification engine',
          },
          null,
          2,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
