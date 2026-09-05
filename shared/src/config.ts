/**
 * Bounded simulation settings (R17.2).
 *
 * These bounds live in `shared` so the exact same limits are enforced by the server and reflected by
 * the client form. The server validates independently of the client (R22.7) — the client copy is for
 * labels and early feedback only, never the enforcement point.
 */

export interface NumericBound {
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly label: string;
  readonly unit?: string;
}

export const SIMULATION_BOUNDS = {
  totalRecords: {
    min: 100,
    max: 5000,
    default: 1000,
    label: 'Number of records',
    unit: 'patients',
  },
  partitionCount: {
    min: 2,
    max: 20,
    default: 10,
    label: 'Number of partitions',
    unit: 'partitions',
  },
  backfillSpeed: {
    min: 1,
    max: 500,
    default: 25,
    label: 'Backfill speed',
    unit: 'records/sec',
  },
  /**
   * Online updates per 100 processed records. Count-based rather than time-based so the scenario
   * stays deterministic regardless of machine speed (design §5).
   */
  onlineUpdateFrequency: {
    min: 0,
    max: 50,
    default: 8,
    label: 'Online update frequency',
    unit: 'per 100 records',
  },
  checkpointInterval: {
    min: 10,
    max: 500,
    default: 50,
    label: 'Checkpoint interval',
    unit: 'records',
  },
  /**
   * In-flight batch size — how many computed results are staged before a flush.
   *
   * Changing this changes which records are staged (and therefore stale) at crash time, which the
   * naive-comparison scenario depends on. The failure-scenario test asserts the comparison still
   * demonstrates a lost update, so the suite fails rather than the live demo (design §11).
   */
  batchSize: {
    min: 1,
    max: 100,
    default: 25,
    label: 'In-flight batch size',
    unit: 'records',
  },
  maxReevaluationAttempts: {
    min: 1,
    max: 10,
    default: 3,
    label: 'Max re-evaluation attempts',
    unit: 'attempts',
  },
} as const satisfies Record<string, NumericBound>;

export type SimulationSettingKey = keyof typeof SIMULATION_BOUNDS;

export interface SimulationSettings {
  totalRecords: number;
  partitionCount: number;
  backfillSpeed: number;
  onlineUpdateFrequency: number;
  checkpointInterval: number;
  batchSize: number;
  maxReevaluationAttempts: number;
}

export const DEFAULT_SIMULATION_SETTINGS: SimulationSettings = {
  totalRecords: SIMULATION_BOUNDS.totalRecords.default,
  partitionCount: SIMULATION_BOUNDS.partitionCount.default,
  backfillSpeed: SIMULATION_BOUNDS.backfillSpeed.default,
  onlineUpdateFrequency: SIMULATION_BOUNDS.onlineUpdateFrequency.default,
  checkpointInterval: SIMULATION_BOUNDS.checkpointInterval.default,
  batchSize: SIMULATION_BOUNDS.batchSize.default,
  maxReevaluationAttempts: SIMULATION_BOUNDS.maxReevaluationAttempts.default,
};

/** Server-side bounds for clinical values accepted by an online update (R22.7). */
export const CLINICAL_BOUNDS = {
  bloodPressureSystolic: { min: 70, max: 250 },
  bloodPressureDiastolic: { min: 40, max: 150 },
  heartRate: { min: 30, max: 200 },
  glucose: { min: 40, max: 500 },
  age: { min: 18, max: 100 },
} as const;

/** Default seed for the deterministic demo. Same seed ⇒ same run (R18.5). */
export const DEFAULT_SEED = 20260905;

export const DEMO_JOB_ID = 'BG-DEMO-001';

/**
 * Mandatory disclaimers (R22.2, R3.7). Centralised so no surface can drift or omit them.
 */
export const DISCLAIMER = {
  /** Persistent banner, shown on every page. */
  DATA: 'Synthetic Hackathon Data — Not for Clinical Use',
  /** Shown wherever a risk score appears. */
  RISK_SCORE: 'Synthetic Hackathon Risk Score — Not for Clinical Use',
  /** Longer form for documentation surfaces and the verification report. */
  LONG:
    'All patient records in this application are randomly generated. The risk score is an ' +
    'invented formula built to demonstrate concurrent data-migration safety. It has no clinical ' +
    'meaning and must never be used for any medical purpose.',
} as const;

/** UI/transport limits (R13.5, R24.4). */
export const TRANSPORT = {
  /** Max events retained and rendered in the live timeline. */
  timelineWindow: 200,
  /** Coalesced progress frame rate, in milliseconds. */
  progressFrameIntervalMs: 100,
  /** Event log insert batching. */
  eventFlushIntervalMs: 100,
  eventFlushBatchSize: 50,
} as const;
