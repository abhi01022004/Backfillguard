import { z } from 'zod';
import {
  BACKFILL_STATUS,
  RISK_LEVEL,
  SIMULATION_BOUNDS,
} from '@bg/shared';

/**
 * Request schemas (R22.4, R22.5).
 *
 * All object schemas are `strictObject`, so an unrecognised key is a 400 rather than silently
 * ignored. In a system whose correctness depends on version discipline, a request carrying a field
 * the server does not understand is a bug worth surfacing loudly.
 *
 * Note what is *not* accepted anywhere: `riskScore`, `riskLevel`, `version` and
 * `lastBackfillVersion`. Those are computed server-side and are structurally unreachable from a
 * client request (R22.6).
 */

const enumFromObject = <T extends Record<string, string>>(source: T) =>
  z.enum(Object.values(source) as [string, ...string[]]);

export const patientListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  status: enumFromObject(BACKFILL_STATUS).optional(),
  riskLevel: enumFromObject(RISK_LEVEL).optional(),
  partitionIndex: z.coerce
    .number()
    .int()
    .min(0)
    .max(SIMULATION_BOUNDS.partitionCount.max - 1)
    .optional(),
  // Bounded so a search term cannot be used to push an unreasonably large LIKE pattern.
  q: z.string().trim().min(1).max(64).optional(),
});

export const patientCodeParamSchema = z.strictObject({
  // Matches the generator's format exactly, which also rejects any attempt at path trickery.
  code: z
    .string()
    .regex(/^P\d{4,6}$/, 'Patient code must look like P0001.'),
});

export const seedRequestSchema = z.strictObject({
  totalRecords: z.coerce
    .number()
    .int()
    .min(SIMULATION_BOUNDS.totalRecords.min)
    .max(SIMULATION_BOUNDS.totalRecords.max)
    .optional(),
  partitionCount: z.coerce
    .number()
    .int()
    .min(SIMULATION_BOUNDS.partitionCount.min)
    .max(SIMULATION_BOUNDS.partitionCount.max)
    .optional(),
  seed: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
});

export const emptyBodySchema = z.strictObject({}).optional();

export type PatientListQuery = z.infer<typeof patientListQuerySchema>;
export type PatientCodeParam = z.infer<typeof patientCodeParamSchema>;
export type SeedRequest = z.infer<typeof seedRequestSchema>;
