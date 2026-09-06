import { Router } from 'express';
import {
  DISCLAIMER,
  type NotificationRecord,
  type NotificationStatus,
  type RiskLevel,
} from '@bg/shared';
import type { NotificationService } from '../../domain/notification/NotificationService';
import type { PatientRepository } from '../../domain/ports/PatientRepository';
import { calculateRiskScore, toRiskInput } from '../../domain/risk/riskCalculator';
import { NotFoundError, PatientNotFoundError, ValidationError } from '../../lib/errors';
import { validate, validatedBody, validatedParams, validatedQuery } from '../middleware/validate';
import {
  notificationIdParamSchema,
  notificationListQuerySchema,
  notificationStatsQuerySchema,
  notificationTestSendSchema,
  type NotificationIdParam,
  type NotificationListQueryInput,
  type NotificationStatsQueryInput,
  type NotificationTestSendInput,
} from '../schemas/notificationSchemas';

/**
 * The job id recorded against a hand-triggered send.
 *
 * Manual tests are deliberately filed under their own id rather than the current run's. A run's notification
 * statistics are evidence about that run, and letting a demo button press land in them would mean the sent count
 * no longer described what the backfill did. Filed this way they are still visible in the unfiltered list — with
 * a `MANUAL_TEST` reason — but they cannot inflate a per-job figure.
 */
const MANUAL_JOB_ID = 'MANUAL-TEST';

export interface NotificationRoutesDeps {
  notifications: NotificationService;
  repository: PatientRepository;
}

/**
 * Risk notification read endpoints, plus the dashboard's test action.
 *
 * ## Why there is no endpoint that sends a real alert
 *
 * The only paths that produce a genuine risk alert are inside the backfill: a HIGH result committed under a
 * version guard. That is not reachable over HTTP by design. If a client could ask for an alert to be sent, the
 * claim this feature exists to demonstrate — that alerts fire only on version-checked data — would no longer be
 * enforced by the code, only asserted by it.
 *
 * `POST /test` is therefore explicitly a *test* send: it is recorded with a `MANUAL_TEST` reason, filed under a
 * separate job id, and it reports the patient's live recomputed risk rather than inventing a HIGH score.
 */
export function createNotificationRouter({
  notifications,
  repository,
}: NotificationRoutesDeps): Router {
  const router = Router();

  /**
   * The notification list, newest first.
   *
   * `/stats` is registered before the `/:id` route below, because otherwise Express would match `stats` as an id
   * and the coercion would reject it as a 400.
   */
  router.get(
    '/',
    validate({ query: notificationListQuerySchema }),
    async (req, res, next) => {
      try {
        const query = validatedQuery<
          typeof notificationListQuerySchema
        >(req) as NotificationListQueryInput;

        const records = await notifications.list({
          limit: query.limit,
          ...(query.status ? { status: query.status as NotificationStatus } : {}),
          ...(query.riskLevel ? { riskLevel: query.riskLevel as RiskLevel } : {}),
          ...(query.patientCode ? { patientCode: query.patientCode } : {}),
          ...(query.jobId ? { jobId: query.jobId } : {}),
        });

        res.json({
          notifications: records,
          provider: {
            name: notifications.providerName,
            /**
             * Reported on every response, not buried in documentation.
             *
             * A viewer looking at a list of "sent" messages should be told, in the same payload, that nothing
             * left the machine. A simulated provider that presented itself identically to a real one would be
             * indistinguishable from a real integration that was quietly broken.
             */
            simulated: notifications.providerIsSimulated,
          },
          disclaimer: DISCLAIMER.RISK_SCORE,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/stats',
    validate({ query: notificationStatsQuerySchema }),
    async (req, res, next) => {
      try {
        const query = validatedQuery<
          typeof notificationStatsQuerySchema
        >(req) as NotificationStatsQueryInput;

        const stats = await notifications.stats(query.jobId);

        res.json({
          ...stats,
          provider: {
            name: notifications.providerName,
            simulated: notifications.providerIsSimulated,
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * Sends a test alert by hand.
   *
   * The risk figures come from recomputing the patient's *current* clinical values, not from a fixed placeholder.
   * That keeps the message honest: it reports what the record actually says right now, and a LOW patient produces
   * a LOW test message rather than a fabricated emergency.
   *
   * It goes through the same `dispatch` path as a real alert, so the button exercises production code rather than
   * a parallel implementation that could drift away from it.
   */
  router.post(
    '/test',
    validate({ body: notificationTestSendSchema }),
    async (req, res, next) => {
      try {
        const body = validatedBody<
          typeof notificationTestSendSchema
        >(req) as NotificationTestSendInput;

        const patient = body.patientCode
          ? await repository.findByCode(body.patientCode)
          : await firstPatient(repository);

        if (!patient) {
          if (body.patientCode) throw new PatientNotFoundError(body.patientCode);
          throw new ValidationError(
            'There are no patients to send a test notification about. Seed the dataset first.',
          );
        }

        const risk = calculateRiskScore(toRiskInput(patient));

        const record = await notifications.sendManual({
          jobId: MANUAL_JOB_ID,
          patientId: patient.id,
          patientCode: patient.patientCode,
          partitionIndex: patient.partitionIndex,
          patientVersion: patient.version,
          riskScore: risk.score,
          riskLevel: risk.level,
        });

        if (!record) {
          // The service reports its own failures as events and returns null rather than throwing, so a broken
          // notification path cannot fail a backfill. Here there is no backfill to protect, so say so plainly.
          throw new ValidationError(
            'The test notification could not be recorded. Check the server events for the reason.',
          );
        }

        res.status(201).json({
          notification: record,
          provider: {
            name: notifications.providerName,
            simulated: notifications.providerIsSimulated,
          },
          disclaimer: DISCLAIMER.RISK_SCORE,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  /** One notification, including its full rendered message body. */
  router.get(
    '/:id',
    validate({ params: notificationIdParamSchema }),
    async (req, res, next) => {
      try {
        const { id } = validatedParams<
          typeof notificationIdParamSchema
        >(req) as NotificationIdParam;

        const record: NotificationRecord | null = await notifications.findById(id);
        if (!record) throw new NotFoundError(`No notification with id ${id}.`);

        res.json({
          notification: record,
          provider: {
            name: notifications.providerName,
            simulated: notifications.providerIsSimulated,
          },
          disclaimer: DISCLAIMER.RISK_SCORE,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

/** The lowest patient id, so an unqualified test send is deterministic rather than arbitrary. */
async function firstPatient(repository: PatientRepository) {
  const ids = await repository.allIds();
  const first = ids[0];
  return first === undefined ? null : repository.findById(first);
}
