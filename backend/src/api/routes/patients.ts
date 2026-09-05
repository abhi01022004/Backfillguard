import { Router } from 'express';
import type { BackfillStatus, Paginated, Patient, RiskLevel } from '@bg/shared';
import type { PatientRepository } from '../../domain/ports/PatientRepository';
import { PatientNotFoundError } from '../../lib/errors';
import { validate, validatedParams, validatedQuery } from '../middleware/validate';
import {
  patientCodeParamSchema,
  patientListQuerySchema,
  type PatientCodeParam,
  type PatientListQuery,
} from '../schemas/patientSchemas';

export interface PatientRoutesDeps {
  repository: PatientRepository;
}

/**
 * Patient read endpoints (R16.1, R16.2).
 *
 * Read-only by design. There is no endpoint to create, delete or directly edit a patient: the only
 * write path into clinical data is the online-update simulator, which enforces the field whitelist
 * and the version guard (R22.5).
 */
export function createPatientRouter({ repository }: PatientRoutesDeps): Router {
  const router = Router();

  router.get(
    '/',
    validate({ query: patientListQuerySchema }),
    async (req, res, next) => {
      try {
        const query = validatedQuery<typeof patientListQuerySchema>(req) as PatientListQuery;

        const page: Paginated<Patient> = await repository.findPage({
          page: query.page,
          pageSize: query.pageSize,
          ...(query.status ? { status: query.status as BackfillStatus } : {}),
          ...(query.riskLevel ? { riskLevel: query.riskLevel as RiskLevel } : {}),
          ...(query.partitionIndex === undefined
            ? {}
            : { partitionIndex: query.partitionIndex }),
          ...(query.q ? { q: query.q } : {}),
        });

        res.json(page);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/:code',
    validate({ params: patientCodeParamSchema }),
    async (req, res, next) => {
      try {
        const { code } = validatedParams<typeof patientCodeParamSchema>(req) as PatientCodeParam;

        const patient = await repository.findByCode(code);
        if (!patient) throw new PatientNotFoundError(code);

        // The risk breakdown and merged history are added in tasks 3 and 17 respectively.
        res.json({ patient });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
