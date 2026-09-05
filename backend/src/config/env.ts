import { z } from 'zod';
import {
  DEFAULT_SEED,
  SIMULATION_BOUNDS,
  type SimulationSettings,
} from '@bg/shared';

/**
 * Environment configuration (R1.4).
 *
 * Every value has a safe committed default so the demo runs with no .env file and no secrets.
 * Validation happens once at startup and fails loudly — a misconfigured simulation bound should
 * stop the process, not surface later as a mysteriously wrong run.
 */

/** Coerce+bound a numeric env var using the shared simulation bounds as the single authority. */
function boundedNumber(key: keyof typeof SIMULATION_BOUNDS) {
  const bound = SIMULATION_BOUNDS[key];
  return z.coerce
    .number()
    .int()
    .min(bound.min)
    .max(bound.max)
    .default(bound.default);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1).default('file:./data/backfillguard.db'),

  SIM_SEED: z.coerce.number().int().default(DEFAULT_SEED),
  SIM_TOTAL_RECORDS: boundedNumber('totalRecords'),
  SIM_PARTITION_COUNT: boundedNumber('partitionCount'),
  SIM_BACKFILL_SPEED: boundedNumber('backfillSpeed'),
  SIM_ONLINE_UPDATE_FREQ: boundedNumber('onlineUpdateFrequency'),
  SIM_CHECKPOINT_INTERVAL: boundedNumber('checkpointInterval'),
  SIM_BATCH_SIZE: boundedNumber('batchSize'),
  SIM_MAX_REEVAL_ATTEMPTS: boundedNumber('maxReevaluationAttempts'),

  /** Max JSON body size. Bounded to keep the API from accepting arbitrary payloads (R22.8). */
  BODY_LIMIT: z.string().default('64kb'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}

export const env: Env = loadEnv();

export const APP_VERSION = '1.0.0';

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Simulation defaults assembled from env, used when a job starts without explicit settings. */
export const envSimulationSettings: SimulationSettings = {
  totalRecords: env.SIM_TOTAL_RECORDS,
  partitionCount: env.SIM_PARTITION_COUNT,
  backfillSpeed: env.SIM_BACKFILL_SPEED,
  onlineUpdateFrequency: env.SIM_ONLINE_UPDATE_FREQ,
  checkpointInterval: env.SIM_CHECKPOINT_INTERVAL,
  batchSize: env.SIM_BATCH_SIZE,
  maxReevaluationAttempts: env.SIM_MAX_REEVAL_ATTEMPTS,
};
