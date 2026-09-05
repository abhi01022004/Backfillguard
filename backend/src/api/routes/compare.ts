import { Router } from 'express';
import { z } from 'zod';
import type { ComparisonResult } from '@bg/shared';
import { ComparisonHarness } from '../../domain/compare/ComparisonHarness';
import {
  FAILURE_SCENARIO,
  UNCONTENDED_SCENARIO,
} from '../../domain/scenario/failureScenario';
import type { Clock } from '../../lib/clock';
import { NotFoundError } from '../../lib/errors';
import { validate } from '../middleware/validate';

export interface CompareRoutesDeps {
  clock: Clock;
}

const runBodySchema = z
  .strictObject({
    /**
     * Which scenario to run.
     *
     * `contended` is the demonstration. `control` runs the same crash and recovery with no updates during
     * the outage, where both engines must agree — useful when someone reasonably asks whether the naive
     * engine was simply written to fail.
     */
    scenario: z.enum(['contended', 'control']).default('contended'),
  })
  .optional();

type RunBody = z.infer<typeof runBodySchema>;

/**
 * Naive versus guarded comparison (R12.5).
 *
 * Every run happens entirely in memory on freshly generated datasets, so the naive engine has no path to
 * the SQLite demo data. That isolation is why this endpoint is safe to hit at any time, including while a
 * real backfill is in progress.
 */
export function createCompareRouter({ clock }: CompareRoutesDeps): Router {
  const router = Router();
  const harness = new ComparisonHarness({ nowIso: () => clock.nowIso() });

  let latest: ComparisonResult | null = null;

  router.post('/run', validate({ body: runBodySchema }), async (req, res, next) => {
    try {
      const body = (req.validated.body ?? {}) as RunBody;
      const scenario =
        body?.scenario === 'control' ? UNCONTENDED_SCENARIO : FAILURE_SCENARIO;

      const result = await harness.run(scenario);
      latest = result;

      res.json({
        ...result,
        scenarioDescription: scenario.description,
        /**
         * The one-line summary the comparison view leads with. Derived from the run rather than written
         * as copy, so it cannot claim something the numbers do not show (R12.6).
         */
        headline: {
          naive: result.naive.metrics.staleOverwrites > 0
            ? 'STALE OVERWRITE DETECTED'
            : 'no stale overwrite',
          guarded: result.guarded.metrics.staleOverwrites === 0
            ? 'STALE OVERWRITE PREVENTED'
            : 'STALE OVERWRITE OCCURRED',
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/latest', async (_req, res, next) => {
    try {
      if (!latest) {
        throw new NotFoundError(
          'No comparison has been run yet. POST /api/compare/run to run one.',
        );
      }
      res.json(latest);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
