/**
 * Single source of truth for every enumerated value in BackfillGuard (R1.5).
 *
 * These are declared as `as const` objects plus derived union types rather than TypeScript `enum`s,
 * so they carry both a runtime value (usable for iteration, validation and zod schemas) and a
 * literal type, and they survive `isolatedModules` / type-stripping without special handling.
 *
 * Neither the backend nor the frontend may redeclare any of these.
 */

/** Lifecycle of a single patient record inside a backfill job (R2.4). */
export const BACKFILL_STATUS = {
  /** Never considered by any job. */
  PENDING: 'PENDING',
  /** Read and being computed. */
  PROCESSING: 'PROCESSING',
  /** Derived fields written from the current source version. */
  COMPLETED: 'COMPLETED',
  /** A conflict was detected and is not yet resolved. */
  CONFLICT: 'CONFLICT',
  /** Conflict resolved by re-reading and recomputing from current data. */
  REEVALUATED: 'REEVALUATED',
  /**
   * A stale write was blocked here. Transient: it must become REEVALUATED.
   * Surviving as a terminal status is a verification failure (check C6).
   */
  PROTECTED: 'PROTECTED',
  /** Considered, but no safe result could be applied after bounded retries. */
  FAILED: 'FAILED',
} as const;
export type BackfillStatus = (typeof BACKFILL_STATUS)[keyof typeof BACKFILL_STATUS];

/** Job state machine (design §6). Transitions are validated by one table in the backend. */
export const JOB_STATUS = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  CRASHED: 'CRASHED',
  RECOVERING: 'RECOVERING',
  COMPLETED: 'COMPLETED',
  VERIFYING: 'VERIFYING',
  VERIFIED_SAFE: 'VERIFIED_SAFE',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  FAILED: 'FAILED',
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/** Which engine produced a run. NAIVE is restricted to the comparison feature (R12.7). */
export const BACKFILL_MODE = {
  GUARDED: 'GUARDED',
  NAIVE: 'NAIVE',
} as const;
export type BackfillMode = (typeof BACKFILL_MODE)[keyof typeof BACKFILL_MODE];

/** Per-partition display state (R15.2). */
export const PARTITION_STATE = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  RECOVERING: 'RECOVERING',
  FAILED: 'FAILED',
} as const;
export type PartitionState = (typeof PARTITION_STATE)[keyof typeof PARTITION_STATE];

/**
 * Terminal decision recorded for every eligible record (R4.5). This is the coverage proof:
 * one row per record per job, so "every record was considered" is a set comparison rather
 * than a counter we have to trust.
 */
export const CONSIDERATION_OUTCOME = {
  /** Guarded write applied a freshly computed score. */
  APPLIED: 'APPLIED',
  /**
   * Revisited during recovery, found already derived from the current version, left untouched.
   * Counts as considered. This is the outcome that proves recovery does not blindly rewrite.
   */
  NO_ACTION_ALREADY_CURRENT: 'NO_ACTION_ALREADY_CURRENT',
  /** Conflicted, then re-read, recomputed and applied safely. */
  REEVALUATED_APPLIED: 'REEVALUATED_APPLIED',
  /** In scope but not eligible (reserved for future eligibility rules). */
  SKIPPED_NOT_ELIGIBLE: 'SKIPPED_NOT_ELIGIBLE',
  /** Considered but unresolvable after bounded retries. Never a silent skip. */
  FAILED: 'FAILED',
} as const;
export type ConsiderationOutcome =
  (typeof CONSIDERATION_OUTCOME)[keyof typeof CONSIDERATION_OUTCOME];

/** Who performed an online update (R6.1). */
export const ACTOR_TYPE = {
  DOCTOR: 'DOCTOR',
  NURSE: 'NURSE',
  LAB: 'LAB',
} as const;
export type ActorType = (typeof ACTOR_TYPE)[keyof typeof ACTOR_TYPE];

/** How an online update was triggered (R6.5–R6.7). */
export const UPDATE_SOURCE = {
  MANUAL: 'MANUAL',
  AUTO: 'AUTO',
  SCRIPTED: 'SCRIPTED',
} as const;
export type UpdateSource = (typeof UPDATE_SOURCE)[keyof typeof UPDATE_SOURCE];

/** Synthetic risk banding (R3.5). Not a clinical classification. */
export const RISK_LEVEL = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
} as const;
export type RiskLevel = (typeof RISK_LEVEL)[keyof typeof RISK_LEVEL];

/** Checkpoint availability (R7.3, R7.4). */
export const CHECKPOINT_STATUS = {
  ACTIVE: 'ACTIVE',
  SUPERSEDED: 'SUPERSEDED',
  /** Deliberately destroyed. Must never be readable as a resume cursor (R7.7). */
  LOST: 'LOST',
} as const;
export type CheckpointStatus = (typeof CHECKPOINT_STATUS)[keyof typeof CHECKPOINT_STATUS];

/**
 * State of a staged, computed-but-unwritten result (design §1 Idea 2).
 * These rows are the durable source of staleness that survives a crash.
 */
export const PENDING_RESULT_STATE = {
  PENDING: 'PENDING',
  REVALIDATED: 'REVALIDATED',
  REJECTED: 'REJECTED',
  FLUSHED: 'FLUSHED',
} as const;
export type PendingResultState =
  (typeof PENDING_RESULT_STATE)[keyof typeof PENDING_RESULT_STATE];

/** Conflict lifecycle (R10.4, R10.5). */
export const CONFLICT_RESOLUTION = {
  PENDING: 'PENDING',
  REEVALUATED: 'REEVALUATED',
  FAILED: 'FAILED',
} as const;
export type ConflictResolution =
  (typeof CONFLICT_RESOLUTION)[keyof typeof CONFLICT_RESOLUTION];

/** Synthetic diagnosis labels. Purely illustrative; they only feed the synthetic score. */
export const DIAGNOSIS = {
  NONE: 'NONE',
  ASTHMA: 'ASTHMA',
  OBESITY: 'OBESITY',
  POST_SURGICAL_RECOVERY: 'POST_SURGICAL_RECOVERY',
  HYPERTENSION: 'HYPERTENSION',
  CHRONIC_KIDNEY_DISEASE: 'CHRONIC_KIDNEY_DISEASE',
  DIABETES_TYPE_2: 'DIABETES_TYPE_2',
  CARDIAC_ARRHYTHMIA: 'CARDIAC_ARRHYTHMIA',
} as const;
export type Diagnosis = (typeof DIAGNOSIS)[keyof typeof DIAGNOSIS];

/**
 * The only fields an online update may change (R6.2).
 * Anything outside this list is rejected server-side. Derived fields (`riskScore`, `riskLevel`)
 * and version bookkeeping (`version`, `lastBackfillVersion`) are never client-writable (R22.5).
 */
export const CLINICAL_FIELD = {
  bloodPressureSystolic: 'bloodPressureSystolic',
  bloodPressureDiastolic: 'bloodPressureDiastolic',
  heartRate: 'heartRate',
  glucose: 'glucose',
  diagnosis: 'diagnosis',
} as const;
export type ClinicalField = (typeof CLINICAL_FIELD)[keyof typeof CLINICAL_FIELD];

export const CLINICAL_FIELDS: readonly ClinicalField[] = Object.values(CLINICAL_FIELD);

/** Event severity, drives visual treatment in the timeline (R24.2). */
export const EVENT_SEVERITY = {
  INFO: 'INFO',
  SUCCESS: 'SUCCESS',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
} as const;
export type EventSeverity = (typeof EVENT_SEVERITY)[keyof typeof EVENT_SEVERITY];

/**
 * Every event the system can emit (R13.1).
 *
 * The first block is the mandatory set from the requirements. The second block covers states the
 * mandatory list does not name but the requirements imply: resume (R8.2), recovery no-ops (R9.4),
 * per-record failures (R4.7), scenario step progress (R18.7) and dataset lifecycle (R2.8).
 */
export const EVENT_TYPE = {
  // --- mandatory set (R13.1) ---
  BACKFILL_STARTED: 'BACKFILL_STARTED',
  RECORD_READ: 'RECORD_READ',
  RISK_CALCULATED: 'RISK_CALCULATED',
  VERSION_VALIDATED: 'VERSION_VALIDATED',
  RECORD_UPDATED: 'RECORD_UPDATED',
  ONLINE_UPDATE: 'ONLINE_UPDATE',
  CONFLICT_DETECTED: 'CONFLICT_DETECTED',
  STALE_RESULT_REJECTED: 'STALE_RESULT_REJECTED',
  RE_EVALUATION_STARTED: 'RE_EVALUATION_STARTED',
  RE_EVALUATION_COMPLETED: 'RE_EVALUATION_COMPLETED',
  CHECKPOINT_CREATED: 'CHECKPOINT_CREATED',
  CHECKPOINT_LOST: 'CHECKPOINT_LOST',
  BACKFILL_PAUSED: 'BACKFILL_PAUSED',
  BACKFILL_CRASHED: 'BACKFILL_CRASHED',
  RECOVERY_STARTED: 'RECOVERY_STARTED',
  RECOVERY_COMPLETED: 'RECOVERY_COMPLETED',
  BACKFILL_COMPLETED: 'BACKFILL_COMPLETED',
  VERIFICATION_STARTED: 'VERIFICATION_STARTED',
  VERIFICATION_PASSED: 'VERIFICATION_PASSED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',

  // --- implied by other requirements ---
  BACKFILL_RESUMED: 'BACKFILL_RESUMED',
  /** Recovery revisited a record and correctly left it alone. */
  RECORD_NO_ACTION: 'RECORD_NO_ACTION',
  RECORD_FAILED: 'RECORD_FAILED',
  SCENARIO_STARTED: 'SCENARIO_STARTED',
  SCENARIO_STEP: 'SCENARIO_STEP',
  SCENARIO_COMPLETED: 'SCENARIO_COMPLETED',
  SCENARIO_ABORTED: 'SCENARIO_ABORTED',
  DATASET_SEEDED: 'DATASET_SEEDED',
  SIMULATION_RESET: 'SIMULATION_RESET',

  /**
   * --- risk notifications ---
   *
   * Added to the existing event vocabulary rather than given their own channel, so notifications appear in the
   * same timeline as the conflict that caused them. That interleaving is the point: a viewer should be able to
   * read "stale result rejected → re-evaluated → notification sent" as one sequence.
   */
  NOTIFICATION_QUEUED: 'NOTIFICATION_QUEUED',
  NOTIFICATION_SENT: 'NOTIFICATION_SENT',
  NOTIFICATION_CANCELLED: 'NOTIFICATION_CANCELLED',
  NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',
} as const;
export type EventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

/**
 * Events that must always reach the client uncoalesced and undropped (R13.6).
 *
 * Everything not listed here is high-volume per-record telemetry: still persisted to the event log,
 * but folded into throttled progress frames for transport (R13.5). Keeping this list in `shared`
 * means the server's broadcast policy and the client's expectations cannot drift apart.
 */
export const SIGNIFICANT_EVENT_TYPES: readonly EventType[] = [
  EVENT_TYPE.BACKFILL_STARTED,
  EVENT_TYPE.ONLINE_UPDATE,
  EVENT_TYPE.CONFLICT_DETECTED,
  EVENT_TYPE.STALE_RESULT_REJECTED,
  EVENT_TYPE.RE_EVALUATION_STARTED,
  EVENT_TYPE.RE_EVALUATION_COMPLETED,
  EVENT_TYPE.CHECKPOINT_CREATED,
  EVENT_TYPE.CHECKPOINT_LOST,
  EVENT_TYPE.BACKFILL_PAUSED,
  EVENT_TYPE.BACKFILL_RESUMED,
  EVENT_TYPE.BACKFILL_CRASHED,
  EVENT_TYPE.RECOVERY_STARTED,
  EVENT_TYPE.RECOVERY_COMPLETED,
  EVENT_TYPE.BACKFILL_COMPLETED,
  EVENT_TYPE.RECORD_FAILED,
  EVENT_TYPE.VERIFICATION_STARTED,
  EVENT_TYPE.VERIFICATION_PASSED,
  EVENT_TYPE.VERIFICATION_FAILED,
  EVENT_TYPE.SCENARIO_STARTED,
  EVENT_TYPE.SCENARIO_STEP,
  EVENT_TYPE.SCENARIO_COMPLETED,
  EVENT_TYPE.SCENARIO_ABORTED,
  EVENT_TYPE.DATASET_SEEDED,
  EVENT_TYPE.SIMULATION_RESET,
  /**
   * Notification events are narrative, not telemetry.
   *
   * `NOTIFICATION_QUEUED` is the one judgement call here: it fires once per staged HIGH result, so on a
   * contended run it is more frequent than the others. It stays significant anyway, because a queued alert
   * that is later cancelled is exactly the pair a viewer needs to see uncoalesced — the cancellation only
   * means anything if you witnessed the queueing.
   */
  EVENT_TYPE.NOTIFICATION_QUEUED,
  EVENT_TYPE.NOTIFICATION_SENT,
  EVENT_TYPE.NOTIFICATION_CANCELLED,
  EVENT_TYPE.NOTIFICATION_FAILED,
];

export function isSignificantEvent(type: EventType): boolean {
  return SIGNIFICANT_EVENT_TYPES.includes(type);
}

/** Machine-readable API error codes (R23.1). */
export const ERROR_CODE = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PATIENT_NOT_FOUND: 'PATIENT_NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  CONCURRENT_UPDATE: 'CONCURRENT_UPDATE',
  INVALID_JOB_STATE: 'INVALID_JOB_STATE',
  CHECKPOINT_MISSING: 'CHECKPOINT_MISSING',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
  SCENARIO_FAILED: 'SCENARIO_FAILED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** Outcome of the independent audit (R11.10). */
export const VERIFICATION_VERDICT = {
  VERIFIED_SAFE: 'VERIFIED_SAFE',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
} as const;
export type VerificationVerdict =
  (typeof VERIFICATION_VERDICT)[keyof typeof VERIFICATION_VERDICT];

/** Identifiers of the six independent verification checks (design §10). */
export const VERIFICATION_CHECK = {
  C1_COVERAGE: 'C1_COVERAGE',
  C2_NO_STALE_OVERWRITE: 'C2_NO_STALE_OVERWRITE',
  C3_NO_LOST_ONLINE_UPDATE: 'C3_NO_LOST_ONLINE_UPDATE',
  C4_DERIVED_CONSISTENCY: 'C4_DERIVED_CONSISTENCY',
  C5_VALID_OUTPUTS: 'C5_VALID_OUTPUTS',
  C6_CONFLICTS_RESOLVED: 'C6_CONFLICTS_RESOLVED',
} as const;
export type VerificationCheckId =
  (typeof VERIFICATION_CHECK)[keyof typeof VERIFICATION_CHECK];
