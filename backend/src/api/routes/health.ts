import { Router } from 'express';
import type { HealthResponse } from '@bg/shared';
import { APP_VERSION } from '../../config/env';

/**
 * Result of probing the database. Supplied by the persistence layer rather than imported, so the
 * health route has no knowledge of Prisma and stays trivially testable.
 */
export interface DatabaseProbeResult {
  connected: boolean;
  /** Null when the dataset has not been seeded. */
  patientCount: number | null;
}

export interface HealthDeps {
  /**
   * Omitted until the persistence layer exists (task 2). While absent, the endpoint reports the
   * database as not connected but still returns `ok`, because the API itself is healthy — the two
   * are genuinely separate facts and collapsing them would hide which one is broken.
   */
  probeDatabase?: () => Promise<DatabaseProbeResult>;
}

const startedAt = Date.now();

export function createHealthRouter(deps: HealthDeps = {}): Router {
  const router = Router();

  router.get('/', async (_req, res, next) => {
    try {
      const database: DatabaseProbeResult = deps.probeDatabase
        ? await deps.probeDatabase()
        : { connected: false, patientCount: null };

      const body: HealthResponse = {
        // Degraded only when a configured database is unreachable.
        status: deps.probeDatabase && !database.connected ? 'degraded' : 'ok',
        version: APP_VERSION,
        database,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
      };

      res.json(body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
