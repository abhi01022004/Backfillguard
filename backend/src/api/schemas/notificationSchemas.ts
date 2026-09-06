import { z } from 'zod';
import { NOTIFICATION_STATUS, RISK_LEVEL } from '@bg/shared';

/**
 * Request schemas for the notification endpoints.
 *
 * Same discipline as the patient schemas: every object is `strictObject`, so an unrecognised key is a 400 rather
 * than silently ignored, and nothing server-derived is accepted from a client.
 *
 * Note what cannot be supplied: `status`, `riskScore`, `providerMessageId`, `idempotencyKey` and the timestamps.
 * A notification's status is a consequence of what the database did to the underlying write, so accepting one
 * over HTTP would let a caller assert that an alert had been sent when it had not — which would make the entire
 * feature's central claim unverifiable.
 */

const enumFromObject = <T extends Record<string, string>>(source: T) =>
  z.enum(Object.values(source) as [string, ...string[]]);

export const notificationListQuerySchema = z.strictObject({
  status: enumFromObject(NOTIFICATION_STATUS).optional(),
  riskLevel: enumFromObject(RISK_LEVEL).optional(),
  patientCode: z
    .string()
    .regex(/^P\d{4,6}$/, 'Patient code must look like P0001.')
    .optional(),
  jobId: z.string().trim().min(1).max(64).optional(),
  /**
   * Bounded, and defaulted well below the bound.
   *
   * A full run can produce a few hundred notifications and the panel that reads this renders a scrolling list,
   * so there is no caller that needs everything at once. The cap is what stops the endpoint being an accidental
   * way to load the whole table.
   */
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const notificationIdParamSchema = z.strictObject({
  id: z.coerce.number().int().positive(),
});

export const notificationStatsQuerySchema = z.strictObject({
  jobId: z.string().trim().min(1).max(64).optional(),
});

/**
 * The manual test send.
 *
 * `patientCode` is optional so the dashboard button works with no input. When omitted the server picks the
 * lowest patient id, which is deterministic — deliberately not "a random patient", because a demo action that
 * behaves differently every press is harder to reason about and would violate the project's determinism rules.
 */
export const notificationTestSendSchema = z.strictObject({
  patientCode: z
    .string()
    .regex(/^P\d{4,6}$/, 'Patient code must look like P0001.')
    .optional(),
});

export type NotificationListQueryInput = z.infer<typeof notificationListQuerySchema>;
export type NotificationIdParam = z.infer<typeof notificationIdParamSchema>;
export type NotificationStatsQueryInput = z.infer<typeof notificationStatsQuerySchema>;
export type NotificationTestSendInput = z.infer<typeof notificationTestSendSchema>;
