import { Router } from 'express';
import { z } from 'zod';
import {
  ACTOR_TYPE,
  CLINICAL_BOUNDS,
  DIAGNOSIS,
  type ActorType,
  type Diagnosis,
} from '@bg/shared';
import type { ClinicalChanges } from '../../domain/online/clinicalMutations';
import type { OnlineUpdateSimulator } from '../../domain/online/OnlineUpdateSimulator';
import type { SimulationOrchestrator } from '../../domain/orchestrator/SimulationOrchestrator';
import type { PatientRepository } from '../../domain/ports/PatientRepository';
import { validate } from '../middleware/validate';

export interface OnlineUpdateRoutesDeps {
  simulator: OnlineUpdateSimulator;
  orchestrator: SimulationOrchestrator;
  repository: PatientRepository;
}

/**
 * Request schema for a manual clinical update (R6.5, R22.4, R22.5).
 *
 * The `changes` object lists exactly the five clinical fields and nothing else, so `riskScore`,
 * `riskLevel`, `version` and `lastBackfillVersion` are unreachable from a client request by
 * construction — not merely filtered out later. Bounds are duplicated from the shared config here for
 * an early, specific 400; the domain re-checks them, and that check is the authoritative one.
 *
 * `changes` is optional: omitting it asks the simulator to generate a realistic escalation, which is
 * what the one-click UI buttons use.
 */
const changesSchema = z
  .strictObject({
    bloodPressureSystolic: z.coerce
      .number()
      .int()
      .min(CLINICAL_BOUNDS.bloodPressureSystolic.min)
      .max(CLINICAL_BOUNDS.bloodPressureSystolic.max)
      .optional(),
    bloodPressureDiastolic: z.coerce
      .number()
      .int()
      .min(CLINICAL_BOUNDS.bloodPressureDiastolic.min)
      .max(CLINICAL_BOUNDS.bloodPressureDiastolic.max)
      .optional(),
    heartRate: z.coerce
      .number()
      .int()
      .min(CLINICAL_BOUNDS.heartRate.min)
      .max(CLINICAL_BOUNDS.heartRate.max)
      .optional(),
    glucose: z.coerce
      .number()
      .int()
      .min(CLINICAL_BOUNDS.glucose.min)
      .max(CLINICAL_BOUNDS.glucose.max)
      .optional(),
    diagnosis: z.enum(Object.values(DIAGNOSIS) as [string, ...string[]]).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one clinical field to change, or omit "changes" entirely.',
  });

const onlineUpdateSchema = z.strictObject({
  patientCode: z
    .string()
    .regex(/^P\d{4,6}$/, 'Patient code must look like P0001.')
    .optional(),
  actorType: z.enum(Object.values(ACTOR_TYPE) as [string, ...string[]]),
  changes: changesSchema.optional(),
});

type OnlineUpdateBody = z.infer<typeof onlineUpdateSchema>;

export function createOnlineUpdateRouter({
  simulator,
  orchestrator,
  repository,
}: OnlineUpdateRoutesDeps): Router {
  const router = Router();

  router.post('/', validate({ body: onlineUpdateSchema }), async (req, res, next) => {
    try {
      const body = req.validated.body as OnlineUpdateBody;

      /**
       * Hand the engine's in-flight window to the simulator.
       *
       * Without a patient code, a manual update should target a record that is staged but not yet
       * written — that is the only window where it can actually demonstrate the guard working. Picking
       * uniformly at random would usually land on an already-written record and show nothing.
       */
      const inFlightCodes = orchestrator.getEngine()?.inFlightCodes() ?? [];

      /**
       * Narrowing after validation.
       *
       * `z.enum(Object.values(...))` widens its output to `string`, so the literal union has to be
       * restored here. Safe because the schema has already rejected anything outside the enum, and the
       * domain re-validates independently — the cast changes the type, never the check.
       */
      const changes: ClinicalChanges | undefined = body.changes
        ? {
            ...(body.changes.bloodPressureSystolic === undefined
              ? {}
              : { bloodPressureSystolic: body.changes.bloodPressureSystolic }),
            ...(body.changes.bloodPressureDiastolic === undefined
              ? {}
              : { bloodPressureDiastolic: body.changes.bloodPressureDiastolic }),
            ...(body.changes.heartRate === undefined ? {} : { heartRate: body.changes.heartRate }),
            ...(body.changes.glucose === undefined ? {} : { glucose: body.changes.glucose }),
            ...(body.changes.diagnosis === undefined
              ? {}
              : { diagnosis: body.changes.diagnosis as Diagnosis }),
          }
        : undefined;

      const result = await simulator.triggerManual({
        actorType: body.actorType as ActorType,
        ...(body.patientCode ? { patientCode: body.patientCode } : {}),
        ...(changes ? { changes } : {}),
        inFlightCodes,
      });

      if (!result) {
        res.status(200).json({
          applied: false,
          reason:
            'That patient is already at the maximum value for every field this actor can change, ' +
            'so no update was applied.',
        });
        return;
      }

      res.json({
        applied: result.changedFields.length > 0,
        patientCode: result.patient.patientCode,
        actorType: result.actorType,
        changedFields: result.changedFields,
        previousVersion: result.previousVersion,
        newVersion: result.newVersion,
        source: result.source,
        /** True when this update landed on a record the engine had read but not yet written. */
        hitInFlightRecord: inFlightCodes.includes(result.patient.patientCode),
      });
    } catch (error) {
      next(error);
    }
  });

  /** Recent clinical activity, for the live activity panel (R14.3). */
  router.get('/', async (_req, res, next) => {
    try {
      const updates = await repository.listOnlineUpdates();
      res.json({ total: updates.length, updates: updates.slice(-100).reverse() });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
